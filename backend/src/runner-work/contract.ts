export const WORK_KINDS = ["manual_ping", "traffic", "discovery", "device_inspector"] as const;
export type WorkKind = typeof WORK_KINDS[number];
export const WORK_WAIT_MS = 10_000;
export const WORK_QUERY_TIMEOUT_MS = 3_000;
export const WORK_MAINTENANCE_MS = 10_000;

export function workRunner(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  return Object.keys(value).length === 1 && typeof value.runner_id === "string" &&
    /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value.runner_id) ? value.runner_id : null;
}
