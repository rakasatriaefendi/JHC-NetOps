export const WORK_KINDS = ["manual_ping", "traffic", "discovery", "device_inspector"] as const;
export type WorkKind = typeof WORK_KINDS[number];
export const WORK_WAIT_MS = 10_000;
// Opt-in only: deployed older runners still have a 20s HTTP deadline.
export const QUIET_WORK_WAIT_MS = 60_000;
export const WORK_QUERY_TIMEOUT_MS = 3_000;
export const WORK_MAINTENANCE_MS = 10_000;

export function workRunner(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  const keys = Object.keys(value);
  const validKeys = keys.length === 1 || (keys.length === 2 && value.wait_seconds === 60);
  return validKeys && keys.every((key) => key === "runner_id" || key === "wait_seconds") && typeof value.runner_id === "string" &&
    /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value.runner_id) ? value.runner_id : null;
}

export function requestedWorkWait(body: unknown): number {
  return body && typeof body === "object" && "wait_seconds" in body && body.wait_seconds === 60
    ? QUIET_WORK_WAIT_MS : WORK_WAIT_MS;
}
