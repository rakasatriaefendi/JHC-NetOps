import { normalizeObservedHosts, type ObservedHostInput } from "./observed-hosts.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const DEVICE_STATUS = new Set(["connected", "partial", "auth_failed", "timeout", "unreachable", "unsupported", "poll_failed", "not_configured"]);
const ERROR_CATEGORY = new Set(["auth_failure", "timeout", "unreachable", "unsupported", "agent_error"]);
const ADMIN_STATUS = new Set(["up", "down", "testing"]);
const OPER_STATUS = new Set(["up", "down", "testing", "unknown"]);
const SEVERITY = new Set(["low", "medium", "high", "critical"]);
const EVENT_KINDS = new Set(["interface_down", "interface_up", "speed_changed", "errors_threshold", "discards_threshold", "utilization_high", "utilization_recovered"]);
const OBSERVED_HOSTS_STATUS = new Set(["available", "empty", "partial", "unsupported"]);
const SECRET_KEY = /"(?:password|passwd|secret|community|auth_password|priv_password|snmp2c_community_encrypted|credential)\s*"/i;
const TOP_KEYS = new Set(["action", "runner_id", "device", "interfaces", "transitions", "observed_hosts"]);
const DEVICE_KEYS = new Set(["target_id", "status", "sys_name", "sys_descr", "sys_object_id", "uptime_seconds", "manufacturer", "model", "serial_number", "last_polled_at", "last_success_at", "consecutive_poll_failures", "error_category", "error", "observed_hosts_status"]);
const INTERFACE_KEYS = new Set(["target_id", "if_index", "name", "description", "if_type", "is_physical", "admin_status", "oper_status", "speed_bps", "rx_rate_bps", "tx_rate_bps", "rx_util_percent", "tx_util_percent", "rx_errors_cumulative", "tx_errors_cumulative", "in_discards_cumulative", "out_discards_cumulative", "rx_errors_delta", "tx_errors_delta", "in_discards_delta", "out_discards_delta", "last_polled_at"]);
const TRANSITION_KEYS = new Set(["event_id", "target_id", "kind", "severity", "title", "description", "occurred_at", "raw_context"]);

export type ManagedTelemetryListRequest = { action: "list_targets"; runner_id: string };
export type ManagedDevice = Record<string, unknown> & { target_id: string; status: string };
export type ManagedInterface = Record<string, unknown> & { target_id: string; if_index: number; is_physical: boolean };
export type ManagedTransition = Record<string, unknown> & { event_id: string; target_id: string; kind: string; occurred_at: string };
export type ManagedTelemetryPublishRequest = {
  action: "publish";
  runner_id: string;
  device: ManagedDevice;
  interfaces: ManagedInterface[];
  transitions: ManagedTransition[];
  observed_hosts: ObservedHostInput[];
};
export type ManagedTelemetryRequest = ManagedTelemetryListRequest | ManagedTelemetryPublishRequest;

export function validateManagedTelemetryRequest(value: unknown, nowMs = Date.now()):
  { ok: true; value: ManagedTelemetryRequest } | { ok: false; message: string } {
  if (!record(value) || typeof value.action !== "string" || !IDENTIFIER.test(String(value.runner_id ?? ""))) return invalid("Structured runner action required");
  if (value.action === "list_targets") {
    if (!onlyKeys(value, new Set(["action", "runner_id"]))) return invalid("Managed telemetry list payload is invalid");
    return { ok: true, value: { action: "list_targets", runner_id: value.runner_id as string } };
  }
  if (value.action !== "publish" || !onlyKeys(value, TOP_KEYS)) return invalid("Unsupported managed telemetry action");
  const device = record(value.device) ? value.device : null;
  if (!device || !validDevice(device, nowMs)) return invalid("Managed telemetry device payload is invalid");
  const interfaces = Array.isArray(value.interfaces) ? value.interfaces : [];
  if (interfaces.length > 200 || !interfaces.every((item) => validInterface(item, nowMs))) return invalid("Managed telemetry interface payload is invalid");
  const transitions = Array.isArray(value.transitions) ? value.transitions : [];
  if (transitions.length > 100 || !transitions.every((item) => validTransition(item, nowMs))) return invalid("Managed telemetry event payload is invalid");
  const observedHosts = normalizeObservedHosts(value.observed_hosts ?? [], String(device.target_id));
  if (!observedHosts) return invalid("Managed telemetry observed host payload is invalid");
  const targetId = device.target_id as string;
  if (!interfaces.every((item) => (item as Record<string, unknown>).target_id === targetId)) return invalid("Managed telemetry interface target mismatch");
  if (!transitions.every((item) => (item as Record<string, unknown>).target_id === targetId)) return invalid("Managed telemetry event target mismatch");
  const encoded = JSON.stringify({ device, interfaces, transitions, observed_hosts: observedHosts });
  if (Buffer.byteLength(encoded, "utf8") > 128 * 1024 || SECRET_KEY.test(encoded)) return invalid("Managed telemetry payload is invalid");
  return { ok: true, value: { action: "publish", runner_id: value.runner_id as string, device: device as ManagedDevice, interfaces: interfaces as ManagedInterface[], transitions: transitions as ManagedTransition[], observed_hosts: observedHosts } };
}

function validDevice(value: Record<string, unknown>, nowMs: number): boolean {
  if (!onlyKeys(value, DEVICE_KEYS) || !uuid(value.target_id) || !DEVICE_STATUS.has(String(value.status))) return false;
  if (!OBSERVED_HOSTS_STATUS.has(String(value.observed_hosts_status ?? "unsupported"))) return false;
  if (!nullableDate(value.last_polled_at, nowMs) || !nullableDate(value.last_success_at, nowMs) || !nullableInteger(value.consecutive_poll_failures, 0, 1_000_000)) return false;
  if (value.error_category != null && !ERROR_CATEGORY.has(String(value.error_category))) return false;
  if (!nullableInteger(value.uptime_seconds, 0, Number.MAX_SAFE_INTEGER)) return false;
  return ["sys_name", "sys_descr", "sys_object_id", "manufacturer", "model", "serial_number", "error"].every((field) => nullableText(value[field], 512));
}

function validInterface(value: unknown, nowMs: number): boolean {
  if (!record(value) || !onlyKeys(value, INTERFACE_KEYS) || !uuid(value.target_id) || !integer(value.if_index, 0, 2_147_483_647) || typeof value.is_physical !== "boolean") return false;
  if (value.admin_status != null && !ADMIN_STATUS.has(String(value.admin_status))) return false;
  if (value.oper_status != null && !OPER_STATUS.has(String(value.oper_status))) return false;
  if (!nullableInteger(value.if_type, 0, 2_147_483_647) || !nullableInteger(value.speed_bps, 0, Number.MAX_SAFE_INTEGER)) return false;
  if (!["rx_rate_bps", "tx_rate_bps"].every((field) => nullableNumber(value[field], 0, Number.MAX_SAFE_INTEGER))) return false;
  if (!["rx_util_percent", "tx_util_percent"].every((field) => nullableNumber(value[field], 0, 100))) return false;
  if (!["rx_errors_cumulative", "tx_errors_cumulative", "in_discards_cumulative", "out_discards_cumulative"].every((field) => nullableInteger(value[field], 0, Number.MAX_SAFE_INTEGER))) return false;
  if (!["rx_errors_delta", "tx_errors_delta", "in_discards_delta", "out_discards_delta"].every((field) => nullableInteger(value[field], 0, 2 ** 31))) return false;
  return dateString(value.last_polled_at, nowMs) && ["name", "description"].every((field) => nullableText(value[field], 128));
}

function validTransition(value: unknown, nowMs: number): boolean {
  if (!record(value) || !onlyKeys(value, TRANSITION_KEYS) || !uuid(value.event_id) || !uuid(value.target_id)) return false;
  if (!EVENT_KINDS.has(String(value.kind)) || !SEVERITY.has(String(value.severity))) return false;
  if (typeof value.title !== "string" || value.title.length > 200 || !nullableText(value.description, 500)) return false;
  return dateString(value.occurred_at, nowMs) && (value.raw_context === undefined || record(value.raw_context));
}

function invalid(message: string) { return { ok: false as const, message }; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function onlyKeys(value: Record<string, unknown>, allowed: Set<string>) { return Object.keys(value).every((key) => allowed.has(key)); }
function uuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
function integer(value: unknown, min: number, max: number) { return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max; }
function nullableInteger(value: unknown, min: number, max: number) { return value == null || integer(value, min, max); }
function nullableNumber(value: unknown, min: number, max: number) { return value == null || (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max); }
function nullableText(value: unknown, max: number) { return value == null || (typeof value === "string" && value.length <= max); }
function dateString(value: unknown, nowMs: number): value is string { return typeof value === "string" && !Number.isNaN(Date.parse(value)) && Date.parse(value) <= nowMs + 60_000; }
function nullableDate(value: unknown, nowMs: number) { return value == null || dateString(value, nowMs); }
