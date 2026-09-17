import type { PostgresQuery } from "./postgres-query.js";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const RUNNER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
export const RUNNER_FRESHNESS_MS = 30_000;

export type ControlPlaneErrorCode =
  | "INVALID_CONTROL_PLANE_INPUT"
  | "RUNNER_NOT_FOUND"
  | "RUNNER_OFFLINE"
  | "OPERATION_NOT_AUTHORIZED"
  | "TARGET_NOT_AUTHORIZED"
  | "RUNNER_BUSY"
  | "OPERATION_NOT_READY"
  | "STORAGE_CRITICAL"
  | "ALREADY_ACTIVE";

export class ControlPlanePersistenceError extends Error {
  constructor(readonly code: ControlPlaneErrorCode) {
    super("Local control-plane request rejected");
    this.name = "ControlPlanePersistenceError";
  }
}

export type StoredRunner = Readonly<{
  id: string;
  last_seen_at: string | Date;
  health_status: unknown;
  capabilities: Record<string, unknown>;
  preflight: Record<string, unknown> | null;
}>;

export async function requireFreshRunner(
  query: PostgresQuery,
  runnerId: string,
  operation: string,
  signal: AbortSignal,
): Promise<StoredRunner> {
  if (!RUNNER_ID.test(runnerId)) throw new ControlPlanePersistenceError("INVALID_CONTROL_PLANE_INPUT");
  const rows = await query.rows(`
    SELECT id,last_seen_at,health_status,capabilities,preflight
    FROM public.diagnostic_runners WHERE id=$1
  `, [runnerId], signal);
  const row = rows[0];
  if (!row) throw new ControlPlanePersistenceError("RUNNER_NOT_FOUND");
  const seenAt = row.last_seen_at instanceof Date ? row.last_seen_at.getTime() : Date.parse(String(row.last_seen_at));
  if (row.health_status !== "online" || !Number.isFinite(seenAt) || Date.now() - seenAt > RUNNER_FRESHNESS_MS) {
    throw new ControlPlanePersistenceError("RUNNER_OFFLINE");
  }
  const capabilities = record(row.capabilities);
  const operations = capabilities && Array.isArray(capabilities.operations) ? capabilities.operations : [];
  if (!operations.includes(operation)) throw new ControlPlanePersistenceError("OPERATION_NOT_AUTHORIZED");
  return {
    id: String(row.id),
    last_seen_at: row.last_seen_at as string | Date,
    health_status: row.health_status,
    capabilities: capabilities ?? {},
    preflight: record(row.preflight),
  };
}

export async function requireOperator(query: PostgresQuery, actorId: string, signal: AbortSignal): Promise<void> {
  if (!UUID.test(actorId)) throw new ControlPlanePersistenceError("INVALID_CONTROL_PLANE_INPUT");
  const rows = await query.rows("SELECT role,status FROM public.profiles WHERE id=$1::uuid", [actorId], signal);
  if (rows[0]?.status !== "approved" || !["admin", "operator"].includes(String(rows[0]?.role))) {
    throw new ControlPlanePersistenceError("OPERATION_NOT_AUTHORIZED");
  }
}

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function privateIpv4(value: string): boolean {
  const match = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((part) => part < 0 || part > 255)) return false;
  const [first, second] = octets;
  return first === 10 || (first === 172 && second! >= 16 && second! <= 31) || (first === 192 && second === 168);
}
