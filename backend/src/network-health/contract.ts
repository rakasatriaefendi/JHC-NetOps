const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const STATUS = new Set(["online", "degraded", "offline"]);
const REQUEST_KEYS = new Set(["action", "runner_id", "states", "transitions", "ping_id", "result", "error_code"]);
const STATE_KEYS = new Set([
  "target_id", "status", "latency_ms", "packet_loss_percent", "last_checked_at",
  "last_success_at", "consecutive_failures", "sample_count",
]);
const TRANSITION_KEYS = new Set([
  "event_id", "target_id", "previous_status", "new_status", "occurred_at",
  "latency_ms", "packet_loss_percent", "consecutive_failures",
]);
const MANUAL_PING_ACTIONS = new Set(["claim_manual_ping", "complete_manual_ping", "fail_manual_ping"]);
const ERROR_CODE = /^[A-Z0-9_]{1,64}$/;

export type HealthState = Readonly<{
  target_id: string;
  status: string;
  latency_ms: number | null;
  packet_loss_percent: number;
  last_checked_at: string;
  last_success_at: string | null;
  consecutive_failures: number;
  sample_count: number;
}>;

export type HealthTransition = Readonly<{
  event_id: string;
  target_id: string;
  previous_status: string;
  new_status: string;
  occurred_at: string;
  latency_ms: number | null;
  packet_loss_percent: number;
  consecutive_failures: number;
}>;

export type NetworkHealthRequest =
  | Readonly<{ action: "list_targets"; runner_id: string }>
  | Readonly<{
    action: "publish";
    runner_id: string;
    states: HealthState[];
    transitions: HealthTransition[];
  }>
  | Readonly<{ action: "claim_manual_ping"; runner_id: string }>
  | Readonly<{ action: "complete_manual_ping"; runner_id: string; ping_id: string; result: Record<string, unknown> }>
  | Readonly<{ action: "fail_manual_ping"; runner_id: string; ping_id: string; error_code: string }>;

export function validateNetworkHealthRequest(value: unknown, nowMs = Date.now()):
  | Readonly<{ ok: true; value: NetworkHealthRequest }>
  | Readonly<{ ok: false; message: string }> {
  if (!record(value) || !onlyKeys(value, REQUEST_KEYS) || !identifier(value.runner_id)) return invalid();
  if (value.action === "list_targets") {
    return Object.keys(value).length === 2
      ? { ok: true, value: { action: "list_targets", runner_id: value.runner_id } }
      : invalid();
  }
  if (value.action === "publish") {
    if (!Array.isArray(value.states) || !Array.isArray(value.transitions) ||
        value.states.length > 50 || value.transitions.length > 100) return invalid();
    const states: HealthState[] = [];
    for (const item of value.states) {
      if (!record(item) || !onlyKeys(item, STATE_KEYS) || !uuid(item.target_id) || !STATUS.has(String(item.status)) ||
          !dateString(item.last_checked_at, nowMs) || !nullableNumber(item.latency_ms, 0, 60_000) ||
          !number(item.packet_loss_percent, 0, 100) || !nullableDate(item.last_success_at, nowMs) ||
          !integer(item.consecutive_failures, 0, 1_000_000) || !integer(item.sample_count, 0, 5)) return invalid();
      states.push(item as HealthState);
    }
    const transitions: HealthTransition[] = [];
    for (const item of value.transitions) {
      if (!record(item) || !onlyKeys(item, TRANSITION_KEYS) || !uuid(item.event_id) || !uuid(item.target_id) ||
          !STATUS.has(String(item.previous_status)) || !STATUS.has(String(item.new_status)) ||
          item.previous_status === item.new_status || !dateString(item.occurred_at, nowMs) ||
          !nullableNumber(item.latency_ms, 0, 60_000) || !number(item.packet_loss_percent, 0, 100) ||
          !integer(item.consecutive_failures, 0, 1_000_000)) return invalid();
      transitions.push(item as HealthTransition);
    }
    return { ok: true, value: { action: "publish", runner_id: value.runner_id, states, transitions } };
  }
  if (value.action === "claim_manual_ping") {
    return exactKeys(value, ["action", "runner_id"])
      ? { ok: true, value: { action: "claim_manual_ping", runner_id: value.runner_id } }
      : invalid();
  }
  const action = typeof value.action === "string" ? value.action : "";
  if (MANUAL_PING_ACTIONS.has(action)) {
    const manualValue = value as Record<string, unknown>;
    const pingId = typeof manualValue.ping_id === "string" ? manualValue.ping_id : "";
    if (!uuid(pingId)) return invalid();
    if (action === "complete_manual_ping") {
      if (!validManualPingResult(manualValue.result)) return invalid();
      const result = exactKeys(manualValue, ["action", "runner_id", "ping_id", "result"])
        ? { action: "complete_manual_ping", runner_id: value.runner_id, ping_id: pingId, result: manualValue.result as Record<string, unknown> } as const
        : null;
      return result ? { ok: true as const, value: result } : invalid();
    }
    const errorCode = typeof manualValue.error_code === "string" && ERROR_CODE.test(manualValue.error_code)
      ? manualValue.error_code
      : "MANUAL_PING_FAILED";
    const result = exactKeys(manualValue, ["action", "runner_id", "ping_id", "error_code"])
      ? { action: "fail_manual_ping", runner_id: value.runner_id, ping_id: pingId, error_code: errorCode } as const
      : null;
    return result ? { ok: true as const, value: result } : invalid();
  }
  return invalid();
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function onlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>) {
  return Object.keys(value).every((key) => allowed.has(key));
}
function uuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
function identifier(value: unknown): value is string { return typeof value === "string" && IDENTIFIER.test(value); }
function dateString(value: unknown, nowMs: number): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && Date.parse(value) <= nowMs + 60_000;
}
function nullableDate(value: unknown, nowMs: number): value is string | null {
  return value === null || dateString(value, nowMs);
}
function number(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}
function nullableNumber(value: unknown, min: number, max: number): value is number | null {
  return value === null || number(value, min, max);
}
function integer(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  return Object.keys(value).length === expected.length && Object.keys(value).every((key) => expected.includes(key));
}
function validManualPingResult(value: unknown): value is Record<string, unknown> {
  if (!record(value) || typeof value.ok !== "boolean") return false;
  if (value.ok) {
    return exactKeys(value, ["ok", "latency_ms"])
      && number(value.latency_ms, 0, 60_000);
  }
  return exactKeys(value, ["ok", "category"])
    && (value.category === "timeout" || value.category === "unreachable");
}
function invalid() { return { ok: false as const, message: "Network health payload is invalid" }; }
