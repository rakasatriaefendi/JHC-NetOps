import { createClient } from "@supabase/supabase-js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const RUNNER_FRESH_MS = 30_000;
const RESULT_TTL_MS = 10 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method === "GET") return readState(request);
  if (request.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  let body: Record<string, unknown>;
  try { body = await request.json(); }
  catch { return reply({ error: "Invalid JSON" }, 400); }
  if (!record(body) || typeof body.action !== "string") return reply({ error: "Structured action required" }, 400);
  if (["prepare_session", "start_session"].includes(body.action)) return userAction(request, body);
  return runnerAction(request, body);
});

async function readState(request: Request) {
  const auth = await userAuth(request);
  if (!auth.ok) return auth.response;
  if (auth.role !== "admin") return reply({ error: "Admin role required" }, 403);
  await expireSessions(auth.service);
  const { data, error } = await auth.client.from("network_discovery_sessions").select("*").limit(50);
  return error ? reply({ error: "Discovery state could not be loaded" }, 500) : reply({ data: data ?? [] }, 200);
}

async function userAction(request: Request, body: Record<string, unknown>) {
  const auth = await userAuth(request);
  if (!auth.ok) return auth.response;
  if (auth.role !== "admin") return reply({ error: "Admin role required" }, 403);
  if (["subnet_cidr", "cidr", "ip_range", "command", "flags"].some((field) => field in body)) {
    return reply({ error: "Browser-defined discovery scope is prohibited" }, 400);
  }
  if (!identifier(body.runner_id)) return reply({ error: "Invalid runner" }, 400);
  await expireSessions(auth.service);
  const { data: runner, error } = await auth.service.from("diagnostic_runners")
    .select("id,last_seen_at,health_status,capabilities").eq("id", body.runner_id).maybeSingle();
  if (error || !runner) return reply({ error: "Runner not found" }, 404);
  if (runner.health_status !== "online" || Date.now() - Date.parse(runner.last_seen_at) > RUNNER_FRESH_MS) {
    return reply({ error: "Local Runner is offline. Network discovery is unavailable.", code: "RUNNER_OFFLINE" }, 409);
  }
  const capabilities = record(runner.capabilities) ? runner.capabilities : {};
  if (!Array.isArray(capabilities.operations) || !capabilities.operations.includes("network_discovery")) {
    return reply({ error: "Network discovery is not authorized by this runner", code: "DISCOVERY_NOT_AUTHORIZED" }, 409);
  }

  const now = new Date();
  if (body.action === "prepare_session") {
    const { data: current } = await auth.service.from("network_discovery_sessions").select("*").eq("runner_id", body.runner_id).maybeSingle();
    if (current && ["queued", "running"].includes(current.status)) return reply({ data: current }, 200);
    const sessionId = crypto.randomUUID();
    const row = {
      runner_id: body.runner_id,
      session_id: sessionId,
      requested_by: auth.userId,
      status: "queued",
      phase: "prepare",
      connection_type: null,
      interface_alias: null,
      local_ipv4: null,
      subnet_cidr: null,
      total_hosts: 0,
      scanned_hosts: 0,
      found_count: 0,
      results: [],
      error_code: null,
      created_at: now.toISOString(),
      started_at: null,
      completed_at: null,
      expires_at: new Date(now.getTime() + RESULT_TTL_MS).toISOString(),
      updated_at: now.toISOString(),
    };
    const { data, error: upsertError } = await auth.service.from("network_discovery_sessions")
      .upsert(row, { onConflict: "runner_id" }).select().single();
    return upsertError ? reply({ error: "Discovery preparation could not be queued" }, 500) : reply({ data }, 202);
  }

  if (!uuid(body.session_id)) return reply({ error: "Invalid discovery session" }, 400);
  const busy = await runnerBusy(auth.service, body.runner_id as string);
  if (busy) return reply({ error: busy.message, code: "RUNNER_BUSY" }, 409);
  const { data, error: updateError } = await auth.service.from("network_discovery_sessions")
    .update({ status: "queued", phase: "scan", scanned_hosts: 0, found_count: 0, results: [], error_code: null,
      started_at: null, completed_at: null, expires_at: new Date(now.getTime() + RESULT_TTL_MS).toISOString(), updated_at: now.toISOString() })
    .eq("runner_id", body.runner_id).eq("session_id", body.session_id).in("status", ["idle", "completed", "failed"])
    .select().maybeSingle();
  if (updateError) return reply({ error: "Discovery could not be queued" }, 500);
  return data ? reply({ data }, 202) : reply({ error: "Prepared discovery session was not found", code: "DISCOVERY_NOT_READY" }, 409);
}

async function runnerAction(request: Request, body: Record<string, unknown>) {
  const auth = serviceAuth(request);
  if (!auth.ok) return auth.response;
  if (!identifier(body.runner_id)) return reply({ error: "Invalid runner" }, 400);
  await expireSessions(auth.client);
  if (body.action === "claim_session") {
    const { data: queued, error } = await auth.client.from("network_discovery_sessions").select("*")
      .eq("runner_id", body.runner_id).eq("status", "queued").maybeSingle();
    if (error) return reply({ error: "Discovery claim failed" }, 500);
    if (!queued) return reply({ data: null }, 200);
    const now = new Date().toISOString();
    const { data, error: claimError } = await auth.client.from("network_discovery_sessions")
      .update({ status: "running", started_at: now, updated_at: now })
      .eq("runner_id", body.runner_id).eq("session_id", queued.session_id).eq("status", "queued")
      .select().maybeSingle();
    return claimError ? reply({ error: "Discovery claim failed" }, 500) : reply({ data }, 200);
  }
  if (!uuid(body.session_id)) return reply({ error: "Invalid discovery session" }, 400);
  if (body.action === "context_ready") return updateContext(auth.client, body, true);
  if (body.action === "update_progress") return updateProgress(auth.client, body);
  if (body.action === "complete_session") return completeSession(auth.client, body);
  if (body.action === "fail_session") return failSession(auth.client, body);
  return reply({ error: "Unsupported action" }, 400);
}

async function updateContext(db: ReturnType<typeof createClient>, body: Record<string, unknown>, idle: boolean) {
  const context = validateContext(body.context);
  if (!context.ok) return reply({ error: context.error }, 400);
  const now = new Date();
  const { data, error } = await db.from("network_discovery_sessions").update({
    ...context.value,
    status: idle ? "idle" : "running",
    completed_at: idle ? now.toISOString() : null,
    expires_at: new Date(now.getTime() + RESULT_TTL_MS).toISOString(),
    updated_at: now.toISOString(),
  }).eq("runner_id", body.runner_id).eq("session_id", body.session_id).eq("status", "running").eq("phase", "prepare").select().maybeSingle();
  return error ? reply({ error: "Discovery context could not be stored" }, 500) : reply({ data }, data ? 200 : 409);
}

async function updateProgress(db: ReturnType<typeof createClient>, body: Record<string, unknown>) {
  const context = validateContext(body.context);
  if (!context.ok) return reply({ error: context.error }, 400);
  if (!integer(body.scanned_hosts, 0, context.value.total_hosts) || !validResults(body.results, context.value.subnet_cidr)) {
    return reply({ error: "Discovery progress is invalid" }, 400);
  }
  const results = deduplicate(body.results as Record<string, unknown>[]);
  if (results.length > 254 || new TextEncoder().encode(JSON.stringify(results)).length > 64 * 1024) {
    return reply({ error: "Discovery result exceeds safety bounds" }, 413);
  }
  const now = new Date();
  const { data, error } = await db.from("network_discovery_sessions").update({
    ...context.value,
    scanned_hosts: body.scanned_hosts,
    found_count: results.length,
    results,
    expires_at: new Date(now.getTime() + RESULT_TTL_MS).toISOString(),
    updated_at: now.toISOString(),
  }).eq("runner_id", body.runner_id).eq("session_id", body.session_id).eq("status", "running").eq("phase", "scan").select().maybeSingle();
  return error ? reply({ error: "Discovery progress could not be stored" }, 500) : reply({ data }, data ? 200 : 409);
}

async function completeSession(db: ReturnType<typeof createClient>, body: Record<string, unknown>) {
  if (!integer(body.scanned_hosts, 0, 254)) return reply({ error: "Discovery completion is invalid" }, 400);
  const now = new Date();
  const { data, error } = await db.from("network_discovery_sessions").update({
    status: "completed", scanned_hosts: body.scanned_hosts, completed_at: now.toISOString(),
    expires_at: new Date(now.getTime() + RESULT_TTL_MS).toISOString(), updated_at: now.toISOString(),
  }).eq("runner_id", body.runner_id).eq("session_id", body.session_id).eq("status", "running").eq("phase", "scan").select().maybeSingle();
  return error ? reply({ error: "Discovery completion failed" }, 500) : reply({ data }, data ? 200 : 409);
}

async function failSession(db: ReturnType<typeof createClient>, body: Record<string, unknown>) {
  const code = typeof body.error_code === "string" && /^[A-Z0-9_]{1,64}$/.test(body.error_code) ? body.error_code : "DISCOVERY_FAILED";
  const now = new Date();
  const { data, error } = await db.from("network_discovery_sessions").update({
    status: "failed", error_code: code, completed_at: now.toISOString(),
    expires_at: new Date(now.getTime() + RESULT_TTL_MS).toISOString(), updated_at: now.toISOString(),
  }).eq("runner_id", body.runner_id).eq("session_id", body.session_id).eq("status", "running").select().maybeSingle();
  return error ? reply({ error: "Discovery failure could not be stored" }, 500) : reply({ data }, data ? 200 : 409);
}

async function expireSessions(db: ReturnType<typeof createClient>) {
  const now = new Date().toISOString();
  await db.from("network_discovery_sessions").update({ status: "expired", connection_type: null, interface_alias: null,
    local_ipv4: null, subnet_cidr: null, total_hosts: 0, scanned_hosts: 0, found_count: 0, results: [], updated_at: now })
    .lt("expires_at", now).neq("status", "expired");
}

async function runnerBusy(db: ReturnType<typeof createClient>, runnerId: string) {
  const [{ count: jobs }, { count: traffic }, { count: inspection }] = await Promise.all([
    db.from("diagnostic_jobs").select("id", { count: "exact", head: true }).eq("runner_id", runnerId).in("status", ["queued", "running"]),
    db.from("traffic_live_sessions").select("id", { count: "exact", head: true }).eq("runner_id", runnerId).in("status", ["queued", "running", "stopping"]),
    db.from("device_inspection_sessions").select("inspection_id", { count: "exact", head: true }).eq("runner_id", runnerId).in("status", ["queued", "running"]),
  ]);
  if ((jobs ?? 0) > 0) return { message: "Runner is busy with LAN Diagnostics" };
  if ((traffic ?? 0) > 0) return { message: "Runner is busy with Traffic capture" };
  if ((inspection ?? 0) > 0) return { message: "Runner is busy with Device Inspector" };
  return null;
}

function validateContext(value: unknown): { ok: true; value: Record<string, unknown> & { subnet_cidr: string; total_hosts: number } } | { ok: false; error: string } {
  if (!record(value) || !["wifi", "ethernet", "unknown"].includes(String(value.connection_type)) ||
      typeof value.interface_alias !== "string" || value.interface_alias.length > 256 || !ipv4(value.local_ipv4) || typeof value.subnet_cidr !== "string") {
    return { ok: false, error: "Discovery network context is invalid" };
  }
  const [network, rawPrefix, extra] = value.subnet_cidr.split("/");
  const prefix = Number(rawPrefix);
  if (extra !== undefined || !ipv4(network) || !Number.isInteger(prefix) || prefix < 24 || prefix > 30) {
    return { ok: false, error: "Detected subnet exceeds the safe discovery scope" };
  }
  const totalHosts = 2 ** (32 - prefix) - 2;
  if (!sameSubnet(value.local_ipv4 as string, network, prefix)) return { ok: false, error: "Discovery subnet does not contain the runner address" };
  return { ok: true, value: { connection_type: value.connection_type, interface_alias: value.interface_alias,
    local_ipv4: value.local_ipv4, subnet_cidr: `${network}/${prefix}`, total_hosts: totalHosts } };
}

function validResults(value: unknown, subnet: string) {
  if (!Array.isArray(value) || value.length > 254) return false;
  const [network, prefix] = subnet.split("/");
  return value.every((item) => record(item) && ipv4(item.ip_address) && isUsableHost(item.ip_address as string, network, Number(prefix)) &&
    Array.isArray(item.evidence) && item.evidence.length >= 1 && item.evidence.length <= 2 && item.evidence.every((entry) => ["icmp", "neighbor"].includes(String(entry))) &&
    (item.latency_ms === null || number(item.latency_ms, 0, 60_000)) && typeof item.is_this_device === "boolean" && typeof item.is_gateway === "boolean" &&
    (item.reachability_evidence === undefined || ["icmp_verified", "l2_observed", "cached_only"].includes(String(item.reachability_evidence))) &&
    (item.neighbor_state === undefined || ["Reachable", "Stale", "Delay", "Probe", "Permanent"].includes(String(item.neighbor_state))));
}

function deduplicate(results: Record<string, unknown>[]) {
  return [...new Map(results.map((item) => [item.ip_address as string, item])).values()]
    .sort((left, right) => ipNumber(left.ip_address as string) - ipNumber(right.ip_address as string));
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
  return url && key && valid ? { ok: true, client: createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) }
    : { ok: false, response: reply({ error: "Forbidden" }, 403) };
}

function bearer(request: Request) { return request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]; }
function jwtRole(token: string) { try { const value = token.split(".")[1]; if (!value) return null; const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="); return JSON.parse(atob(normalized)).role ?? null; } catch { return null; } }
function reply(body: Record<string, unknown>, status: number) { return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } }); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function identifier(value: unknown): value is string { return typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value); }
function uuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
function integer(value: unknown, min: number, max: number) { return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max; }
function number(value: unknown, min: number, max: number) { return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max; }
function ipv4(value: unknown): value is string { return typeof value === "string" && value.split(".").length === 4 && value.split(".").every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255); }
function ipNumber(value: string) { return value.split(".").reduce((total, part) => total * 256 + Number(part), 0) >>> 0; }
function sameSubnet(ip: string, network: string, prefix: number) { const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0; return (ipNumber(ip) & mask) === (ipNumber(network) & mask); }
function isUsableHost(ip: string, network: string, prefix: number) { const base = ipNumber(network); const value = ipNumber(ip); const broadcast = base + 2 ** (32 - prefix) - 1; return sameSubnet(ip, network, prefix) && value > base && value < broadcast; }
