import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
loadEnv(path.join(root, "runner", ".env"));
loadEnv(path.join(root, "frontend", ".env.local"));
const url = (process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL)?.replace(/\/$/, "");
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
if (!url || !serviceKey || !existsSync(chromePath)) throw new Error("Browser verification prerequisites are unavailable");

const stamp = `${Date.now()}-${randomBytes(3).toString("hex")}`;
const marker = `e2e-device-profile-${stamp}`;
const runnerId = marker;
const discoveryTargetIp = "192.168.188.249";
const selfTargetIp = "192.168.112.1";
const discoverySessionId = randomUUID();
const healthTargetId = randomUUID();
const diagnosticJobId = randomUUID();
const trafficSessionId = randomUUID();
const hopId = randomUUID();
const hopSessionId = randomUUID();
const healthFixtureLatency = 43210.5;
const profilePath = path.join(root, "runner", "data", marker);
const password = `Tmp-${randomBytes(18).toString("base64url")}!`;
const adminEmail = `${marker}-admin@example.invalid`;
const viewerEmail = `${marker}-viewer@example.invalid`;
const inspectionIds = [];
let healthFixtureCreated = false;
let adminId = null;
let viewerId = null;
let chrome = null;
let cdp = null;
let before = null;
let discoveryNode = null;
let selfNode = null;
let outcome = null;
let primaryError = null;
let cleanupError = null;
let cleanup = null;
let fixtureVisibility = null;

if (process.argv[2] === "--audit-fixtures") {
  console.log(JSON.stringify(await auditFixtureResidue(), null, 2));
  process.exit(0);
}
if (process.argv[2] === "--close-profile") {
  await closeExactE2EProfile(process.argv[3]);
  process.exit(0);
}

try {
  [discoveryNode, selfNode] = await Promise.all([existingNode(discoveryTargetIp), existingNode(selfTargetIp)]);
  assert((await get(`network_targets?node_id=eq.${discoveryNode.id}&enabled=eq.true&select=id`)).length > 0, "Authorized target is not available in Health Watch");
  before = await operationalSnapshot();
  adminId = await createUser(adminEmail, password, "admin");
  viewerId = await createUser(viewerEmail, password, "viewer");
  await createFixtures();
  fixtureVisibility = await verifyFixtureVisibility();
  assert(fixtureVisibility.directRest, "Admin fixture cannot read its hop fixture through RLS");
  assert(fixtureVisibility.diagnosticsFunction, `Diagnostics function omitted hop fixture (direct_rest=${fixtureVisibility.directRest})`);

  chrome = spawn(chromePath, ["--headless=new", "--window-size=1440,1000", "--remote-debugging-port=0", `--user-data-dir=${profilePath}`, "--no-first-run", "--disable-gpu", "about:blank"], { windowsHide: true, shell: false, stdio: "ignore" });
  const port = await waitDevtoolsPort(profilePath);
  const page = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent("http://localhost:3000/login")}`, { method: "PUT" }).then(expectJson);
  cdp = new Devtools(page.webSocketDebuggerUrl);
  await cdp.open(); await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
  await login(cdp, adminEmail, password);

  // Discovery opens the shared profile; active inspection remains an explicit click.
  await waitFor(cdp, `document.body.innerText.includes('Discover Network')`, 20_000);
  await waitFor(cdp, `(() => { const button=[...document.querySelectorAll('button')].find((item)=>item.textContent.trim()==='Discover Network');return button&&Object.keys(button).some((key)=>key.startsWith('__reactProps')); })()`, 20_000);
  await clickExactButton(cdp, "Discover Network");
  await waitFor(cdp, `document.querySelector('[aria-label="Network Discovery"]') !== null`, 10_000);
  await selectRunner(cdp);
  await waitFor(cdp, `document.body.innerText.includes(${JSON.stringify(discoveryTargetIp)})`, 15_000);
  const beforeExplicitInspect = await inspectionSessionCount();
  await clickButtonInRow(cdp, discoveryTargetIp, "Detail");
  await waitFor(cdp, `document.querySelector('[aria-label="Device Profile ${discoveryTargetIp}"]') !== null`, 10_000);
  assert(await inspectionSessionCount() === beforeExplicitInspect, "Opening Discovery profile auto-started Inspect");
  await refreshFixtureRunner();
  await clickExactButton(cdp, discoveryNode.detected_fingerprint ? "Inspect again" : "Inspect");
  inspectionIds.push(await completeQueuedInspection(discoveryTargetIp, regularFingerprint(discoveryTargetIp)));
  await waitFor(cdp, `document.body.innerText.includes('Bounded Windows endpoint') && document.body.innerText.includes('Inspection evidence')`, 15_000);
  assert(await cdp.evaluate(`location.pathname`) === "/dashboard", "Discovery profile required navigation");

  // Health opens the same shared profile and must not offer duplicate monitoring.
  await navigate(cdp, "/dashboard");
  await waitFor(cdp, `document.body.innerText.includes(${JSON.stringify(discoveryNode.name)})`, 20_000);
  await waitFor(cdp, `(() => { const item=[...document.querySelectorAll('tr,button')].find((node)=>node.textContent.includes(${JSON.stringify(discoveryTargetIp)})&&node.getClientRects().length);return item&&Object.keys(item).some((key)=>key.startsWith('__reactProps')); })()`, 20_000);
  const adminHealthClick = await clickContainer(cdp, discoveryTargetIp);
  try { await waitFor(cdp, `document.body.innerText.includes('View Device Profile')`, 10_000); }
  catch { throw new Error(`Health detail did not open: ${JSON.stringify({ click: adminHealthClick, dialogs: await dialogLabels(cdp) })}`); }
  await clickExactButton(cdp, "View Device Profile");
  await waitFor(cdp, `document.querySelector('[aria-label="Device Profile ${discoveryTargetIp}"]') !== null`, 10_000);
  await waitFor(cdp, `document.body.innerText.includes('View Health Status')`, 10_000);
  const monitoredProfile = await cdp.evaluate(`document.querySelector('[aria-label="Device Profile ${discoveryTargetIp}"]').innerText`);
  assert(!monitoredProfile.includes("Add to Health Watch"), "Already-monitored target offered duplicate Health promotion");
  assert(await cdp.evaluate(`location.pathname`) === "/dashboard", "Health profile required navigation");

  await clickButtonInDialog(cdp, `Device Profile ${discoveryTargetIp}`, "Tutup");
  await waitFor(cdp, `document.querySelector('[aria-label="Device Profile ${discoveryTargetIp}"]') === null`, 10_000);
  await clickHealthFixtureRow(cdp, selfTargetIp, `${healthFixtureLatency.toFixed(1)} ms`);
  await waitFor(cdp, `document.body.innerText.includes('View Device Profile')`, 10_000);
  await clickExactButton(cdp, "View Device Profile");
  await waitFor(cdp, `document.querySelector('[aria-label="Device Profile ${selfTargetIp}"]') !== null`, 10_000);
  await refreshFixtureRunner();
  await clickExactButton(cdp, selfNode.detected_fingerprint ? "Inspect again" : "Inspect");
  inspectionIds.push(await completeQueuedInspection(selfTargetIp, selfFingerprint(selfTargetIp)));
  await waitFor(cdp, `document.body.innerText.includes('This Device') && document.body.innerText.includes('virtual')`, 15_000);

  // Traffic and stored MTR data only open profiles; neither starts inspection.
  const beforePassive = await inspectionSessionCount();
  await navigate(cdp, "/traffic");
  await waitFor(cdp, `document.body.innerText.includes(${JSON.stringify(discoveryNode.name)})`, 20_000);
  await clickButtonInContainer(cdp, discoveryTargetIp, discoveryNode.name);
  await waitFor(cdp, `document.querySelector('[aria-label="Device Profile ${discoveryTargetIp}"]') !== null`, 10_000);
  assert(await cdp.evaluate(`location.pathname`) === "/traffic", "Traffic profile required navigation");
  assert(await inspectionSessionCount() === beforePassive, "Traffic auto-started Device Inspect");

  await navigate(cdp, "/diagnostics");
  await selectOptionValue(cdp, marker);
  await waitFor(cdp, `document.body.innerText.includes(${JSON.stringify(hopSessionId.slice(0, 8))})`, 20_000);
  await clickButtonInContainer(cdp, hopSessionId.slice(0, 8), "Lihat path");
  await clickButtonInContainer(cdp, discoveryTargetIp, "View device");
  await waitFor(cdp, `document.querySelector('[aria-label="Device Profile ${discoveryTargetIp}"]') !== null`, 10_000);
  assert(await cdp.evaluate(`location.pathname`) === "/diagnostics", "LAN hop profile required navigation");
  assert(await inspectionSessionCount() === beforePassive, "MTR/hop auto-started Device Inspect");

  // A separate approved viewer can read but has no active/profile mutation controls.
  await clickExactButton(cdp, "Tutup"); await clickExactButton(cdp, "Keluar");
  await waitFor(cdp, `location.pathname === '/login'`, 20_000);
  await login(cdp, viewerEmail, password);
  await waitFor(cdp, `document.body.innerText.includes(${JSON.stringify(discoveryNode.name)})`, 20_000);
  await waitFor(cdp, `(() => { const item=[...document.querySelectorAll('tr,button')].find((node)=>node.textContent.includes(${JSON.stringify(discoveryTargetIp)})&&node.getClientRects().length);return item&&Object.keys(item).some((key)=>key.startsWith('__reactProps')); })()`, 20_000);
  const viewerHealthClick = await clickContainer(cdp, discoveryTargetIp);
  try { await waitFor(cdp, `document.body.innerText.includes('View Device Profile')`, 10_000); }
  catch { throw new Error(`Viewer Health detail did not open: ${JSON.stringify({ click: viewerHealthClick, dialogs: await dialogLabels(cdp) })}`); }
  await clickExactButton(cdp, "View Device Profile");
  await waitFor(cdp, `document.querySelector('[aria-label="Device Profile ${discoveryTargetIp}"]') !== null`, 10_000);
  const viewerProfile = await cdp.evaluate(`document.querySelector('[aria-label="Device Profile ${discoveryTargetIp}"]').innerText`);
  assert(viewerProfile.includes(discoveryNode.name), "Viewer could not read saved profile");
  const viewerControls = await cdp.evaluate(`[...document.querySelector('[aria-label="Device Profile ${discoveryTargetIp}"]').querySelectorAll('button')].map((button)=>button.textContent.trim())`);
  assert(!viewerControls.some((label) => ["Inspect", "Inspect again", "Save identity", "Save detected evidence", "Add to Health Watch"].includes(label)), "Viewer profile exposed admin controls");

  const desktop = await cdp.evaluate(`({overflow:document.documentElement.scrollWidth>window.innerWidth,width:window.innerWidth})`);
  assert(!desktop.overflow && desktop.width >= 1000, "Desktop profile has horizontal overflow");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  const mobile = await cdp.evaluate(`({dialog:!!document.querySelector('[aria-label="Device Profile ${discoveryTargetIp}"]'),overflow:document.documentElement.scrollWidth>window.innerWidth})`);
  assert(mobile.dialog && !mobile.overflow, "Mobile profile has horizontal overflow");

  const during = await operationalSnapshot();
  assert(during.events === before.events, "Browser E2E changed events");
  assert(during.traffic_metrics === before.traffic_metrics, "Browser E2E changed traffic_metrics");
  outcome = {
    ok: true, fixture_marker: marker,
    fixture_ids: { admin_user: adminId, viewer_user: viewerId, runner: runnerId, discovery_session: discoverySessionId, inspections: inspectionIds, health_target: healthTargetId, health_latest: healthTargetId, health_event: null, diagnostic_job: diagnosticJobId, traffic_session: trafficSessionId, hop_measurement: hopId, hop_session: hopSessionId },
    discovery_profile: true, health_profile_and_duplicate_guard: true,
    traffic_profile_without_auto_inspect: true, lan_hop_profile_without_auto_inspect: true,
    admin_active_inspect: true, viewer_saved_profile_read_only: true,
    self_device_virtual_interface: true, desktop_no_horizontal_overflow: true,
    mobile_no_horizontal_overflow: true, active_network_probe_started: false,
    packet_capture_started: false, iperf_or_mtr_started: false,
    events_delta: during.events - before.events,
    traffic_metrics_delta: during.traffic_metrics - before.traffic_metrics,
    fixture_visibility: fixtureVisibility,
  };
} catch (error) { primaryError = error; }
finally {
  try {
    if (cdp) await cdp.send("Browser.close").catch(() => {});
    cdp?.close();
    if (chrome) { chrome.kill(); await Promise.race([new Promise((resolve) => chrome.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 3_000))]); }
    cleanup = await cleanupFixtures();
    if (path.resolve(profilePath).startsWith(path.join(root, "runner", "data") + path.sep)) {
      for (let attempt = 0; attempt < 5; attempt += 1) { try { rmSync(profilePath, { recursive: true, force: true }); break; } catch { await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1))); } }
    }
  } catch (error) { cleanupError = error; }
}

if (cleanupError) throw cleanupError;
if (primaryError) {
  console.error(JSON.stringify({ ok: false, cleanup }, null, 2));
  throw primaryError;
}
console.log(JSON.stringify({ ...outcome, cleanup }, null, 2));

async function createFixtures() {
  const now = new Date().toISOString();
  await rest("diagnostic_runners", "POST", { id: runnerId, display_name: `${marker} DB-only runner`, last_seen_at: now, health_status: "online", health_error_code: null, capabilities: { fixture_marker: marker, source_locations: [marker], targets: [{ id: `${marker}-target`, label: discoveryNode.name, host: discoveryTargetIp, iperf_port: 5201, environment: "lan" }], durations: [5], operations: ["network_discovery", "device_inspect", "traffic_live", "bandwidth_and_path"], traffic_durations_seconds: [300], device_inspector: { available: true, probe_engine: "python_socket" } } });
  await rest("diagnostic_jobs", "POST", { id: diagnosticJobId, runner_id: runnerId, requested_by: adminId, status: "completed", type: "bandwidth_and_path", source_label: marker, target_id: `${marker}-target`, target_label: discoveryNode.name, target_host: discoveryTargetIp, iperf_port: 5201, connection_type: "wifi", duration_seconds: 5, environment: "lan", stage: "complete", progress: {}, created_at: now, started_at: now, completed_at: now, updated_at: now });
  await rest("network_discovery_sessions", "POST", { runner_id: runnerId, session_id: discoverySessionId, requested_by: adminId, status: "completed", phase: "scan", connection_type: "wifi", interface_alias: `${marker} synthetic`, local_ipv4: "192.168.188.180", subnet_cidr: "192.168.188.0/24", total_hosts: 254, scanned_hosts: 254, found_count: 2, results: [{ ip_address: discoveryTargetIp, evidence: ["fixture"], latency_ms: 1.2, is_this_device: false, is_gateway: false }, { ip_address: selfTargetIp, evidence: ["fixture"], latency_ms: 0.2, is_this_device: true, is_gateway: false }], created_at: now, started_at: now, completed_at: now, expires_at: new Date(Date.now() + 600_000).toISOString(), updated_at: now });
  await rest("network_targets", "POST", { id: healthTargetId, node_id: selfNode.id, runner_id: runnerId, enabled: true, critical: false, probe_method: "icmp", probe_interval_seconds: 3600, timeout_ms: 1000, failure_threshold: 10, recovery_threshold: 5, latency_warning_ms: 60000, loss_warning_percent: 100, created_by: adminId, created_at: now, updated_at: now });
  healthFixtureCreated = true;
  await rest("network_health_latest", "POST", { target_id: healthTargetId, status: "online", latency_ms: healthFixtureLatency, packet_loss_percent: 0, last_checked_at: now, last_success_at: now, consecutive_failures: 0, sample_count: 1, updated_at: now });
  await rest("traffic_live_sessions", "POST", { id: trafficSessionId, runner_id: runnerId, requested_by: adminId, status: "completed", duration_seconds: 300, capture_scope: "this_device", stage: "complete", created_at: now, started_at: now, completed_at: now, updated_at: now });
  const flow = { flow_key: `${marker}-flow`, src_ip: discoveryTargetIp, dst_ip: "192.168.188.180", src_port: 445, dst_port: 53000, protocol: "tcp", service: "SMB", first_seen: now, last_seen: now, total_bytes: 4096, packet_count: 8, bytes_delta: 4096, packets_delta: 8, packets_per_second: 2, rate_mbps: 0.1, peak_rate_mbps: 0.1, rate_trend: "stable", status: "active" };
  await rest("traffic_live_snapshots", "POST", { runner_id: runnerId, session_id: trafficSessionId, captured_at: now, summary: { observed_tx_mbps: 0.1, observed_rx_mbps: 0.1, packets_observed: 8, packets_per_second: 2, active_flows: 1, dominant_protocol: "tcp" }, flows: [flow], conversations: [], top_talkers: [{ ip: discoveryTargetIp, rate_mbps: 0.1, total_bytes: 4096, active_flows: 1 }], payload_bytes: 800, updated_at: now });
  await rest("hop_measurements", "POST", { id: hopId, session_id: hopSessionId, source_label: marker, target_label: discoveryNode.name, target_host: discoveryTargetIp, connection_type: "wifi", hop_number: 1, hop_ip: discoveryTargetIp, avg_latency_ms: 1.2, loss_percent: 0, measured_at: now, job_id: diagnosticJobId, environment: "lan" });
}

async function completeQueuedInspection(targetIp, fingerprint) {
  const queued = await waitSession(targetIp, (row) => row.status === "queued", 15_000);
  const claimed = await fn({ action: "claim_session", runner_id: runnerId });
  assert(claimed.data?.data?.inspection_id === queued.inspection_id, "Service-role claim selected wrong fixture");
  await fn({ action: "update_stage", runner_id: runnerId, inspection_id: queued.inspection_id, stage: "services" });
  await fn({ action: "complete_session", runner_id: runnerId, inspection_id: queued.inspection_id, result: fingerprint });
  return queued.inspection_id;
}

function regularFingerprint(ip) { return { schema_version: 1, ip, reachable: true, route_role: "on_link", same_subnet: true, network_context: { is_this_device: false, automated_role: null, interface_index: 20, interface_alias: "Wi-Fi", interface_description: "Synthetic browser evidence", interface_type: "physical" }, network_identity: { mac: null, mac_kind: "unavailable", mac_vendor: null, tls_identity: null }, detected_identity: { manufacturer: null, model: null, model_number: null, os_family: "Windows", likely_label: "Bounded Windows endpoint" }, likely_device_type: "workstation", capabilities: [], confidence: "medium", observed_services: [{ name: "SMB", protocol: "tcp", port: 445 }], observed_software: [], evidence: [{ source: "fixture", label: "Inspection evidence", value: "Normalized browser E2E result" }], probe_summary: { tcp_ports_checked: [22, 80, 443, 445, 554, 631, 1883, 8080, 8443, 9100], tcp_open_count: 1, upnp_checked: true, optional_skips: ["mdns"] }, limitations: ["Controlled result; no network probe executed."] }; }
function selfFingerprint(ip) { return { schema_version: 1, ip, reachable: true, route_role: "on_link", same_subnet: true, network_context: { is_this_device: true, automated_role: "this_device", interface_index: 62, interface_alias: "vEthernet (WSL (Hyper-V firewall)) 2", interface_description: "Hyper-V Virtual Ethernet Adapter #2", interface_type: "virtual" }, network_identity: { mac: null, mac_kind: "unavailable", mac_vendor: null, tls_identity: null }, detected_identity: { manufacturer: null, model: null, model_number: null, os_family: "Windows", likely_label: "Local Windows virtual interface" }, likely_device_type: "unknown", capabilities: ["local_host", "virtual_interface"], confidence: "high", observed_services: [], observed_software: [], evidence: [{ source: "network_context", label: "Automated network role", value: "This Device" }, { source: "network_context", label: "Windows interface", value: "vEthernet (WSL / Hyper-V) · virtual" }], probe_summary: { tcp_ports_checked: [22, 80, 443, 445, 554, 631, 1883, 8080, 8443, 9100], tcp_open_count: 0, upnp_checked: true, optional_skips: ["mdns"] }, limitations: ["Controlled result; no network probe executed."] }; }

async function cleanupFixtures() {
  const ownedRows = adminId ? await get(`device_inspection_sessions?requested_by=eq.${adminId}&select=runner_id,inspection_id`) : [];
  for (const row of ownedRows) if (!inspectionIds.includes(row.inspection_id)) inspectionIds.push(row.inspection_id);
  for (const row of ownedRows) await remove(`device_inspection_sessions?runner_id=eq.${encodeURIComponent(row.runner_id)}&inspection_id=eq.${row.inspection_id}`);
  const queuedRows = await get(`device_inspection_sessions?runner_id=eq.${encodeURIComponent(runnerId)}&select=inspection_id`);
  for (const row of queuedRows) if (!inspectionIds.includes(row.inspection_id)) inspectionIds.push(row.inspection_id);
  for (const id of inspectionIds) await remove(`device_inspection_sessions?runner_id=eq.${encodeURIComponent(runnerId)}&inspection_id=eq.${id}`);
  await remove(`traffic_live_snapshots?runner_id=eq.${encodeURIComponent(runnerId)}&session_id=eq.${trafficSessionId}`);
  await remove(`traffic_live_sessions?id=eq.${trafficSessionId}`);
  if (healthFixtureCreated) {
    await remove(`network_health_latest?target_id=eq.${healthTargetId}`);
    await remove(`network_targets?id=eq.${healthTargetId}`);
  }
  await remove(`hop_measurements?id=eq.${hopId}`);
  await remove(`diagnostic_jobs?id=eq.${diagnosticJobId}`);
  await remove(`network_discovery_sessions?runner_id=eq.${encodeURIComponent(runnerId)}&session_id=eq.${discoverySessionId}`);
  await remove(`diagnostic_runners?id=eq.${encodeURIComponent(runnerId)}`);
  if (adminId) await removeUser(adminId);
  if (viewerId) await removeUser(viewerId);
  const checks = { admin_user: adminId ? await userAbsent(adminId) : true, viewer_user: viewerId ? await userAbsent(viewerId) : true, runner: await absent(`diagnostic_runners?id=eq.${encodeURIComponent(runnerId)}&select=id`), discovery_session: await absent(`network_discovery_sessions?runner_id=eq.${encodeURIComponent(runnerId)}&session_id=eq.${discoverySessionId}&select=session_id`), inspection_sessions: (await Promise.all(inspectionIds.map((id) => absent(`device_inspection_sessions?inspection_id=eq.${id}&select=inspection_id`)))).every(Boolean), health_target: healthFixtureCreated ? await absent(`network_targets?id=eq.${healthTargetId}&select=id`) : true, health_latest: healthFixtureCreated ? await absent(`network_health_latest?target_id=eq.${healthTargetId}&select=target_id`) : true, health_event_fixture: true, diagnostic_job: await absent(`diagnostic_jobs?id=eq.${diagnosticJobId}&select=id`), traffic_session: await absent(`traffic_live_sessions?id=eq.${trafficSessionId}&select=id`), traffic_snapshot: await absent(`traffic_live_snapshots?runner_id=eq.${encodeURIComponent(runnerId)}&session_id=eq.${trafficSessionId}&select=session_id`), hop_measurement: await absent(`hop_measurements?id=eq.${hopId}&select=id`) };
  assert(Object.values(checks).every(Boolean), `Fixture cleanup failed: ${Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name).join(", ")}`);
  if (before) assert(JSON.stringify(await operationalSnapshot()) === JSON.stringify(before), "Operational counts changed after cleanup");
  if (discoveryNode) assert(JSON.stringify(await existingNode(discoveryTargetIp)) === JSON.stringify(discoveryNode), "Existing discovery node was modified");
  if (selfNode) assert(JSON.stringify(await existingNode(selfTargetIp)) === JSON.stringify(selfNode), "Existing self node was modified");
  return { verified: true, checks, operational_counts_restored: true };
}

async function operationalSnapshot() { const tables = ["events", "traffic_metrics", "flows", "network_nodes", "network_targets", "diagnostic_runners", "diagnostic_jobs", "hop_measurements", "traffic_live_sessions", "traffic_live_snapshots", "device_inspection_sessions"]; const values = await Promise.all(tables.map(count)); return Object.fromEntries(tables.map((table, index) => [table, values[index]])); }
async function existingNode(ip) { const rows = await get(`network_nodes?ip_address=eq.${encodeURIComponent(ip)}&select=id,ip_address,name,device_type,location,notes,detected_fingerprint,last_inspected_at,created_by,created_at,updated_at`); if (rows.length !== 1) throw new Error(`Existing authorized inventory target unavailable: ${ip}`); return rows[0]; }
async function createUser(email, userPassword, role) { const response = await fetch(`${url}/auth/v1/admin/users`, { method: "POST", headers: { ...headers(), "Content-Type": "application/json" }, body: JSON.stringify({ email, password: userPassword, email_confirm: true }) }); const user = await response.json(); if (!response.ok || !user.id) throw new Error(`Could not create ${role} fixture`); if (role === "admin") adminId = user.id; else viewerId = user.id; await rest(`profiles?id=eq.${user.id}`, "PATCH", { status: "approved", role, approved_at: new Date().toISOString() }); return user.id; }
async function verifyFixtureVisibility() {
  const loginResponse = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: serviceKey, "Content-Type": "application/json" }, body: JSON.stringify({ email: adminEmail, password }) });
  const loginData = await loginResponse.json();
  if (!loginResponse.ok || !loginData.access_token) throw new Error("Fixture visibility login failed");
  const userHeaders = { Authorization: `Bearer ${loginData.access_token}`, apikey: serviceKey };
  const [directResponse, functionResponse] = await Promise.all([
    fetch(`${url}/rest/v1/hop_measurements?id=eq.${hopId}&select=id`, { headers: userHeaders }),
    fetch(`${url}/functions/v1/diagnostics`, { headers: userHeaders }),
  ]);
  const directRows = await directResponse.json();
  const functionData = await functionResponse.json();
  return { directRest: directResponse.ok && Array.isArray(directRows) && directRows.some((row) => row.id === hopId), diagnosticsFunction: functionResponse.ok && Array.isArray(functionData?.data?.hops) && functionData.data.hops.some((row) => row.id === hopId), diagnosticsStatus: functionResponse.status };
}
async function login(client, email, userPassword) { await waitFor(client, `(() => { const form=document.querySelector('form');const input=document.querySelector('input[name="email"]');return form&&input&&Object.keys(form).some((key)=>key.startsWith('__reactProps')); })()`, 20_000); await client.evaluate(`(() => { const set=(selector,value)=>{const input=document.querySelector(selector);const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));};set('input[name="email"]',${JSON.stringify(email)});set('input[name="password"]',${JSON.stringify(userPassword)});document.querySelector('form').requestSubmit(); })()`); try { await waitFor(client, `location.pathname === '/dashboard' || (document.body.innerText.includes('NETWORK OPERATIONS') && document.body.innerText.includes('Keluar'))`, 30_000); } catch { const debug=await client.evaluate(`({pathname:location.pathname,body:document.body.innerText.slice(0,500)})`); throw new Error(`Fixture login did not reach authenticated shell: ${JSON.stringify(debug)}`); } if (await client.evaluate(`location.pathname`) !== "/dashboard") await navigate(client, "/dashboard"); }
async function selectRunner(client) { await client.evaluate(`(() => { const select=[...document.querySelectorAll('select')].find((item)=>[...item.options].some((option)=>option.value===${JSON.stringify(runnerId)}));if(!select)throw new Error('Fixture runner missing');const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;setter.call(select,${JSON.stringify(runnerId)});select.dispatchEvent(new Event('change',{bubbles:true})); })()`); }
async function selectOptionValue(client, value) {
  try { await waitFor(client, `(() => { const select=[...document.querySelectorAll('select')].find((item)=>[...item.options].some((option)=>option.value===${JSON.stringify(value)}));return select&&Object.keys(select).some((key)=>key.startsWith('__reactProps')); })()`, 20_000); }
  catch {
    const debug = await client.evaluate(`({pathname:location.pathname,title:document.title,heading:document.querySelector('h1')?.textContent??null,body:document.body.innerText.slice(0,500),loadError:document.body.innerText.includes('Data diagnostik gagal dimuat'),selects:[...document.querySelectorAll('select')].map((item)=>({label:item.closest('label')?.textContent?.trim().slice(0,80)??null,options:[...item.options].map((option)=>option.value).slice(0,20),hydrated:Object.keys(item).some((key)=>key.startsWith('__reactProps'))}))})`);
    throw new Error(`Fixture filter option unavailable: ${JSON.stringify(debug)}`);
  }
  await client.evaluate(`(() => { const select=[...document.querySelectorAll('select')].find((item)=>[...item.options].some((option)=>option.value===${JSON.stringify(value)}));if(!select)throw new Error('Fixture filter option missing');const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;setter.call(select,${JSON.stringify(value)});select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
}
async function clickButtonInContainer(client, text, buttonText) {
  const visibleAction = `(() => { const containers=[...document.querySelectorAll('tr,article,div')].filter((item)=>item.getClientRects().length&&item.textContent.includes(${JSON.stringify(text)})&&[...item.querySelectorAll('button')].some((button)=>button.getClientRects().length&&button.textContent.includes(${JSON.stringify(buttonText)})));const button=containers.flatMap((item)=>[...item.querySelectorAll('button')]).find((item)=>item.getClientRects().length&&item.textContent.includes(${JSON.stringify(buttonText)}));return button&&Object.keys(button).some((key)=>key.startsWith('__reactProps')); })()`;
  await waitFor(client, visibleAction, 20_000);
  return client.evaluate(`(() => { const containers=[...document.querySelectorAll('tr,article,div')].filter((item)=>item.getClientRects().length&&item.textContent.includes(${JSON.stringify(text)})&&[...item.querySelectorAll('button')].some((button)=>button.getClientRects().length&&button.textContent.includes(${JSON.stringify(buttonText)}))).sort((a,b)=>a.textContent.length-b.textContent.length);const container=containers[0];const button=container&&[...container.querySelectorAll('button')].find((item)=>item.getClientRects().length&&item.textContent.includes(${JSON.stringify(buttonText)}));if(!button)throw new Error('Fixture action missing');const result={container:container.textContent.trim().slice(0,240),button:button.textContent.trim()};button.click();return result; })()`);
}
async function clickButtonInRow(client, text, buttonText) {
  const action = `(() => { const row=[...document.querySelectorAll('tr,article')].find((item)=>item.getClientRects().length&&item.textContent.includes(${JSON.stringify(text)})&&[...item.querySelectorAll('button')].some((button)=>button.getClientRects().length&&button.textContent.includes(${JSON.stringify(buttonText)})));const button=row&&[...row.querySelectorAll('button')].find((item)=>item.getClientRects().length&&item.textContent.includes(${JSON.stringify(buttonText)}));return button&&Object.keys(button).some((key)=>key.startsWith('__reactProps')); })()`;
  await waitFor(client, action, 20_000);
  return client.evaluate(`(() => { const row=[...document.querySelectorAll('tr,article')].find((item)=>item.getClientRects().length&&item.textContent.includes(${JSON.stringify(text)})&&[...item.querySelectorAll('button')].some((button)=>button.getClientRects().length&&button.textContent.includes(${JSON.stringify(buttonText)})));const button=row&&[...row.querySelectorAll('button')].find((item)=>item.getClientRects().length&&item.textContent.includes(${JSON.stringify(buttonText)}));if(!button)throw new Error('Fixture row action missing');const result={container:row.textContent.trim().slice(0,240),button:button.textContent.trim()};button.click();return result; })()`);
}
async function clickContainer(client, ip) { return client.evaluate(`(() => { const items=[...document.querySelectorAll('tr,button')].filter((node)=>node.textContent.includes(${JSON.stringify(ip)})&&node.getClientRects().length).sort((a,b)=>a.textContent.length-b.textContent.length);const item=items[0];if(!item)throw new Error('Fixture container missing');const reactKey=Object.keys(item).find((entry)=>entry.startsWith('__reactProps'));const result={tag:item.tagName,text:item.textContent.trim().slice(0,240),candidateCount:items.length,hasReactProps:Boolean(reactKey),hasOnClick:Boolean(reactKey&&item[reactKey]?.onClick)};item.scrollIntoView({block:'center'});item.click();return result; })()`); }
async function clickHealthFixtureRow(client, ip, latency) {
  const rowReady = `(() => { const row=[...document.querySelectorAll('tr')].find((item)=>item.getClientRects().length&&item.textContent.includes(${JSON.stringify(ip)})&&item.textContent.includes(${JSON.stringify(latency)}));return row&&Object.keys(row).some((key)=>key.startsWith('__reactProps')); })()`;
  await waitFor(client, rowReady, 20_000);
  await client.evaluate(`(() => { const row=[...document.querySelectorAll('tr')].find((item)=>item.getClientRects().length&&item.textContent.includes(${JSON.stringify(ip)})&&item.textContent.includes(${JSON.stringify(latency)}));if(!row)throw new Error('Health fixture row missing');row.click(); })()`);
}
async function dialogLabels(client) { return client.evaluate(`[...document.querySelectorAll('[role="dialog"]')].map((item)=>item.getAttribute('aria-label'))`); }
async function clickButtonInDialog(client, label, text) { await client.evaluate(`(() => { const dialog=document.querySelector('[aria-label="'+${JSON.stringify(label)}+'"]');const button=dialog&&[...dialog.querySelectorAll('button')].find((item)=>item.textContent.trim()===${JSON.stringify(text)});if(!button)throw new Error('Dialog button missing');button.click(); })()`); }
async function clickExactButton(client, text) { await client.evaluate(`(() => { const button=[...document.querySelectorAll('button')].find((item)=>item.textContent.trim()===${JSON.stringify(text)});if(!button)throw new Error('Button missing');const key=Object.keys(button).find((item)=>item.startsWith('__reactProps'));const handler=key&&button[key]?.onClick;if(typeof handler==='function')handler({currentTarget:button,target:button,preventDefault(){},stopPropagation(){}});else button.click(); })()`); }
async function navigate(client, pathname) { const previousDocument = await client.evaluate(`performance.timeOrigin`); await client.send("Page.navigate", { url: `http://localhost:3000${pathname}` }); await waitFor(client, `location.pathname === ${JSON.stringify(pathname)} && performance.timeOrigin !== ${JSON.stringify(previousDocument)}`, 20_000); }
async function refreshFixtureRunner() { await rest(`diagnostic_runners?id=eq.${encodeURIComponent(runnerId)}`, "PATCH", { last_seen_at: new Date().toISOString(), health_status: "online", health_error_code: null }); }
async function waitSession(target, predicate, timeout) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const rows = await get(`device_inspection_sessions?runner_id=eq.${encodeURIComponent(runnerId)}&target_ip=eq.${encodeURIComponent(target)}&select=*`); if (rows[0] && predicate(rows[0])) return rows[0]; await new Promise((resolve) => setTimeout(resolve, 250)); } throw new Error("Inspection session timeout"); }
async function inspectionSessionCount() { return (await get(`device_inspection_sessions?runner_id=eq.${encodeURIComponent(runnerId)}&select=inspection_id`)).length; }
async function count(table) { const response = await fetch(`${url}/rest/v1/${table}?select=*`, { method: "HEAD", headers: { ...headers(), Prefer: "count=exact" } }); if (!response.ok) throw new Error(`Count failed for ${table}`); return Number(response.headers.get("content-range")?.split("/")[1] ?? 0); }
async function rest(resource, method, body) { const response = await fetch(`${url}/rest/v1/${resource}`, { method, headers: { ...headers(), "Content-Type": "application/json", Prefer: "return=representation" }, body: JSON.stringify(body) }); if (!response.ok) throw new Error(`Fixture write failed for ${resource}: HTTP ${response.status}`); return response.status === 204 ? null : response.json(); }
async function get(resource) { const response = await fetch(`${url}/rest/v1/${resource}`, { headers: headers() }); if (!response.ok) throw new Error(`Fixture read failed: HTTP ${response.status}`); return response.json(); }
async function remove(resource) { const response = await fetch(`${url}/rest/v1/${resource}`, { method: "DELETE", headers: headers() }); if (!response.ok) throw new Error(`Exact cleanup failed: HTTP ${response.status}`); }
async function absent(resource) { return (await get(resource)).length === 0; }
async function removeUser(id) { const response = await fetch(`${url}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: headers() }); if (!response.ok) throw new Error("Exact user cleanup failed"); }
async function userAbsent(id) { const response = await fetch(`${url}/auth/v1/admin/users/${id}`, { headers: headers() }); return response.status === 404; }
async function fn(body) { const response = await fetch(`${url}/functions/v1/device-inspector`, { method: "POST", headers: { ...headers(), "Content-Type": "application/json" }, body: JSON.stringify(body) }); const data = await response.json(); if (!response.ok) throw new Error(`Inspector lifecycle failed: HTTP ${response.status}`); return { status: response.status, data }; }
function headers() { return { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey }; }

async function auditFixtureResidue() {
  const pattern = "like.e2e-device-profile-*";
  const [runners, jobs, discovery, inspections, trafficSessions, trafficSnapshots, hops, usersResponse] = await Promise.all([
    get(`diagnostic_runners?id=${pattern}&select=id`),
    get(`diagnostic_jobs?runner_id=${pattern}&select=id,runner_id`),
    get(`network_discovery_sessions?runner_id=${pattern}&select=runner_id,session_id`),
    get(`device_inspection_sessions?runner_id=${pattern}&select=runner_id,inspection_id`),
    get(`traffic_live_sessions?runner_id=${pattern}&select=id,runner_id`),
    get(`traffic_live_snapshots?runner_id=${pattern}&select=runner_id,session_id`),
    get(`hop_measurements?source_label=${pattern}&select=id,session_id`),
    fetch(`${url}/auth/v1/admin/users?page=1&per_page=1000`, { headers: headers() }).then(expectApiJson),
  ]);
  const users = (usersResponse.users ?? []).filter((user) => typeof user.email === "string" && user.email.startsWith("e2e-device-profile-")).map((user) => ({ id: user.id, email_marker: user.email.split("@")[0] }));
  const result = { clean: [runners, jobs, discovery, inspections, trafficSessions, trafficSnapshots, hops, users].every((rows) => rows.length === 0), runners, diagnostic_jobs: jobs, discovery, inspections, traffic_sessions: trafficSessions, traffic_snapshots: trafficSnapshots, hops, users };
  return result;
}

async function closeExactE2EProfile(input) {
  const dataRoot = path.resolve(root, "runner", "data");
  const target = path.resolve(String(input ?? ""));
  if (!target.startsWith(dataRoot + path.sep) || !path.basename(target).startsWith("e2e-device-profile-") || !existsSync(target)) throw new Error("Refusing non-E2E or missing profile path");
  try {
    const port = Number(readFileSync(path.join(target, "DevToolsActivePort"), "utf8").split(/\r?\n/)[0]);
    const version = await fetch(`http://127.0.0.1:${port}/json/version`).then(expectJson);
    const browser = new Devtools(version.webSocketDebuggerUrl);
    await browser.open(); await browser.send("Browser.close").catch(() => {}); browser.close();
  } catch {}
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try { rmSync(target, { recursive: true, force: true }); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1))); }
  }
  if (existsSync(target)) throw new Error("Exact E2E profile cleanup failed");
  console.log(JSON.stringify({ cleaned: true, profile: path.basename(target) }));
}

async function expectApiJson(response) { if (!response.ok) throw new Error(`API audit failed: HTTP ${response.status}`); return response.json(); }

function Devtools(ws) { this.nextId = 1; this.pending = new Map(); this.open = () => new Promise((resolve, reject) => { this.socket = new WebSocket(ws); this.socket.onopen = resolve; this.socket.onerror = reject; this.socket.onmessage = (event) => { const message = JSON.parse(event.data); if (!message.id) return; const pending = this.pending.get(message.id); if (!pending) return; this.pending.delete(message.id); message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result); }; }); this.send = (method, params = {}) => { const id = this.nextId++; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params })); }); }; this.evaluate = async (expression) => { const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error("Browser expression failed"); return result.result.value; }; this.close = () => this.socket?.close(); }
async function waitFor(client, expression, timeout) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await client.evaluate(expression).catch(() => false)) return; await new Promise((resolve) => setTimeout(resolve, 250)); } throw new Error(`Browser wait timed out: ${expression}`); }
async function waitDevtoolsPort(directory) { const file = path.join(directory, "DevToolsActivePort"), deadline = Date.now() + 15_000; while (Date.now() < deadline) { if (existsSync(file)) return Number(readFileSync(file, "utf8").split(/\r?\n/)[0]); await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("Chrome DevTools unavailable"); }
async function expectJson(response) { if (!response.ok) throw new Error(`Chrome DevTools failed: HTTP ${response.status}`); return response.json(); }
function assert(condition, message) { if (!condition) throw new Error(message); }
function loadEnv(filename) { try { for (const raw of readFileSync(filename, "utf8").split(/\r?\n/)) { const line = raw.trim(); if (!line || line.startsWith("#")) continue; const index = line.indexOf("="); if (index < 1) continue; const key = line.slice(0, index).trim(); let value = line.slice(index + 1).trim(); if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1); if (process.env[key] === undefined) process.env[key] = value; } } catch {} }
