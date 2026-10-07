import type { PostgresQuery, PostgresTransactionalQuery } from "./postgres-query.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLES = new Set(["admin", "operator", "viewer"]);
const ACCESS = new Map([["pending", "pending"], ["active", "approved"], ["suspended", "rejected"]]);
const STATUSES = new Set(["pending", "approved", "rejected", "disabled"]);

export type LocalProfile = Readonly<{
  id: string;
  email: string;
  full_name: string | null;
  role: "admin" | "operator" | "viewer";
  status: "pending" | "approved" | "rejected" | "disabled";
  created_at: string;
  approved_at: string | null;
  approved_by: string | null;
  disabled_at: string | null;
  disabled_by: string | null;
}>;

export class ProfilePersistenceError extends Error {
  constructor(readonly code: "INVALID_PROFILE" | "ADMIN_ACCESS_REQUIRED" | "PROFILE_ACCESS_REQUIRED" | "PROFILE_NOT_FOUND" |
    "SELF_DEMOTION_BLOCKED" | "LAST_ADMIN_BLOCKED" | "SELF_DELETE_BLOCKED" | "SELF_DISABLE_BLOCKED" |
    "LAST_LOGIN_CAPABLE_ADMIN_BLOCKED" | "ACCOUNT_HAS_HISTORY" | "ACCOUNT_NOT_DISABLEABLE" |
    "ACCOUNT_NOT_REENABLEABLE" | "ACCOUNT_NOT_DELETABLE") {
    super("Profile persistence request failed");
    this.name = "ProfilePersistenceError";
  }
}

export class PostgresProfilesRepository {
  constructor(private readonly database: PostgresTransactionalQuery) {}

  /** Identity comes only from the authenticated Next server, never an editable target field. */
  async setOwnName(userId: string, fullName: string, signal: AbortSignal): Promise<{ profile: LocalProfile; changed: boolean }> {
    const name = fullName.trim();
    if (!UUID.test(userId) || !name || name.length > 200 || /[\p{Cc}<>]/u.test(fullName)) {
      throw new ProfilePersistenceError("INVALID_PROFILE");
    }
    return this.database.transaction(signal, async (query) => {
      const current = await findProfile(query, userId, signal);
      if (!current) throw new ProfilePersistenceError("PROFILE_NOT_FOUND");
      if (current.status !== "approved") throw new ProfilePersistenceError("PROFILE_ACCESS_REQUIRED");
      if (current.full_name === name) return { profile: current, changed: false };
      const rows = await query.rows(`UPDATE public.profiles SET full_name=$2
        WHERE id=$1::uuid AND status='approved'
        RETURNING id,email,full_name,role,status,created_at,approved_at,approved_by,disabled_at,disabled_by`,
      [userId, name], signal);
      const stored = profile(rows[0]);
      if (!stored || stored.full_name !== name) throw new ProfilePersistenceError("INVALID_PROFILE");
      return { profile: stored, changed: true };
    });
  }

  async getByAuthUserId(userId: string, signal: AbortSignal): Promise<LocalProfile | null> {
    if (!UUID.test(userId)) throw new ProfilePersistenceError("INVALID_PROFILE");
    const rows = await this.database.rows(`
      SELECT id,email,full_name,role,status,created_at,approved_at,approved_by,disabled_at,disabled_by
      FROM public.profiles WHERE id=$1::uuid
    `, [userId], signal);
    return profile(rows[0]);
  }

  async list(signal: AbortSignal): Promise<LocalProfile[]> {
    const rows = await this.database.rows(`
      SELECT id,email,full_name,role,status,created_at,approved_at,approved_by,disabled_at,disabled_by
      FROM public.profiles ORDER BY created_at DESC,id ASC LIMIT 5000
    `, [], signal);
    return rows.map(profile).filter((row): row is LocalProfile => row !== null);
  }

  /** Call only after a trusted frontend/server route has verified the Local Auth identity. */
  async bootstrapPending(authUserId: string, email: string, fullName: string | null, signal: AbortSignal): Promise<LocalProfile> {
    if (!UUID.test(authUserId) || email.length < 3 || email.length > 320 || /[\x00-\x1f\x7f]/.test(email) ||
      (fullName !== null && (fullName.length > 200 || /[\x00-\x1f\x7f]/.test(fullName)))) {
      throw new ProfilePersistenceError("INVALID_PROFILE");
    }
    const rows = await this.database.rows(`
      INSERT INTO public.profiles(id,email,full_name,role,status)
      VALUES ($1::uuid,$2,$3,'viewer','pending')
      ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email
      RETURNING id,email,full_name,role,status,created_at,approved_at,approved_by,disabled_at,disabled_by
    `, [authUserId, email, fullName], signal);
    const stored = profile(rows[0]);
    if (!stored) throw new ProfilePersistenceError("INVALID_PROFILE");
    return stored;
  }

  async setAccess(
    actingAuthUserId: string,
    targetAuthUserId: string,
    role: string,
    accessStatus: string,
    signal: AbortSignal,
  ): Promise<string> {
    if (!UUID.test(actingAuthUserId) || !UUID.test(targetAuthUserId) || !ROLES.has(role) || !ACCESS.has(accessStatus)) {
      throw new ProfilePersistenceError("INVALID_PROFILE");
    }
    return this.database.transaction(signal, async (query) => {
      await authorizeLifecycle(query, actingAuthUserId, signal);
      const target = await findProfile(query, targetAuthUserId, signal);
      if (!target) throw new ProfilePersistenceError("PROFILE_NOT_FOUND");
      if (target.status === "disabled") throw new ProfilePersistenceError("ACCOUNT_NOT_REENABLEABLE");
      const nextStatus = ACCESS.get(accessStatus)!;
      if (actingAuthUserId.toLowerCase() === targetAuthUserId.toLowerCase() && (role !== "admin" || nextStatus !== "approved")) {
        throw new ProfilePersistenceError("SELF_DEMOTION_BLOCKED");
      }
      if (target.role === "admin" && target.status === "approved" &&
        (role !== "admin" || nextStatus !== "approved")) {
        await protectLoginCapableAdmin(query, targetAuthUserId, signal);
      }
      if (target.role === role && target.status === nextStatus) return targetAuthUserId;
      await query.rows(`
        UPDATE public.profiles SET role=$2,status=$3,
          approved_at=CASE
            WHEN $3='approved' AND status='approved' THEN approved_at
            WHEN $3='approved' THEN now() ELSE NULL END,
          approved_by=CASE
            WHEN $3='approved' AND status='approved' THEN approved_by
            WHEN $3='approved' THEN $4::uuid ELSE NULL END
        WHERE id=$1::uuid
      `, [targetAuthUserId, role, nextStatus, actingAuthUserId], signal);
      await audit(query, actingAuthUserId, target, "access_changed", role, nextStatus, signal);
      return targetAuthUserId;
    });
  }

  async disable(actorId: string, targetId: string, signal: AbortSignal): Promise<string> {
    validateIdentities(actorId, targetId);
    return this.database.transaction(signal, async (query) => {
      await authorizeLifecycle(query, actorId, signal);
      if (actorId.toLowerCase() === targetId.toLowerCase()) throw new ProfilePersistenceError("SELF_DISABLE_BLOCKED");
      const target = await findProfile(query, targetId, signal);
      if (!target) throw new ProfilePersistenceError("PROFILE_NOT_FOUND");
      if (target.status !== "approved") throw new ProfilePersistenceError("ACCOUNT_NOT_DISABLEABLE");
      if (target.role === "admin") await protectLoginCapableAdmin(query, targetId, signal);
      await query.rows(`UPDATE public.profiles SET status='disabled',disabled_at=now(),disabled_by=$2::uuid
        WHERE id=$1::uuid`, [targetId, actorId], signal);
      await query.rows("DELETE FROM public.local_auth_sessions WHERE user_id=$1::uuid", [targetId], signal);
      await audit(query, actorId, target, "account_disabled", target.role, "disabled", signal);
      return targetId;
    });
  }

  async reenable(actorId: string, targetId: string, signal: AbortSignal): Promise<string> {
    validateIdentities(actorId, targetId);
    return this.database.transaction(signal, async (query) => {
      await authorizeLifecycle(query, actorId, signal);
      const target = await findProfile(query, targetId, signal);
      if (!target) throw new ProfilePersistenceError("PROFILE_NOT_FOUND");
      if (target.status !== "disabled") throw new ProfilePersistenceError("ACCOUNT_NOT_REENABLEABLE");
      await query.rows(`UPDATE public.profiles SET status='approved',disabled_at=NULL,disabled_by=NULL
        WHERE id=$1::uuid`, [targetId], signal);
      await audit(query, actorId, target, "account_reenabled", target.role, "approved", signal);
      return targetId;
    });
  }

  async delete(actorId: string, targetId: string, signal: AbortSignal): Promise<string> {
    validateIdentities(actorId, targetId);
    return this.database.transaction(signal, async (query) => {
      await authorizeLifecycle(query, actorId, signal);
      if (actorId.toLowerCase() === targetId.toLowerCase()) throw new ProfilePersistenceError("SELF_DELETE_BLOCKED");
      const target = await findProfile(query, targetId, signal);
      if (!target) throw new ProfilePersistenceError("PROFILE_NOT_FOUND");
      if (target.status !== "pending") throw new ProfilePersistenceError("ACCOUNT_NOT_DELETABLE");
      const history = await query.rows(`SELECT (
        EXISTS (SELECT 1 FROM public.device_inspection_sessions WHERE requested_by=$1::uuid)
        OR EXISTS (SELECT 1 FROM public.network_discovery_sessions WHERE requested_by=$1::uuid)
        OR EXISTS (SELECT 1 FROM public.managed_telemetry_targets WHERE created_by=$1::uuid)
        OR EXISTS (SELECT 1 FROM public.network_nodes WHERE created_by=$1::uuid)
        OR EXISTS (SELECT 1 FROM public.network_targets WHERE created_by=$1::uuid)
        OR EXISTS (SELECT 1 FROM public.profiles WHERE approved_by=$1::uuid OR disabled_by=$1::uuid)
        OR EXISTS (SELECT 1 FROM public.diagnostic_jobs WHERE requested_by=$1::uuid)
        OR EXISTS (SELECT 1 FROM public.traffic_live_sessions WHERE requested_by=$1::uuid)
        OR EXISTS (SELECT 1 FROM public.network_health_ping_jobs WHERE requested_by=$1::uuid)
      ) AS has_history`, [targetId], signal);
      if (history[0]?.has_history !== false) throw new ProfilePersistenceError("ACCOUNT_HAS_HISTORY");
      await audit(query, actorId, target, "account_deleted", null, null, signal);
      await query.rows("DELETE FROM public.profiles WHERE id=$1::uuid", [targetId], signal);
      return targetId;
    });
  }
}

function validateIdentities(actorId: string, targetId: string): void {
  if (!UUID.test(actorId) || !UUID.test(targetId)) throw new ProfilePersistenceError("INVALID_PROFILE");
}

async function authorizeLifecycle(query: PostgresQuery, actorId: string, signal: AbortSignal): Promise<void> {
  // Serializes lifecycle decisions and counts; row locks also protect history checks.
  await query.rows("LOCK TABLE public.profiles IN SHARE ROW EXCLUSIVE MODE", [], signal);
  const actor = await findProfile(query, actorId, signal);
  if (!actor || actor.role !== "admin" || actor.status !== "approved") throw new ProfilePersistenceError("ADMIN_ACCESS_REQUIRED");
  const credentials = await query.rows("SELECT user_id FROM public.local_auth_credentials WHERE user_id=$1::uuid FOR SHARE", [actorId], signal);
  if (credentials.length !== 1) throw new ProfilePersistenceError("ADMIN_ACCESS_REQUIRED");
}

async function protectLoginCapableAdmin(query: PostgresQuery, targetId: string, signal: AbortSignal): Promise<void> {
  const counts = await query.rows(`SELECT count(*)::integer AS count FROM public.profiles p
    JOIN public.local_auth_credentials c ON c.user_id=p.id
    WHERE p.role='admin' AND p.status='approved' AND p.id<>$1::uuid`, [targetId], signal);
  const remaining = Number(counts[0]?.count);
  if (!Number.isInteger(remaining) || remaining < 1) throw new ProfilePersistenceError("LAST_LOGIN_CAPABLE_ADMIN_BLOCKED");
}

async function audit(query: PostgresQuery, actorId: string, target: LocalProfile,
  action: "access_changed" | "account_disabled" | "account_reenabled" | "account_deleted",
  nextRole: string | null, nextStatus: string | null, signal: AbortSignal): Promise<void> {
  await query.rows(`INSERT INTO public.account_lifecycle_audit
    (actor_id,target_id,action,previous_role,next_role,previous_status,next_status)
    VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7)`,
  [actorId, target.id, action, target.role, nextRole, target.status, nextStatus], signal);
}

async function findProfile(query: PostgresQuery, userId: string, signal: AbortSignal): Promise<LocalProfile | null> {
  const rows = await query.rows(`
    SELECT id,email,full_name,role,status,created_at,approved_at,approved_by,disabled_at,disabled_by
    FROM public.profiles WHERE id=$1::uuid FOR UPDATE
  `, [userId], signal);
  return profile(rows[0]);
}

function profile(value: Record<string, unknown> | undefined): LocalProfile | null {
  if (!value || typeof value.id !== "string" || typeof value.email !== "string" ||
    !ROLES.has(String(value.role)) || !STATUSES.has(String(value.status))) return null;
  return {
    id: value.id, email: value.email, full_name: typeof value.full_name === "string" ? value.full_name : null,
    role: value.role as LocalProfile["role"], status: value.status as LocalProfile["status"],
    created_at: iso(value.created_at), approved_at: value.approved_at ? iso(value.approved_at) : null,
    approved_by: typeof value.approved_by === "string" ? value.approved_by : null,
    disabled_at: value.disabled_at ? iso(value.disabled_at) : null,
    disabled_by: typeof value.disabled_by === "string" ? value.disabled_by : null,
  };
}

function iso(value: unknown): string { return value instanceof Date ? value.toISOString() : String(value); }
