const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const FLOW_KEY = /^[0-9a-f]{64}$/;
const SAFE_CODE = /^[A-Z0-9_]{1,64}$/;
const BASE_KEYS = new Set(["action", "runner_id", "session_id", "stage", "snapshot", "flows", "error_code", "error_message"]);
const FLOW_KEYS = new Set([
  "flow_key", "src_ip", "dst_ip", "src_port", "dst_port", "protocol", "service",
  "first_seen", "last_seen", "total_bytes", "packet_count", "bytes_delta", "packets_delta",
  "packets_per_second", "rate_mbps", "peak_rate_mbps", "rate_trend", "status",
]);
const SNAPSHOT_KEYS = new Set(["captured_at", "summary", "flows", "conversations", "top_talkers"]);
const SUMMARY_KEYS = new Set([
  "observed_tx_mbps", "observed_rx_mbps", "packets_observed", "packets_per_second",
  "active_flows", "dominant_protocol",
]);
const CONVERSATION_KEYS = new Set([
  "endpoint_a", "endpoint_b", "a_to_b_bytes", "b_to_a_bytes", "total_bytes", "rate_mbps",
  "active_flows", "first_seen", "last_seen", "protocol", "service",
]);
const TALKER_KEYS = new Set(["ip", "rate_mbps", "total_bytes", "active_flows"]);

export type TrafficFlow = Record<string, unknown> & Readonly<{
  flow_key: string;
  src_ip: string;
  dst_ip: string;
  src_port: number | null;
  dst_port: number | null;
  protocol: string;
  first_seen: string;
  last_seen: string;
  total_bytes: number;
  packet_count: number;
  peak_rate_mbps: number;
}>;

export type TrafficRequest =
  | Readonly<{ action: "claim_session"; runner_id: string }>
  | Readonly<{ action: "update_session"; runner_id: string; session_id: string; stage: "starting_wsl" | "capturing" }>
  | Readonly<{ action: "update_snapshot"; runner_id: string; session_id: string; snapshot: Record<string, unknown> }>
  | Readonly<{ action: "persist_flow_batch"; runner_id: string; session_id: string; flows: TrafficFlow[] }>
  | Readonly<{ action: "complete_session"; runner_id: string; session_id: string }>
  | Readonly<{ action: "fail_session"; runner_id: string; session_id: string; error_code: string; error_message: string }>;

export function validateTrafficRequest(value: unknown):
  | Readonly<{ ok: true; value: TrafficRequest }>
  | Readonly<{ ok: false; status: 400 | 413; message: string }> {
  if (!record(value) || !onlyKeys(value, BASE_KEYS) || !identifier(value.runner_id)) return invalid();
  if (value.action === "claim_session") {
    return Object.keys(value).length === 2
      ? { ok: true, value: { action: "claim_session", runner_id: value.runner_id } }
      : invalid();
  }
  if (!uuid(value.session_id)) return invalid();
  if (value.action === "update_session") {
    if ((value.stage !== "starting_wsl" && value.stage !== "capturing") || Object.keys(value).length !== 4) return invalid();
    return { ok: true, value: { action: value.action, runner_id: value.runner_id, session_id: value.session_id, stage: value.stage } };
  }
  if (value.action === "complete_session") {
    return Object.keys(value).length === 3
      ? { ok: true, value: { action: value.action, runner_id: value.runner_id, session_id: value.session_id } }
      : invalid();
  }
  if (value.action === "fail_session") {
    if (Object.keys(value).length !== 5) return invalid();
    return { ok: true, value: {
      action: value.action,
      runner_id: value.runner_id,
      session_id: value.session_id,
      error_code: safeCode(value.error_code),
      error_message: safeMessage(value.error_message),
    } };
  }
  if (value.action === "persist_flow_batch") {
    if (Object.keys(value).length !== 4 || !Array.isArray(value.flows) || value.flows.length < 1 ||
        value.flows.length > 100 || JSON.stringify(value).length > 131_072 || !value.flows.every(validFlow)) return invalid();
    return { ok: true, value: {
      action: value.action,
      runner_id: value.runner_id,
      session_id: value.session_id,
      flows: value.flows as TrafficFlow[],
    } };
  }
  if (value.action === "update_snapshot") {
    if (Object.keys(value).length !== 4 || !validSnapshot(value.snapshot)) return invalidSnapshot(value.snapshot);
    return { ok: true, value: {
      action: value.action,
      runner_id: value.runner_id,
      session_id: value.session_id,
      snapshot: value.snapshot,
    } };
  }
  return invalid();
}

function validSnapshot(value: unknown): value is Record<string, unknown> {
  if (!record(value) || !onlyKeys(value, SNAPSHOT_KEYS) || !dateString(value.captured_at) ||
      !record(value.summary) || !onlyKeys(value.summary, SUMMARY_KEYS) ||
      !Array.isArray(value.flows) || value.flows.length > 100 || !value.flows.every(validFlow) ||
      !Array.isArray(value.conversations) || value.conversations.length > 30 || !value.conversations.every(validConversation) ||
      !Array.isArray(value.top_talkers) || value.top_talkers.length > 10 || !value.top_talkers.every(validTalker)) return false;
  if (!nonNegative(value.summary.observed_tx_mbps) || !nonNegative(value.summary.observed_rx_mbps) ||
      !nonNegative(value.summary.packets_observed) || !nonNegative(value.summary.packets_per_second) ||
      !integer(value.summary.active_flows, 0, 100) ||
      !(value.summary.dominant_protocol === null || ["tcp", "udp", "icmp"].includes(String(value.summary.dominant_protocol)))) return false;
  return new TextEncoder().encode(JSON.stringify(value)).byteLength <= 65_536;
}

function validFlow(value: unknown): value is TrafficFlow {
  if (!record(value) || !onlyKeys(value, FLOW_KEYS) || typeof value.flow_key !== "string" || !FLOW_KEY.test(value.flow_key) ||
      !ip(value.src_ip) || !ip(value.dst_ip) || !["tcp", "udp", "icmp"].includes(String(value.protocol)) ||
      !port(value.src_port) || !port(value.dst_port) || (value.protocol === "icmp" && (value.src_port !== null || value.dst_port !== null)) ||
      !nonNegative(value.total_bytes) || !nonNegative(value.packet_count) || !nonNegative(value.peak_rate_mbps) ||
      !dateString(value.first_seen) || !dateString(value.last_seen)) return false;
  if (value.service !== undefined && value.service !== null && (typeof value.service !== "string" || value.service.length > 64)) return false;
  for (const field of ["bytes_delta", "packets_delta", "packets_per_second", "rate_mbps"] as const) {
    if (value[field] !== undefined && !nonNegative(value[field])) return false;
  }
  if (value.rate_trend !== undefined && !["increasing", "decreasing", "stable"].includes(String(value.rate_trend))) return false;
  return value.status === undefined || value.status === "active" || value.status === "idle";
}

function validConversation(value: unknown) {
  if (!record(value) || !onlyKeys(value, CONVERSATION_KEYS) || !ip(value.endpoint_a) || !ip(value.endpoint_b) ||
      !dateString(value.first_seen) || !dateString(value.last_seen) ||
      !["tcp", "udp", "icmp", "mixed"].includes(String(value.protocol))) return false;
  for (const field of ["a_to_b_bytes", "b_to_a_bytes", "total_bytes", "rate_mbps", "active_flows"] as const) {
    if (!nonNegative(value[field])) return false;
  }
  return value.service === null || (typeof value.service === "string" && value.service.length <= 64);
}

function validTalker(value: unknown) {
  return record(value) && onlyKeys(value, TALKER_KEYS) && ip(value.ip) &&
    nonNegative(value.rate_mbps) && nonNegative(value.total_bytes) && nonNegative(value.active_flows);
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function onlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>) { return Object.keys(value).every((key) => allowed.has(key)); }
function uuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
function identifier(value: unknown): value is string { return typeof value === "string" && IDENTIFIER.test(value); }
function dateString(value: unknown): value is string { return typeof value === "string" && !Number.isNaN(Date.parse(value)); }
function nonNegative(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function integer(value: unknown, min: number, max: number): value is number { return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max; }
function port(value: unknown) { return value === null || (Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65_535); }
function ip(value: unknown): value is string { return typeof value === "string" && value.length <= 45 && /^[0-9a-f:.]+$/i.test(value); }
function safeCode(value: unknown) { return typeof value === "string" && SAFE_CODE.test(value) ? value : "TRAFFIC_CAPTURE_FAILED"; }
function safeMessage(value: unknown) { return typeof value === "string" && value.length <= 300 && !/[\r\n]/.test(value) ? value : "Traffic capture failed"; }
function invalid() { return { ok: false as const, status: 400 as const, message: "Traffic payload is invalid" }; }
function invalidSnapshot(value: unknown) {
  const tooLarge = record(value) && new TextEncoder().encode(JSON.stringify(value)).byteLength > 65_536;
  return { ok: false as const, status: tooLarge ? 413 as const : 400 as const, message: tooLarge ? "Snapshot exceeds 64 KiB" : "Traffic snapshot is invalid" };
}
