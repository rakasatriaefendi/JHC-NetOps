import { createClient } from "@supabase/supabase-js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVICE_STATUS = new Set(["connected", "partial", "auth_failed", "timeout", "unreachable", "unsupported", "poll_failed", "not_configured"]);
const ERROR_CATEGORY = new Set(["auth_failure", "timeout", "unreachable", "unsupported", "agent_error"]);
const ADMIN_STATUS = new Set(["up", "down", "testing"]);
const OPER_STATUS = new Set(["up", "down", "testing", "unknown"]);
const SEVERITY = new Set(["low", "medium", "high", "critical"]);
const EVENT_KINDS = new Set(["interface_down", "interface_up", "speed_changed", "errors_threshold", "discards_threshold", "utilization_high", "utilization_recovered"]);
const RECOVERY_KINDS = new Set(["interface_up", "utilization_recovered"]);
const SECRET_KEY = /"(?:password|passwd|secret|community|auth_password|priv_password|snmp2c_community_encrypted|credential)\s*"/i;

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  const service = serviceClient(request);
  if (!service.ok) return service.response;
  let body: Record<string, unknown>;
  try { body = await request.json(); }
  catch { return reply({ error: "Invalid JSON" }, 400); }
  if (!record(body) || !identifier(body.runner_id)) return reply({ error: "Structured runner action required" }, 400);
  if (body.action === "list_targets") return listTargets(service.client, body.runner_id);
  if (body.action === "publish") return publish(service.client, body);
  return reply({ error: "Unsupported action" }, 400);
});

async function listTargets(db: ReturnType<typeof createClient>, runnerId: string) {
  const { data, error } = await db.from("managed_telemetry_targets")
    .select("id,node_id,runner_id,enabled,credential_profile_ref,snmp_version,snmp_port,poll_interval_seconds,oper_error_threshold,discard_threshold,util_warning_percent,util_critical_percent,util_sustained_seconds,updated_at,network_nodes!inner(ip_address,name,device_type,location),managed_device_latest(status,last_polled_at)")
    .eq("runner_id", runnerId).eq("enabled", true).order("created_at");
  if (error) return reply({ error: "Managed telemetry targets could not be loaded" }, 500);
  const targets = (data ?? []).map((row: Record<string, unknown>) => {
    const node = relation(row.network_nodes);
    const latest = relation(row.managed_device_latest);
    return {
      id: row.id, node_id: row.node_id, runner_id: row.runner_id, enabled: row.enabled,
      credential_profile_ref: row.credential_profile_ref, snmp_version: row.snmp_version,
      snmp_port: row.snmp_port, poll_interval_seconds: row.poll_interval_seconds,
      oper_error_threshold: row.oper_error_threshold, discard_threshold: row.discard_threshold,
      util_warning_percent: Number(row.util_warning_percent), util_critical_percent: Number(row.util_critical_percent),
      util_sustained_seconds: row.util_sustained_seconds, config_updated_at: row.updated_at,
      ip_address: node?.ip_address, name: node?.name, device_type: node?.device_type, location: node?.location,
      latest: latest ?? null,
    };
  });
  return reply({ data: { targets } }, 200);
}

async function publish(db: ReturnType<typeof createClient>, body: Record<string, unknown>) {
  const device = record(body.device) ? body.device : null;
  const interfaces = Array.isArray(body.interfaces) ? body.interfaces : [];
  const transitions = Array.isArray(body.transitions) ? body.transitions : [];
  if (!device || !validDevice(device)) return reply({ error: "Managed telemetry device payload is invalid" }, 400);
  if (interfaces.length > 200 || !interfaces.every(validInterface)) return reply({ error: "Managed telemetry interface payload is invalid" }, 400);
  if (transitions.length > 100 || !transitions.every(validTransition)) return reply({ error: "Managed telemetry event payload is invalid" }, 400);
  const targetId = device.target_id as string;
  if (!uuid(targetId)) return reply({ error: "Managed telemetry device payload is invalid" }, 400);
  if (!interfaces.every((item) => (item as Record<string, unknown>).target_id === targetId)) return reply({ error: "Managed telemetry interface target mismatch" }, 400);
  if (!transitions.every((item) => (item as Record<string, unknown>).target_id === targetId)) return reply({ error: "Managed telemetry event target mismatch" }, 400);
  const encoded = JSON.stringify({ device, interfaces, transitions });
  if (new TextEncoder().encode(encoded).byteLength > 64 * 1024 || SECRET_KEY.test(encoded)) return reply({ error: "Managed telemetry payload is invalid" }, 400);

  const { data: allowed, error: targetError } = await db.from("managed_telemetry_targets")
    .select("id").eq("runner_id", body.runner_id).eq("enabled", true).eq("id", targetId);
  if (targetError) return reply({ error: "Managed telemetry target authorization failed" }, 500);
  if (!(allowed ?? []).length) return reply({ error: "Managed telemetry target is not authorized" }, 403);

  const now = new Date().toISOString();
  const deviceRow = {
    target_id: targetId, status: device.status, sys_name: nullableText(device.sys_name),
    sys_descr: nullableText(device.sys_descr), sys_object_id: nullableText(device.sys_object_id),
    uptime_seconds: device.uptime_seconds ?? null, manufacturer: nullableText(device.manufacturer),
    model: nullableText(device.model), serial_number: nullableText(device.serial_number),
    last_polled_at: device.last_polled_at ?? now, last_success_at: device.last_success_at ?? null,
    consecutive_poll_failures: device.consecutive_poll_failures ?? 0,
    error_category: device.error_category ?? null, updated_at: now,
  };
  const { error: deviceError } = await db.from("managed_device_latest").upsert(deviceRow, { onConflict: "target_id" });
  if (deviceError) return reply({ error: "Latest managed device state could not be stored" }, 500);

  const interfaceRows = interfaces.map((item) => {
    const row = item as Record<string, unknown>;
    return {
      target_id: targetId, if_index: row.if_index, name: nullableText(row.name), description: nullableText(row.description),
      if_type: row.if_type ?? null, is_physical: row.is_physical === true,
      admin_status: row.admin_status ?? null, oper_status: row.oper_status ?? null,
      speed_bps: row.speed_bps ?? null, rx_rate_bps: row.rx_rate_bps ?? null, tx_rate_bps: row.tx_rate_bps ?? null,
      rx_util_percent: row.rx_util_percent ?? null, tx_util_percent: row.tx_util_percent ?? null,
      rx_errors_cumulative: row.rx_errors_cumulative ?? null, tx_errors_cumulative: row.tx_errors_cumulative ?? null,
      in_discards_cumulative: row.in_discards_cumulative ?? null, out_discards_cumulative: row.out_discards_cumulative ?? null,
      rx_errors_delta: row.rx_errors_delta ?? null, tx_errors_delta: row.tx_errors_delta ?? null,
      in_discards_delta: row.in_discards_delta ?? null, out_discards_delta: row.out_discards_delta ?? null,
      last_polled_at: row.last_polled_at ?? now, updated_at: now,
    };
  });
  if (interfaceRows.length) {
    const { error: interfaceError } = await db.from("managed_interface_latest").upsert(interfaceRows, { onConflict: "target_id,if_index" });
    if (interfaceError) return reply({ error: "Latest managed interface state could not be stored" }, 500);
  }
  let staleQuery = db.from("managed_interface_latest").delete().eq("target_id", targetId);
  if (interfaceRows.length) staleQuery = staleQuery.not("if_index", "in", `(${interfaceRows.map((row) => row.if_index).join(",")})`);
  const { error: staleError } = await staleQuery;
  if (staleError) return reply({ error: "Stale managed interface state could not be removed" }, 500);

  let inserted = 0;
  const transitionIds = transitions.map((item) => (item as Record<string, unknown>).event_id as string);
  const { data: existing, error: existingError } = transitionIds.length
    ? await db.from("events").select("id").in("id", transitionIds)
    : { data: [], error: null };
  if (existingError) return reply({ error: "Managed telemetry event deduplication failed" }, 500);
  const seen = new Set((existing ?? []).map((row: { id: string }) => row.id));
  for (const item of transitions as Record<string, unknown>[]) {
    if (seen.has(item.event_id as string)) continue;
    const kind = item.kind as string;
    if (RECOVERY_KINDS.has(kind)) await resolveOpenEvents(db, targetId, kind, item.raw_context, item.occurred_at as string);
    const event = managedEvent(item, targetId);
    const { error: eventError } = await db.from("events").insert(event);
    if (eventError && eventError.code !== "23505") return reply({ error: "Managed telemetry event could not be stored" }, 500);
    if (!eventError) inserted += 1;
  }
  return reply({ data: { devices: 1, interfaces: interfaceRows.length, events: inserted } }, 200);
}

async function resolveOpenEvents(db: ReturnType<typeof createClient>, targetId: string, kind: string, context: unknown, occurredAt: string) {
  const openKind = kind === "interface_up" ? "interface_down" : "utilization_high";
  let ifIndex: number | null = null;
  if (record(context) && Number.isSafeInteger(context.if_index)) ifIndex = context.if_index as number;
  let query = db.from("events").update({ resolved_at: occurredAt })
    .eq("source", "managed_telemetry").eq("source_ref", targetId).is("resolved_at", null);
  if (ifIndex !== null) query = query.eq("raw_context->>if_index", String(ifIndex));
  query = query.eq("raw_context->>kind", openKind);
  await query;
}

function managedEvent(item: Record<string, unknown>, targetId: string) {
  const context = record(item.raw_context) ? item.raw_context : {};
  return {
    id: item.event_id, created_at: item.occurred_at,
    severity: item.severity, title: item.title, description: item.description ?? null,
    source: "managed_telemetry", source_ref: targetId, resolved_at: null,
    raw_context: { ...context, source: "managed_telemetry", target_id: targetId, event_id: item.event_id, kind: item.kind },
  };
}

function validDevice(value: unknown): value is Record<string, unknown> {
  if (!record(value) || !uuid(value.target_id) || !DEVICE_STATUS.has(String(value.status))) return false;
  if (!nullableDate(value.last_polled_at) || !nullableDate(value.last_success_at) || !nullableInteger(value.consecutive_poll_failures, 0, 1000000)) return false;
  if (value.error_category !== null && value.error_category !== undefined && !ERROR_CATEGORY.has(String(value.error_category))) return false;
  if (value.uptime_seconds !== null && value.uptime_seconds !== undefined && !integer(value.uptime_seconds, 0, 2 ** 53)) return false;
  for (const field of ["sys_name", "sys_descr", "sys_object_id", "manufacturer", "model", "serial_number", "error"]) {
    if (value[field] !== null && value[field] !== undefined && (typeof value[field] !== "string" || value[field].length > 512)) return false;
  }
  return true;
}
function validInterface(value: unknown): value is Record<string, unknown> {
  if (!record(value) || !uuid(value.target_id) || !integer(value.if_index, 0, 2147483647) || typeof value.is_physical !== "boolean") return false;
  if (value.admin_status !== null && value.admin_status !== undefined && !ADMIN_STATUS.has(String(value.admin_status))) return false;
  if (value.oper_status !== null && value.oper_status !== undefined && !OPER_STATUS.has(String(value.oper_status))) return false;
  if (value.if_type !== null && value.if_type !== undefined && !integer(value.if_type, 0, 2147483647)) return false;
  if (!nullableInteger(value.speed_bps, 0, 2 ** 53)) return false;
  for (const field of ["rx_rate_bps", "tx_rate_bps"]) if (!nullableNumber(value[field], 0, 2 ** 63)) return false;
  for (const field of ["rx_util_percent", "tx_util_percent"]) if (!nullableNumber(value[field], 0, 100)) return false;
  for (const field of ["rx_errors_cumulative", "tx_errors_cumulative", "in_discards_cumulative", "out_discards_cumulative"]) if (!nullableInteger(value[field], 0, 2 ** 53)) return false;
  for (const field of ["rx_errors_delta", "tx_errors_delta", "in_discards_delta", "out_discards_delta"]) if (!nullableInteger(value[field], 0, 2 ** 31)) return false;
  if (!dateString(value.last_polled_at)) return false;
  for (const field of ["name", "description"]) {
    if (value[field] !== null && value[field] !== undefined && (typeof value[field] !== "string" || value[field].length > 128)) return false;
  }
  return true;
}
function validTransition(value: unknown): value is Record<string, unknown> {
  if (!record(value) || !uuid(value.event_id) || !uuid(value.target_id)) return false;
  if (!EVENT_KINDS.has(String(value.kind)) || !SEVERITY.has(String(value.severity))) return false;
  if (typeof value.title !== "string" || value.title.length > 200) return false;
  if (value.description !== null && value.description !== undefined && (typeof value.description !== "string" || value.description.length > 500)) return false;
  if (!dateString(value.occurred_at)) return false;
  if (value.raw_context !== undefined && !record(value.raw_context)) return false;
  return true;
}
function serviceClient(request: Request): { ok: true; client: ReturnType<typeof createClient> } | { ok: false; response: Response } {
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), token = bearer(request);
  const apiKey = request.headers.get("apikey");
  const verifiedServiceRole = Boolean(token && apiKey === token && (token === key || jwtRole(token) === "service_role"));
  if (!url || !key || !token || !verifiedServiceRole) return { ok: false, response: reply({ error: "Forbidden" }, 403) };
  return { ok: true, client: createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) };
}
function relation(value: unknown): Record<string, unknown> | null { if (record(value)) return value; return Array.isArray(value) && record(value[0]) ? value[0] : null; }
function nullableText(value: unknown) { return typeof value === "string" && value.length ? value : null; }
function bearer(request: Request) { return request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] }
function jwtRole(token: string) { try { const payload = token.split(".")[1]; if (!payload) return null; const normalized = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "="); return JSON.parse(atob(normalized)).role ?? null } catch { return null } }
function reply(body: Record<string, unknown>, status: number) { return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } }) }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) }
function uuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value) }
function identifier(value: unknown): value is string { return typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value) }
function dateString(value: unknown): value is string { return typeof value === "string" && !Number.isNaN(Date.parse(value)) && Date.parse(value) <= Date.now() + 60000 }
function nullableDate(value: unknown) { return value === null || value === undefined || dateString(value) }
function number(value: unknown, min: number, max: number) { return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max }
function nullableNumber(value: unknown, min: number, max: number) { return value === null || value === undefined || number(value, min, max) }
function integer(value: unknown, min: number, max: number) { return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max }
function nullableInteger(value: unknown, min: number, max: number) { return value === null || value === undefined || integer(value, min, max) }
