import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
loadEnv(path.join(root, "runner", ".env"));
loadEnv(path.join(root, "frontend", ".env.local"));

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const runner = JSON.parse(readFileSync(path.join(root, "runner", "config.local.json"), "utf8"));
if (!url || !serviceKey || !anonKey || !runner.runner_id) throw new Error("Verification environment is incomplete");

const suffix = `${Date.now()}-${randomBytes(3).toString("hex")}`;
const password = `Tmp-${randomBytes(18).toString("base64url")}!`;
const users = [];
let nodeId = null;
let targetId = null;

try {
  const before = await protectedCounts();
  const admin = await createUser(`discovery-admin-${suffix}@example.invalid`, "admin");
  const viewer = await createUser(`discovery-viewer-${suffix}@example.invalid`, "viewer");
  const adminToken = await signIn(admin.email, password);
  const viewerToken = await signIn(viewer.email, password);

  const viewerAttempt = await functionRequest(viewerToken, { action: "prepare_session", runner_id: runner.runner_id });
  assert(viewerAttempt.status === 403, "Viewer could initiate discovery");
  const viewerRows = await rest("network_discovery_sessions?select=runner_id", { token: viewerToken, key: anonKey });
  assert(Array.isArray(viewerRows.data) && viewerRows.data.length === 0, "Viewer could read admin-only discovery state");

  const injected = await functionRequest(adminToken, { action: "prepare_session", runner_id: runner.runner_id, subnet_cidr: "10.0.0.0/8" });
  assert(injected.status === 400, "Browser-defined CIDR was not rejected");
  const prepared = await functionRequest(adminToken, { action: "prepare_session", runner_id: runner.runner_id });
  assert([200, 202].includes(prepared.status), `Discovery preparation was rejected (${prepared.status}: ${prepared.data?.error ?? prepared.data?.code ?? "unknown"})`);
  const idle = await waitForSession(adminToken, (session) => session.status === "idle", 60_000);
  const resolvedPrefix = Number(idle.subnet_cidr?.split("/")[1]);
  assert(idle.subnet_cidr && Number.isInteger(resolvedPrefix) && resolvedPrefix >= 8 && resolvedPrefix <= 30 && idle.total_hosts <= 254,
    "Runner did not supply an eligible scope with a bounded scan unit");

  const started = await functionRequest(adminToken, { action: "start_session", runner_id: runner.runner_id, session_id: idle.session_id });
  assert(started.status === 202, "Discovery scan was not queued");
  const completed = await waitForSession(adminToken, (session) => session.status === "completed", 120_000);
  assert(completed.scanned_hosts === completed.total_hosts, "Discovery did not finish its bounded host set");
  assert(completed.results.length <= 254 && new Set(completed.results.map((item) => item.ip_address)).size === completed.results.length, "Discovery results were not bounded/deduplicated");

  const afterScan = await protectedCounts();
  assert(afterScan.nodes === before.nodes, "Discovery automatically created network_nodes");
  assert(afterScan.targets === before.targets, "Discovery automatically created network_targets");

  const node = await rest("network_nodes", { method: "POST", token: adminToken, key: anonKey,
    body: { ip_address: "127.0.0.254", name: `Discovery verification ${suffix}`, device_type: "workstation", location: "Test fixture" }, prefer: "return=representation" });
  assert(node.status === 201 && node.data?.[0]?.id, "Admin Give Name workflow failed");
  nodeId = node.data[0].id;
  const target = await rest("network_targets", { method: "POST", token: adminToken, key: anonKey,
    body: { runner_id: runner.runner_id, node_id: nodeId, enabled: true }, prefer: "return=representation" });
  assert(target.status === 201 && target.data?.[0]?.id, "Explicit Health Watch promotion failed");
  targetId = target.data[0].id;

  await rest(`network_targets?id=eq.${targetId}`, { method: "DELETE", token: serviceKey, key: serviceKey });
  targetId = null;
  await rest(`network_nodes?id=eq.${nodeId}`, { method: "DELETE", token: serviceKey, key: serviceKey });
  nodeId = null;

  await rest(`network_discovery_sessions?runner_id=eq.${encodeURIComponent(runner.runner_id)}`, { method: "PATCH", token: serviceKey, key: serviceKey,
    body: { expires_at: new Date(Date.now() - 60_000).toISOString() } });
  const expired = await waitForSession(adminToken, (session) => session.status === "expired", 30_000);
  assert(expired.results.length === 0 && expired.local_ipv4 === null && expired.subnet_cidr === null, "Expired discovery payload was not cleaned");

  const after = await protectedCounts();
  assert(after.nodes === before.nodes && after.targets === before.targets, "Verification fixtures were not removed");
  assert(after.events === before.events && after.traffic === before.traffic, "Discovery changed events or traffic_metrics");
  console.log(JSON.stringify({ ok: true, runner_id: runner.runner_id, subnet_prefix: Number(idle.subnet_cidr.split("/")[1]), scanned_hosts: completed.scanned_hosts,
    found_count: completed.found_count, viewer_blocked: true, arbitrary_cidr_blocked: true, inventory_unchanged_after_scan: true,
    explicit_promotion_verified: true, expired_payload_cleaned: true, events_delta: 0, traffic_metrics_delta: 0 }, null, 2));
} finally {
  if (targetId) await rest(`network_targets?id=eq.${targetId}`, { method: "DELETE", token: serviceKey, key: serviceKey }).catch(() => {});
  if (nodeId) await rest(`network_nodes?id=eq.${nodeId}`, { method: "DELETE", token: serviceKey, key: serviceKey }).catch(() => {});
  for (const id of users) await fetch(`${url}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: authHeaders(serviceKey, serviceKey) }).catch(() => {});
}

async function createUser(email, role) {
  const response = await fetch(`${url}/auth/v1/admin/users`, { method: "POST", headers: { ...authHeaders(serviceKey, serviceKey), "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, email_confirm: true }) });
  const user = await response.json();
  if (!response.ok || !user.id) throw new Error("Temporary verification user could not be created");
  users.push(user.id);
  const profile = await rest(`profiles?id=eq.${user.id}`, { method: "PATCH", token: serviceKey, key: serviceKey,
    body: { status: "approved", role, approved_at: new Date().toISOString() }, prefer: "return=representation" });
  if (profile.status !== 200 || !profile.data?.length) throw new Error("Temporary verification profile could not be approved");
  return { id: user.id, email };
}

async function signIn(email, passwordValue) {
  const response = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: anonKey, "Content-Type": "application/json" }, body: JSON.stringify({ email, password: passwordValue }) });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw new Error("Temporary verification sign-in failed");
  return data.access_token;
}

async function functionRequest(token, body) {
  const response = await fetch(`${url}/functions/v1/network-discovery`, { method: "POST", headers: { ...authHeaders(token, anonKey), "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

async function waitForSession(token, predicate, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const response = await fetch(`${url}/functions/v1/network-discovery`, { headers: authHeaders(token, anonKey) });
    const payload = await response.json();
    const session = payload.data?.find((item) => item.runner_id === runner.runner_id);
    if (session && predicate(session)) return session;
    if (session?.status === "failed") throw new Error(`Discovery failed with ${session.error_code}`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Timed out waiting for discovery state");
}

async function protectedCounts() {
  return {
    nodes: await count("network_nodes"),
    targets: await count("network_targets"),
    events: await count("events"),
    traffic: await count("traffic_metrics"),
  };
}

async function count(table) {
  const response = await fetch(`${url}/rest/v1/${table}?select=id`, { headers: { ...authHeaders(serviceKey, serviceKey), Prefer: "count=exact", Range: "0-0" } });
  if (!response.ok) throw new Error(`Could not count ${table}`);
  return Number(response.headers.get("content-range")?.split("/")[1] ?? 0);
}

async function rest(resource, { method = "GET", token, key, body, prefer } = {}) {
  const response = await fetch(`${url}/rest/v1/${resource}`, { method, headers: { ...authHeaders(token, key), ...(body ? { "Content-Type": "application/json" } : {}), ...(prefer ? { Prefer: prefer } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  return { status: response.status, data };
}

function authHeaders(token, key) { return { Authorization: `Bearer ${token}`, apikey: key }; }
function assert(condition, message) { if (!condition) throw new Error(message); }
function loadEnv(filename) { try { for (const raw of readFileSync(filename, "utf8").split(/\r?\n/)) { const line = raw.trim(); if (!line || line.startsWith("#")) continue; const index = line.indexOf("="); if (index < 1) continue; const key = line.slice(0, index).trim(); let value = line.slice(index + 1).trim(); if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1); if (process.env[key] === undefined) process.env[key] = value; } } catch {} }
