import type { PostgresQuery, PostgresTransactionalQuery } from "./postgres-query.js";
import { ProfilePersistenceError } from "./profiles.js";
import { UUID } from "./control-plane.js";

export type BrandingSummary = Readonly<{
  institution_name: string; division_name: string; logo_available: boolean;
  logo_mime_type: "image/png" | "image/jpeg" | null;
}>;
export type BrandingAuditAction = "branding_identity_updated" | "branding_logo_updated" | "branding_logo_removed";
export type AdministrativeAuditEntry = Readonly<{
  id: string; source: "account" | "administrative"; actor_id: string | null;
  actor_name: string | null; target_name: string | null; resource_type: "profile" | "report_branding";
  resource_key: string; action: string; before_state: Record<string, unknown>;
  after_state: Record<string, unknown>; occurred_at: string;
}>;

/** All callers use the trusted frontend token plus an explicit actor, rechecked here. */
export class PostgresAdministrativeAuditRepository {
  constructor(private readonly database: PostgresTransactionalQuery) {}

  async withAdmin<T>(actorId: string, signal: AbortSignal,
    operation: (query: PostgresQuery) => Promise<T>): Promise<T> {
    if (!UUID.test(actorId)) throw new ProfilePersistenceError("INVALID_PROFILE");
    return this.database.transaction(signal, async (query) => {
      const actor = await query.rows(`SELECT p.id FROM public.profiles p
        JOIN public.local_auth_credentials c ON c.user_id=p.id
        WHERE p.id=$1::uuid AND p.role='admin' AND p.status='approved' FOR SHARE OF p,c`, [actorId], signal);
      if (actor.length !== 1) throw new ProfilePersistenceError("ADMIN_ACCESS_REQUIRED");
      return operation(query);
    });
  }

  async append(query: PostgresQuery, actorId: string, action: BrandingAuditAction,
    before: BrandingSummary, after: BrandingSummary, signal: AbortSignal): Promise<void> {
    // Reconstruct exact fields; never serialize caller objects or a request payload.
    await query.rows(`INSERT INTO public.administrative_audit
      (actor_id,resource_type,resource_key,action,before_state,after_state)
      VALUES ($1::uuid,'report_branding','institution',$2,$3::jsonb,$4::jsonb)`,
    [actorId, action, JSON.stringify(summary(before)), JSON.stringify(summary(after))], signal);
  }

  async list(actorId: string, offset: number, signal: AbortSignal): Promise<AdministrativeAuditEntry[]> {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10_000) throw new ProfilePersistenceError("INVALID_PROFILE");
    return this.withAdmin(actorId, signal, async (query) => {
      const rows = await query.rows(`SELECT e.*,a.full_name AS actor_name,t.full_name AS target_name FROM (
        SELECT id::text,'account'::text AS source,actor_id,'profile'::text AS resource_type,
          target_id::text AS resource_key,action,
          jsonb_build_object('role',previous_role,'status',previous_status) AS before_state,
          jsonb_build_object('role',next_role,'status',next_status) AS after_state,occurred_at
        FROM public.account_lifecycle_audit
        UNION ALL
        SELECT id::text,'administrative',actor_id,resource_type,resource_key,action,before_state,after_state,occurred_at
        FROM public.administrative_audit
      ) e LEFT JOIN public.profiles a ON a.id=e.actor_id
        LEFT JOIN public.profiles t ON e.resource_type='profile' AND t.id::text=e.resource_key
        ORDER BY e.occurred_at DESC,e.source ASC,e.id::bigint DESC LIMIT 51 OFFSET $1`, [offset], signal);
      return rows.map((row) => ({
        id: String(row.id), source: row.source as AdministrativeAuditEntry["source"],
        actor_id: typeof row.actor_id === "string" ? row.actor_id : null,
        actor_name: typeof row.actor_name === "string" ? row.actor_name : null,
        target_name: typeof row.target_name === "string" ? row.target_name : null,
        resource_type: row.resource_type as AdministrativeAuditEntry["resource_type"],
        resource_key: String(row.resource_key), action: String(row.action),
        before_state: row.before_state as Record<string, unknown>, after_state: row.after_state as Record<string, unknown>,
        occurred_at: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : String(row.occurred_at),
      }));
    });
  }
}

// Assignment/header shapes only, not ordinary branding vocabulary. Each field
// is length-bounded before matching; do not concatenate separate display names.
const SECRET_SHAPED_BRANDING = /(?:^|[^a-z0-9_])(?:bearer[ \t]+\S+|(?:password|passwd|auth_password|priv_password|community|authorization|session_token|access_token|refresh_token|api_key|apikey|client_secret|private_key|database_url|service_role|secret)["']?[ \t]*[:=])/i;

function summary(value: BrandingSummary): BrandingSummary {
  if (!value.institution_name.trim() || value.institution_name.length > 160 || value.division_name.length > 160 ||
    /[\x00-\x1f\x7f]/.test(value.institution_name + value.division_name) ||
    SECRET_SHAPED_BRANDING.test(value.institution_name) || SECRET_SHAPED_BRANDING.test(value.division_name) ||
    typeof value.logo_available !== "boolean" ||
    ![null, "image/png", "image/jpeg"].includes(value.logo_mime_type)) throw new ProfilePersistenceError("INVALID_PROFILE");
  return { institution_name: value.institution_name, division_name: value.division_name,
    logo_available: value.logo_available, logo_mime_type: value.logo_mime_type };
}
