import { createClient } from "@supabase/supabase-js";
import { canOperateNetwork } from "../_shared/authorization.ts";
import { legacyApplicationMutationBlocked, legacyApplicationMutationBlockedResponse } from "../_shared/persistence-authority.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const RUNNER_FRESH_MS = 30_000;
const RESULT_TTL_MS = 10 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STAGES = ["validating_target", "network_role", "identity", "services", "normalizing", "complete"];
const FORBIDDEN_FIELDS = ["command", "flags", "ports", "port_list", "nmap_args", "nse", "script", "uri", "cidr", "subnet"];
const FORBIDDEN_RESULT_KEYS = /^(raw|stdout|stderr|html|xml|body|payload|cookie|token|authorization|credential|password|secret)$/i;

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method === "GET") return readState(request);
  if (request.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  if (legacyApplicationMutationBlocked()) return legacyApplicationMutationBlockedResponse(CORS);
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return reply({ error: "Invalid JSON" }, 400); }
  if (!record(body) || typeof body.action !== "string") return reply({ error: "Structured action required" }, 400);
  return body.action === "start_inspection" ? startInspection(request, body) : runnerAction(request, body);
});

async function readState(request: Request) {
  const auth = await userAuth(request);
  if (!auth.ok) return auth.response;
  if (!canOperateNetwork(auth.role)) return reply({ error: "Operator role required" }, 403);
  await expireSessions(auth.service);
  const { data, error } = await auth.client.from("device_inspection_sessions").select("*").limit(50);
  return error ? reply({ error: "Inspection state could not be loaded" }, 500) : reply({ data: data ?? [] }, 200);
}

async function startInspection(request: Request, body: Record<string, unknown>) {
  const auth = await userAuth(request);
  if (!auth.ok) return auth.response;
  if (!canOperateNetwork(auth.role)) return reply({ error: "Operator role required" }, 403);
  if (FORBIDDEN_FIELDS.some((field) => field in body)) return reply({ error: "Browser-defined probe configuration is prohibited" }, 400);
  if (!identifier(body.runner_id) || !privateIpv4(body.target_ip)) return reply({ error: "Invalid runner or private target IP" }, 400);
  await expireSessions(auth.service);

  const { data: runner } = await auth.service.from("diagnostic_runners")
    .select("id,last_seen_at,health_status,capabilities").eq("id", body.runner_id).maybeSingle();
  if (!runner) return reply({ error: "Runner not found" }, 404);
  if (runner.health_status !== "online" || Date.now() - Date.parse(runner.last_seen_at) > RUNNER_FRESH_MS) {
    return reply({ error: "Local Runner is offline. Device inspection is unavailable.", code: "RUNNER_OFFLINE" }, 409);
  }
  const capabilities = record(runner.capabilities) ? runner.capabilities : {};
  if (!Array.isArray(capabilities.operations) || !capabilities.operations.includes("device_inspect")) {
    return reply({ error: "Device inspection is not authorized by this runner", code: "INSPECTION_NOT_AUTHORIZED" }, 409);
  }
  if (record(capabilities.device_inspector) && capabilities.device_inspector.available !== true) {
    return reply({ error: "Device Inspector agent is unavailable on this runner", code: "INSPECTION_AGENT_UNAVAILABLE" }, 409);
  }
  const source = await authorizedTarget(auth.service, body.runner_id as string, body.target_ip as string);
  if (!source) return reply({ error: "Target is not in current discovery results or inventory", code: "TARGET_NOT_AUTHORIZED" }, 403);
  const busy = await runnerBusy(auth.service, body.runner_id as string);
  if (busy) return reply({ error: busy, code: "RUNNER_BUSY" }, 409);

  const now = new Date();
  const row = {
    runner_id: body.runner_id,
    inspection_id: crypto.randomUUID(),
    requested_by: auth.userId,
    target_ip: body.target_ip,
    authorization_source: source,
    status: "queued",
    stage: "validating_target",
    result: null,
    error_code: null,
    created_at: now.toISOString(),
    started_at: null,
    completed_at: null,
    expires_at: new Date(now.getTime() + RESULT_TTL_MS).toISOString(),
    updated_at: now.toISOString(),
  };
  const { data, error } = await auth.service.from("device_inspection_sessions")
    .upsert(row, { onConflict: "runner_id" }).select().single();
  return error ? reply({ error: "Inspection could not be queued" }, 500) : reply({ data }, 202);
}

async function runnerAction(request: Request, body: Record<string, unknown>) {
  const auth = serviceAuth(request);
  if (!auth.ok) return auth.response;
  if (!identifier(body.runner_id)) return reply({ error: "Invalid runner" }, 400);
  await expireSessions(auth.client);
  if (body.action === "claim_session") {
    const { data: queued, error } = await auth.client.from("device_inspection_sessions").select("*")
      .eq("runner_id", body.runner_id).eq("status", "queued").maybeSingle();
    if (error) return reply({ error: "Inspection claim failed" }, 500);
    if (!queued) return reply({ data: null }, 200);
    const now = new Date().toISOString();
    const { data, error: claimError } = await auth.client.from("device_inspection_sessions")
      .update({ status: "running", started_at: now, updated_at: now })
      .eq("runner_id", body.runner_id).eq("inspection_id", queued.inspection_id).eq("status", "queued")
      .select().maybeSingle();
    return claimError ? reply({ error: "Inspection claim failed" }, 500) : reply({ data }, 200);
  }
  if (!uuid(body.inspection_id)) return reply({ error: "Invalid inspection session" }, 400);
  if (body.action === "update_stage") return updateStage(auth.client, body);
  if (body.action === "complete_session") return completeSession(auth.client, body);
  if (body.action === "fail_session") return failSession(auth.client, body);
  return reply({ error: "Unsupported action" }, 400);
}

async function updateStage(db: ReturnType<typeof createClient>, body: Record<string, unknown>) {
  if (typeof body.stage !== "string" || !STAGES.includes(body.stage)) return reply({ error: "Invalid inspection stage" }, 400);
  const { data, error } = await db.from("device_inspection_sessions").update({ stage: body.stage, updated_at: new Date().toISOString() })
    .eq("runner_id", body.runner_id).eq("inspection_id", body.inspection_id).eq("status", "running").select().maybeSingle();
  return error ? reply({ error: "Inspection stage could not be stored" }, 500) : reply({ data }, data ? 200 : 409);
}

async function completeSession(db: ReturnType<typeof createClient>, body: Record<string, unknown>) {
  if (!validFingerprint(body.result)) return reply({ error: "Normalized fingerprint is invalid" }, 400);
  const bytes = new TextEncoder().encode(JSON.stringify(body.result)).length;
  if (bytes > 64 * 1024) return reply({ error: "Inspection result exceeds safety bounds" }, 413);
  if (containsForbiddenResult(body.result)) return reply({ error: "Inspection result contains prohibited raw content" }, 400);
  const { data: current } = await db.from("device_inspection_sessions").select("target_ip")
    .eq("runner_id", body.runner_id).eq("inspection_id", body.inspection_id).eq("status", "running").maybeSingle();
  if (!current || host(current.target_ip) !== (body.result as Record<string, unknown>).ip) return reply({ error: "Inspection target mismatch" }, 409);
  const now = new Date();
  const { data, error } = await db.from("device_inspection_sessions").update({
    status: "completed", stage: "complete", result: body.result, completed_at: now.toISOString(),
    expires_at: new Date(now.getTime() + RESULT_TTL_MS).toISOString(), updated_at: now.toISOString(),
  }).eq("runner_id", body.runner_id).eq("inspection_id", body.inspection_id).eq("status", "running").select().maybeSingle();
  return error ? reply({ error: "Inspection completion failed" }, 500) : reply({ data }, data ? 200 : 409);
}

async function failSession(db: ReturnType<typeof createClient>, body: Record<string, unknown>) {
  const code = typeof body.error_code === "string" && /^[A-Z0-9_]{1,64}$/.test(body.error_code) ? body.error_code : "INSPECTION_FAILED";
  const now = new Date();
  const { data, error } = await db.from("device_inspection_sessions").update({
    status: "failed", error_code: code, completed_at: now.toISOString(),
    expires_at: new Date(now.getTime() + RESULT_TTL_MS).toISOString(), updated_at: now.toISOString(),
  }).eq("runner_id", body.runner_id).eq("inspection_id", body.inspection_id).eq("status", "running").select().maybeSingle();
  return error ? reply({ error: "Inspection failure could not be stored" }, 500) : reply({ data }, data ? 200 : 409);
}

async function authorizedTarget(db: ReturnType<typeof createClient>, runnerId: string, ip: string): Promise<"inventory" | "discovery" | null> {
  const { count } = await db.from("network_nodes").select("id", { count: "exact", head: true }).eq("ip_address", ip);
  if ((count ?? 0) > 0) return "inventory";
  const { data } = await db.from("network_discovery_sessions").select("status,expires_at,results").eq("runner_id", runnerId).maybeSingle();
  if (!data || Date.parse(data.expires_at) <= Date.now() || !["idle", "running", "completed"].includes(data.status) || !Array.isArray(data.results)) return null;
  return data.results.some((item: unknown) => record(item) && item.ip_address === ip) ? "discovery" : null;
}

async function runnerBusy(db: ReturnType<typeof createClient>, runnerId: string) {
  const [jobs, traffic, discovery, inspection] = await Promise.all([
    db.from("diagnostic_jobs").select("id", { count: "exact", head: true }).eq("runner_id", runnerId).in("status", ["queued", "running"]),
    db.from("traffic_live_sessions").select("id", { count: "exact", head: true }).eq("runner_id", runnerId).in("status", ["queued", "running", "stopping"]),
    db.from("network_discovery_sessions").select("session_id", { count: "exact", head: true }).eq("runner_id", runnerId).in("status", ["queued", "running"]),
    db.from("device_inspection_sessions").select("inspection_id", { count: "exact", head: true }).eq("runner_id", runnerId).in("status", ["queued", "running"]),
  ]);
  if ((jobs.count ?? 0) > 0) return "Runner is busy with LAN Diagnostics";
  if ((traffic.count ?? 0) > 0) return "Runner is busy with Traffic capture";
  if ((discovery.count ?? 0) > 0) return "Runner is busy with Network Discovery";
  if ((inspection.count ?? 0) > 0) return "Runner is busy with Device Inspector";
  return null;
}

async function expireSessions(db: ReturnType<typeof createClient>) {
  const now = new Date().toISOString();
  await db.from("device_inspection_sessions").update({ status: "expired", result: null, error_code: null, updated_at: now })
    .lt("expires_at", now).neq("status", "expired");
}

function validFingerprint(value: unknown) {
  if (!record(value) || !privateIpv4(value.ip) || !["high", "medium", "low", "unknown"].includes(String(value.confidence))) return false;
  if (typeof value.likely_device_type !== "string" || !Array.isArray(value.capabilities) || value.capabilities.length > 16 || !Array.isArray(value.evidence) || value.evidence.length > 32) return false;
  return true;
}
function containsForbiddenResult(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenResult);
  if (!record(value)) return false;
  return Object.entries(value).some(([key, nested]) => FORBIDDEN_RESULT_KEYS.test(key) || containsForbiddenResult(nested));
}
async function userAuth(request: Request): Promise<any> {
  const url = Deno.env.get("SUPABASE_URL"), anon = Deno.env.get("SUPABASE_ANON_KEY"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), token = bearer(request);
  if (!url || !anon || !key || !token) return { ok: false, response: reply({ error: "Unauthorized" }, 401) };
  const client = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } });
  const { data: user } = await client.auth.getUser(token);
  if (!user.user) return { ok: false, response: reply({ error: "Unauthorized" }, 401) };
  const { data: profile } = await client.from("profiles").select("status,role").eq("id", user.user.id).maybeSingle();
  if (profile?.status !== "approved") return { ok: false, response: reply({ error: "Forbidden" }, 403) };
  return { ok: true, client, service: createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }), userId: user.user.id, role: profile.role };
}
function serviceAuth(request: Request): { ok: true; client: ReturnType<typeof createClient> } | { ok: false; response: Response } {
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), token = bearer(request), apiKey = request.headers.get("apikey");
  const valid = Boolean(token && apiKey === token && (token === key || jwtRole(token) === "service_role"));
  return url && key && valid
    ? { ok: true, client: createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) }
    : { ok: false, response: reply({ error: "Forbidden" }, 403) };
}
function bearer(request: Request) { return request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]; }
function jwtRole(token: string) { try { const value = token.split(".")[1]; if (!value) return null; const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="); return JSON.parse(atob(normalized)).role ?? null; } catch { return null; } }
function reply(body: Record<string, unknown>, status: number) { return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } }); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function identifier(value: unknown): value is string { return typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value); }
function uuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
function ipv4(value: unknown): value is string { return typeof value === "string" && value.split(".").length === 4 && value.split(".").every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255); }
function privateIpv4(value: unknown): value is string { if (!ipv4(value)) return false; const [a, b] = value.split(".").map(Number); return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168); }
function host(value: unknown) { return typeof value === "string" ? value.split("/")[0] : ""; }
