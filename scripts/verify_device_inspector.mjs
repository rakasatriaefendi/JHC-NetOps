import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
loadEnv(path.join(root, "runner", ".env"));
loadEnv(path.join(root, "frontend", ".env.local"));
const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (!url || !serviceKey || !anonKey) throw new Error("Verification environment is incomplete");

const suffix = `${Date.now()}-${randomBytes(3).toString("hex")}`;
const runnerId = `inspector-verify-${suffix}`;
const inventoryIp = "10.254.253.11";
const discoveryIp = "10.254.253.12";
const password = `Tmp-${randomBytes(18).toString("base64url")}!`;
const users = [];
let nodeId = null;

try {
  const before = await protectedCounts();
  const admin = await createUser(`inspector-admin-${suffix}@example.invalid`, "admin");
  const viewer = await createUser(`inspector-viewer-${suffix}@example.invalid`, "viewer");
  const adminToken = await signIn(admin.email, password);
  const viewerToken = await signIn(viewer.email, password);
  await assertRest("diagnostic_runners", "POST", serviceKey, serviceKey, {
    id: runnerId, display_name: "Device Inspector verification", health_status: "online",
    last_seen_at: new Date().toISOString(), capabilities: { operations: ["device_inspect"] },
  }, 201);
  const created = await assertRest("network_nodes", "POST", adminToken, anonKey, {
    ip_address: inventoryIp, name: "Operator stable identity", device_type: "router", location: "Fixture", notes: "Do not overwrite",
  }, 201, "return=representation");
  nodeId = created[0].id;

  const viewerStart = await functionRequest(viewerToken, anonKey, { action: "start_inspection", runner_id: runnerId, target_ip: inventoryIp });
  assert(viewerStart.status === 403, "Viewer could start active inspection");
  const viewerSessions = await rest("device_inspection_sessions?select=runner_id", { token: viewerToken, key: anonKey });
  assert(Array.isArray(viewerSessions.data) && viewerSessions.data.length === 0, "Viewer could read temporary inspection sessions");
  for (const injected of [
    { command: "nmap -A" }, { flags: ["-A"] }, { ports: [1, 65535] },
    { nse: "vuln" }, { script: "default" }, { uri: "http://example.invalid" }, { cidr: "10.0.0.0/8" },
  ]) {
    const response = await functionRequest(adminToken, anonKey, { action: "start_inspection", runner_id: runnerId, target_ip: inventoryIp, ...injected });
    assert(response.status === 400, `Unsafe browser field was accepted: ${Object.keys(injected)[0]}`);
  }
  assert((await functionRequest(adminToken, anonKey, { action: "start_inspection", runner_id: runnerId, target_ip: "8.8.8.8" })).status === 400, "Internet target was accepted");
  assert((await functionRequest(adminToken, anonKey, { action: "start_inspection", runner_id: runnerId, target_ip: "10.254.253.99" })).status === 403, "Unknown non-discovery target was accepted");

  const queued = await functionRequest(adminToken, anonKey, { action: "start_inspection", runner_id: runnerId, target_ip: inventoryIp });
  assert(queued.status === 202 && queued.data?.data?.authorization_source === "inventory", "Admin inventory inspection was not queued");
  const claimed = await serviceFunction({ action: "claim_session", runner_id: runnerId });
  assert(claimed.status === 200 && claimed.data?.data?.status === "running", "Runner claim failed");
  const fingerprint = fixture(inventoryIp, "TP-Link", "Archer AX53", "high");
  const rawRejected = await serviceFunction({ action: "complete_session", runner_id: runnerId, inspection_id: claimed.data.data.inspection_id, result: { ...fingerprint, stdout: "raw scanner output" } });
  assert(rawRejected.status === 400, "Raw tool output was accepted");
  const completed = await serviceFunction({ action: "complete_session", runner_id: runnerId, inspection_id: claimed.data.data.inspection_id, result: fingerprint });
  assert(completed.status === 200 && completed.data?.data?.status === "completed", "Normalized result was not completed");
  const unchanged = await rest(`network_nodes?id=eq.${nodeId}&select=name,location,notes,detected_fingerprint`, { token: serviceKey, key: serviceKey });
  assert(unchanged.data?.[0]?.detected_fingerprint === null && unchanged.data[0].name === "Operator stable identity", "Temporary inspection changed inventory");

  const savedAt = new Date().toISOString();
  await assertRest(`network_nodes?id=eq.${nodeId}`, "PATCH", adminToken, anonKey, { detected_fingerprint: fingerprint, last_inspected_at: savedAt }, 200, "return=representation");
  const viewerSaved = await rest(`network_nodes?id=eq.${nodeId}&select=name,detected_fingerprint,last_inspected_at`, { token: viewerToken, key: anonKey });
  assert(viewerSaved.data?.[0]?.detected_fingerprint?.ip === inventoryIp, "Viewer could not read saved Device Profile");
  const viewerWrite = await rest(`network_nodes?id=eq.${nodeId}`, { method: "PATCH", token: viewerToken, key: anonKey, body: { name: "Tampered" }, prefer: "return=representation" });
  assert(viewerWrite.status >= 400 || viewerWrite.data?.length === 0, "Viewer modified operator identity");

  await assertRest("network_discovery_sessions", "POST", serviceKey, serviceKey, {
    runner_id: runnerId, requested_by: admin.id, status: "completed", phase: "scan", connection_type: "wifi",
    interface_alias: "Fixture", local_ipv4: "10.254.253.10", subnet_cidr: "10.254.253.8/29",
    total_hosts: 6, scanned_hosts: 6, found_count: 1,
    results: [{ ip_address: discoveryIp, evidence: ["icmp"], latency_ms: 1, is_this_device: false, is_gateway: false }],
    expires_at: new Date(Date.now() + 600_000).toISOString(),
  }, 201);
  const unknownQueued = await functionRequest(adminToken, anonKey, { action: "start_inspection", runner_id: runnerId, target_ip: discoveryIp });
  assert(unknownQueued.status === 202 && unknownQueued.data?.data?.authorization_source === "discovery", "Current discovery target was not authorized");
  const unknownClaim = await serviceFunction({ action: "claim_session", runner_id: runnerId });
  await serviceFunction({ action: "complete_session", runner_id: runnerId, inspection_id: unknownClaim.data.data.inspection_id, result: fixture(discoveryIp, null, null, "unknown") });
  const afterUnknown = await protectedCounts();
  assert(afterUnknown.nodes === before.nodes + 1, "Closing/temporary unknown inspection created inventory");

  const persistedSize = Buffer.byteLength(JSON.stringify(fingerprint));
  const temporarySize = Buffer.byteLength(JSON.stringify(completed.data.data.result));
  const after = await protectedCounts();
  assert(after.events === before.events && after.traffic === before.traffic, "Device inspection changed events or traffic_metrics");
  console.log(JSON.stringify({ ok: true, viewer_start_blocked: true, viewer_temp_read_blocked: true, admin_inventory_and_discovery_allowed: true,
    arbitrary_command_flags_ports_nse_uri_cidr_blocked: true, internet_target_blocked: true, raw_output_rejected: true,
    temporary_does_not_create_or_modify_inventory: true, explicit_save_and_viewer_read_verified: true, viewer_write_blocked: true,
    operator_identity_preserved: true, temporary_payload_bytes: temporarySize, persisted_fingerprint_bytes: persistedSize,
    estimated_100_saved_payload_mb: Number((persistedSize * 100 / 1024 / 1024).toFixed(3)), events_delta: 0, traffic_metrics_delta: 0 }, null, 2));
} finally {
  if (nodeId) await rest(`network_nodes?id=eq.${nodeId}`, { method: "DELETE", token: serviceKey, key: serviceKey }).catch(() => {});
  await rest(`diagnostic_runners?id=eq.${encodeURIComponent(runnerId)}`, { method: "DELETE", token: serviceKey, key: serviceKey }).catch(() => {});
  for (const id of users) await fetch(`${url}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: authHeaders(serviceKey, serviceKey) }).catch(() => {});
}

function fixture(ip, manufacturer, model, confidence) { return { schema_version: 1, ip, reachable: true, route_role: "on_link", same_subnet: true,
  network_identity: { mac: null, mac_kind: "unavailable", mac_vendor: null, tls_identity: null },
  detected_identity: { manufacturer, model, model_number: null, os_family: null, likely_label: [manufacturer, model].filter(Boolean).join(" ") || null },
  likely_device_type: model ? "router" : "unknown", capabilities: model ? ["upnp"] : [], confidence,
  observed_services: [], observed_software: [], evidence: model ? [{ source: "upnp", label: "UPnP model", value: model }] : [],
  probe_summary: { tcp_ports_checked: [22,80,443,445,554,631,1883,9100], tcp_open_count: 0, upnp_checked: true, optional_skips: ["mdns"] }, limitations: [] }; }
async function createUser(email, role) { const response = await fetch(`${url}/auth/v1/admin/users`, { method: "POST", headers: { ...authHeaders(serviceKey, serviceKey), "Content-Type": "application/json" }, body: JSON.stringify({ email, password, email_confirm: true }) }); const user = await response.json(); if (!response.ok || !user.id) throw new Error("Temporary user failed"); users.push(user.id); await assertRest(`profiles?id=eq.${user.id}`, "PATCH", serviceKey, serviceKey, { status: "approved", role, approved_at: new Date().toISOString() }, 200, "return=representation"); return { id: user.id, email }; }
async function signIn(email, passwordValue) { const response = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: anonKey, "Content-Type": "application/json" }, body: JSON.stringify({ email, password: passwordValue }) }); const data = await response.json(); if (!response.ok || !data.access_token) throw new Error("Sign-in failed"); return data.access_token; }
async function functionRequest(token, key, body) { const response = await fetch(`${url}/functions/v1/device-inspector`, { method: "POST", headers: { ...authHeaders(token, key), "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: response.status, data: await response.json().catch(() => ({})) }; }
function serviceFunction(body) { return functionRequest(serviceKey, serviceKey, body); }
async function protectedCounts() { return { nodes: await count("network_nodes"), events: await count("events"), traffic: await count("traffic_metrics") }; }
async function count(table) { const response = await fetch(`${url}/rest/v1/${table}?select=id`, { headers: { ...authHeaders(serviceKey, serviceKey), Prefer: "count=exact", Range: "0-0" } }); if (!response.ok) throw new Error(`Could not count ${table}`); return Number(response.headers.get("content-range")?.split("/")[1] ?? 0); }
async function assertRest(resource, method, token, key, body, expected, prefer) { const response = await rest(resource, { method, token, key, body, prefer }); if (response.status !== expected) throw new Error(`${method} ${resource} returned ${response.status}: ${JSON.stringify(response.data)}`); return response.data; }
async function rest(resource, { method = "GET", token, key, body, prefer } = {}) { const response = await fetch(`${url}/rest/v1/${resource}`, { method, headers: { ...authHeaders(token, key), ...(body ? { "Content-Type": "application/json" } : {}), ...(prefer ? { Prefer: prefer } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: response.status, data: response.status === 204 ? null : await response.json().catch(() => null) }; }
function authHeaders(token, key) { return { Authorization: `Bearer ${token}`, apikey: key }; }
function assert(condition, message) { if (!condition) throw new Error(message); }
function loadEnv(filename) { try { for (const raw of readFileSync(filename, "utf8").split(/\r?\n/)) { const line = raw.trim(); if (!line || line.startsWith("#")) continue; const index = line.indexOf("="); if (index < 1) continue; const key = line.slice(0, index).trim(); let value = line.slice(index + 1).trim(); if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1); if (process.env[key] === undefined) process.env[key] = value; } } catch {} }
