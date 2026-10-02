import type { PostgresQuery, PostgresTransactionalQuery } from "./postgres-query.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLES = new Set(["admin", "operator", "viewer"]);
const ACCESS = new Map([["pending", "pending"], ["active", "approved"], ["suspended", "rejected"]]);

export type LocalProfile = Readonly<{
  id: string;
  email: string;
  full_name: string | null;
  role: "admin" | "operator" | "viewer";
  status: "pending" | "approved" | "rejected";
  created_at: string;
  approved_at: string | null;
  approved_by: string | null;
}>;

export class ProfilePersistenceError extends Error {
  constructor(readonly code: "INVALID_PROFILE" | "ADMIN_ACCESS_REQUIRED" | "PROFILE_NOT_FOUND" |
    "SELF_DEMOTION_BLOCKED" | "LAST_ADMIN_BLOCKED") {
    super("Profile persistence request failed");
    this.name = "ProfilePersistenceError";
  }
}

export class PostgresProfilesRepository {
  constructor(private readonly database: PostgresTransactionalQuery) {}

  async getByAuthUserId(userId: string, signal: AbortSignal): Promise<LocalProfile | null> {
    if (!UUID.test(userId)) throw new ProfilePersistenceError("INVALID_PROFILE");
    const rows = await this.database.rows(`
      SELECT id,email,full_name,role,status,created_at,approved_at,approved_by
      FROM public.profiles WHERE id=$1::uuid
    `, [userId], signal);
    return profile(rows[0]);
  }

  async list(signal: AbortSignal): Promise<LocalProfile[]> {
    const rows = await this.database.rows(`
      SELECT id,email,full_name,role,status,created_at,approved_at,approved_by
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
      RETURNING id,email,full_name,role,status,created_at,approved_at,approved_by
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
      await query.rows("LOCK TABLE public.profiles IN SHARE ROW EXCLUSIVE MODE", [], signal);
      const actor = await findProfile(query, actingAuthUserId, signal);
      if (actor?.role !== "admin" || actor.status !== "approved") throw new ProfilePersistenceError("ADMIN_ACCESS_REQUIRED");
      const target = await findProfile(query, targetAuthUserId, signal);
      if (!target) throw new ProfilePersistenceError("PROFILE_NOT_FOUND");
      const nextStatus = ACCESS.get(accessStatus)!;
      if (actingAuthUserId === targetAuthUserId && (role !== "admin" || nextStatus !== "approved")) {
        throw new ProfilePersistenceError("SELF_DEMOTION_BLOCKED");
      }
      if (target.role === "admin" && target.status === "approved" &&
        (role !== "admin" || nextStatus !== "approved")) {
        const admins = await query.rows(`
          SELECT count(*)::integer AS count FROM public.profiles
          WHERE role='admin' AND status='approved'
        `, [], signal);
        if (!admins[0] || !Number.isInteger(Number(admins[0].count)) || Number(admins[0].count) <= 1) {
          throw new ProfilePersistenceError("LAST_ADMIN_BLOCKED");
        }
      }
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
      return targetAuthUserId;
    });
  }
}

async function findProfile(query: PostgresQuery, userId: string, signal: AbortSignal): Promise<LocalProfile | null> {
  const rows = await query.rows(`
    SELECT id,email,full_name,role,status,created_at,approved_at,approved_by
    FROM public.profiles WHERE id=$1::uuid
  `, [userId], signal);
  return profile(rows[0]);
}

function profile(value: Record<string, unknown> | undefined): LocalProfile | null {
  if (!value || typeof value.id !== "string" || typeof value.email !== "string" ||
    !ROLES.has(String(value.role)) || ![...ACCESS.values()].includes(String(value.status))) return null;
  return {
    id: value.id, email: value.email, full_name: typeof value.full_name === "string" ? value.full_name : null,
    role: value.role as LocalProfile["role"], status: value.status as LocalProfile["status"],
    created_at: iso(value.created_at), approved_at: value.approved_at ? iso(value.approved_at) : null,
    approved_by: typeof value.approved_by === "string" ? value.approved_by : null,
  };
}

function iso(value: unknown): string { return value instanceof Date ? value.toISOString() : String(value); }
