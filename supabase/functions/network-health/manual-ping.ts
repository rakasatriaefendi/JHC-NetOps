export const MANUAL_PING_RESULT_TTL_MS = 2 * 60_000;

export type ManualPingResult =
  | { ok: true; latency_ms: number }
  | { ok: false; category: "timeout" | "unreachable" };

export function validManualPingResult(value: unknown): value is ManualPingResult {
  if (!record(value) || Object.keys(value).some((key) => !["ok", "latency_ms", "category"].includes(key))) {
    return false;
  }
  if (value.ok === true) {
    return Object.keys(value).length === 2 && finiteNumber(value.latency_ms, 0, 60_000);
  }
  return value.ok === false && Object.keys(value).length === 2 &&
    (value.category === "timeout" || value.category === "unreachable");
}

export function validManualPingFailureCode(value: unknown): value is string {
  return value === "MANUAL_PING_FAILED" || value === "MANUAL_PING_TARGET_UNAVAILABLE";
}

function finiteNumber(value: unknown, min: number, max: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
