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
const marker = `e2e-managed-telemetry-${stamp}`;
const runnerId = marker;
const switchIp = "192.168.88.201";
const coreIp = "192.168.88.202";
const switchNodeId = randomUUID();
const coreNodeId = randomUUID();
const healthTargetId = randomUUID();
const telemetryTargetId = randomUUID();
const inspectionSessionId = randomUUID();
const speedEventId = randomUUID();
const diagnosticJobId = randomUUID();
const trafficSessionId = randomUUID();
const healthLatency = 23.4;
const profilePath = path.join(root, "runner", "data", marker);
const password = `Tmp-${randomBytes(18).toString("base64url")}!`;
const adminEmail = `${marker}-admin@example.invalid`;
const viewerEmail = `${marker}-viewer@example.invalid`;
const secrets = { community: "e2e-SNMP-community-secret", authPass: "e2e-SNMP-authPass-secret", privPass: "e2e-SNMP-privPass-secret" };
let adminId = null;
let viewerId = null;
let createdTargetId = null;
let chrome = null;
let cdp = null;
let before = null;
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
  assert((await tableExists("managed_telemetry_targets")), "Managed telemetry schema is not applied yet");
  before = await operationalSnapshot();
  adminId = await createUser(adminEmail, password, "admin");
  viewerId = await createUser(viewerEmail, password, "viewer");
  await createFixtures();
  fixtureVisibility = await verifyFixtureVisibility();
  assert(fixtureVisibility.directRest, "Admin fixture cannot read its telemetry fixture through RLS");
  assert(fixtureVisibility.viewerRest, "Viewer fixture cannot read telemetry through RLS");

  chrome = spawn(chromePath, ["--headless=new", "--window-size=1440,1000", "--remote-debugging-port=0", `--user-data-dir=${profilePath}`, "--no-first-run", "--disable-gpu", "about:blank"], { windowsHide: true, shell: false, stdio: "ignore" });
  const port = await waitDevtoolsPort(profilePath);
  const page = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent("http://localhost:3000/login")}`, { method: "PUT" }).then(expectJson);
  cdp = new Devtools(page.webSocketDebuggerUrl);
  await cdp.open(); await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
  await login(cdp, adminEmail, password);

  // --- 1. Admin config flow ------------------------------------------------
  await navigate(cdp, "/admin");
  await waitFor(cdp, `document.body.innerText.toLowerCase().includes('managed infrastructure telemetry')`, 20_000);
  await waitFor(cdp, `document.body.innerText.toLowerCase().includes('snmp read-only telemetry targets')`, 20_000);
  const adminText = await cdp.evaluate(`document.body.innerText`);
  assert(adminText.includes("SNMPv3 · 161 · 60s"), "Admin list missing telemetry target summary");
  assert(adminText.includes("monitoring-readonly"), "Admin list missing credential profile ref");
  assert(adminText.includes("Profile tersedia di runner"), "Admin list did not resolve local credential profile");
  assert(adminText.includes("Errors 5 · discards 10"), "Admin list missing threshold summary");
  await submitTelemetryTargetForm(cdp, { nodeId: coreNodeId, runnerId, profileRef: "core-readonly" });
  await waitFor(cdp, `document.body.innerText.includes('Konfigurasi telemetry tersimpan.')`, 30_000);
  const created = await get(`managed_telemetry_targets?node_id=eq.${coreNodeId}&select=id`);
  assert(created.length === 1, `Admin form created ${created.length} targets`);
  createdTargetId = created[0].id;
  const afterCreate = await cdp.evaluate(`document.body.innerText`);
  assert(afterCreate.includes("core-readonly") && afterCreate.includes("Core-DSW-02"), "Admin list missing newly created target");
  assert(!adminText.includes(secrets.community) && !afterCreate.includes(secrets.authPass), "Admin page leaked a secret");

  // --- 2. Device Profile telemetry section (admin) -------------------------
  await navigate(cdp, "/dashboard");
  await waitFor(cdp, `document.body.innerText.includes(${JSON.stringify(switchIp)}) && document.body.innerText.includes('23.4 ms')`, 20_000);
  await clickHealthFixtureRow(cdp, switchIp, "23.4 ms");
  await waitFor(cdp, `document.body.innerText.includes('View Device Profile')`, 10_000);
  await clickExactButton(cdp, "View Device Profile");
  await waitFor(cdp, `document.querySelector('[aria-label="Device Profile ${switchIp}"]') !== null`, 10_000);
  await waitFor(cdp, `document.body.innerText.includes('Management telemetry')`, 10_000);
  const profile1 = await cdp.evaluate(`document.querySelector('[aria-label="Device Profile ${switchIp}"]').innerText`);
  assert(profile1.includes("Connected"), "Telemetry status badge is not Connected");
  assert(profile1.includes("SNMPv3 · port 161 · every 60s"), "Telemetry metadata missing");
  assert(profile1.includes("Credential profile available"), "Credential profile availability missing");
  assert(profile1.includes("Juniper Networks") && profile1.includes("EX4300-24P") && profile1.includes("SN-TEL-0001"), "Device identity metadata missing");
  assert(profile1.includes("1d 1h 1m"), "Uptime formatting incorrect");
  await clickSummary(cdp, "System identity");
  const profileIdentity = await cdp.evaluate(`document.querySelector('[aria-label="Device Profile ${switchIp}"]').innerText`);
  assert(profileIdentity.includes("Core-ASW-01") && profileIdentity.includes("Juniper EX4300 synthetic switch"), "System identity missing");
  assert(profile1.includes("All interfaces") && profile1.includes("10"), "All-interfaces metric wrong");
  assert(profile1.includes("Likely physical ports") && profile1.includes("classified by name and type, not ifNumber"), "Physical-port semantics missing");
  assert(profile1.includes("Physical up") && profile1.includes("Physical down"), "Physical up/down metrics missing");
  assert(profile1.includes("Ports with recent errors") && profile1.includes("Ports with recent discards"), "Recent-delta metrics missing");
  assert(profile1.includes("2 logical interfaces (VLAN/loopback/tunnel) are not counted as physical ports."), "Logical-interface note missing");
  assert(profile1.includes("1 physical port is operationally down."), "Physical-down note missing");

  const profileMetrics = await cdp.evaluate(`(() => { const lines=document.querySelector('[aria-label="Device Profile ${switchIp}"]').innerText.split('\\n'); const grab=(label)=>{const index=lines.findIndex((line)=>line.trim()===label);if(index<0)return null;for(let i=index-1;i>=0;i--){if(lines[i].trim())return lines[i].trim();}return null;}; return { physical: grab('Likely physical ports'), up: grab('Physical up'), down: grab('Physical down'), errors: grab('Ports with recent errors'), discards: grab('Ports with recent discards') }; })()`);
  assert(profileMetrics.physical === "8", "Physical port count is not 8 (must never equal ifNumber total)");
  assert(profileMetrics.up === "7", "Physical up count wrong");
  assert(profileMetrics.down === "1", "Physical down count wrong");
  assert(profileMetrics.errors === "1", "Recent-errors count wrong");
  assert(profileMetrics.discards === "2", "Recent-discards count wrong");
  assert(profileMetrics.physical !== "10", "Physical count incorrectly includes logical interfaces");

  // --- 3. Interface table + semantics --------------------------------------
  for (const header of ["Interface", "Admin", "Operational", "Speed", "RX rate", "TX rate", "RX util", "TX util", "Errors Δ", "Discards Δ"]) {
    assert(profile1.includes(header), `Interface table missing header ${header}`);
  }
  assert(profile1.includes("10 interfaces"), "Interface table count wrong");
  const rowText = async (name) => cdp.evaluate(`(() => { const table=[...document.querySelectorAll('table')].find((item)=>item.innerText.includes('Errors Δ')); if(!table)return ''; const row=[...table.querySelectorAll('tr')].find((item)=>item.querySelector('td')&&item.querySelector('td').textContent.trim().startsWith(${JSON.stringify(name)})); return row?row.innerText:''; })()`);
  const gi01 = await rowText("Gi0/1");
  assert(gi01.includes("1 Gbps") && gi01.includes("125 Mbps") && gi01.includes("250 Mbps") && gi01.includes("12.5%") && gi01.includes("25%"), "Gi0/1 row values wrong");
  assert(gi01.includes("+2"), "Gi0/1 errors delta should be +2");
  const gi03 = await rowText("Gi0/3");
  assert(!gi03.includes("0%") && gi03.includes("100 Mbps"), "Gi0/3 null utilization rendered as 0%");
  const gi05 = await rowText("Gi0/5");
  assert(gi05.includes("+8"), "Gi0/5 discards delta should be +8");
  const vlanRow = await rowText("Vlan10");
  assert(vlanRow.includes("logical"), "Logical interface not marked logical in table");

  // --- 4. Interface detail --------------------------------------------------
  await clickTableRow(cdp, "Gi0/1");
  await waitFor(cdp, `document.body.innerText.includes('Errors (cumulative)')`, 10_000);
  const detail = await cdp.evaluate(`document.querySelector('[aria-label="Device Profile ${switchIp}"]').innerText`);
  for (const expected of ["ifIndex", "ifName", "ifDescr", "ifType", "Classification", "Admin state", "Oper state", "Speed", "RX rate", "TX rate", "RX utilization", "TX utilization", "Errors (cumulative)", "Errors (recent Δ)", "Discards (cumulative)", "Discards (recent Δ)", "Last poll"]) assert(detail.includes(expected), `Interface detail missing ${expected}`);
  assert(detail.includes("Likely physical port") && detail.includes("100 / 50") && detail.includes("+2") && detail.includes("200 / 100") && detail.includes("+5"), "Interface detail values wrong");
  await clickTableRow(cdp, "Gi0/2");
  await waitFor(cdp, `document.body.innerText.includes('Possible link issue')`, 10_000);
  await clickTableRow(cdp, "Gi0/6");
  await waitFor(cdp, `document.body.innerText.includes('Speed changed')`, 10_000);
  await clickTableRow(cdp, "Vlan10");
  await waitFor(cdp, `document.querySelector('[aria-label="Device Profile ${switchIp}"]').innerText.includes('Logical interface')`, 10_000);

  // --- 5. Realtime update without refresh -----------------------------------
  const beforeRealtime = await cdp.evaluate(`({ pathname: location.pathname, origin: performance.timeOrigin })`);
  await rest(`managed_device_latest?target_id=eq.${telemetryTargetId}`, "PATCH", { sys_name: "Core-ASW-01-UPDATED", uptime_seconds: 173000 });
  await waitFor(cdp, `document.querySelector('[aria-label="Device Profile ${switchIp}"]').innerText.includes('2d 0h 3m')`, 15_000);
  await clickSummary(cdp, "System identity");
  await waitFor(cdp, `document.querySelector('[aria-label="Device Profile ${switchIp}"]').innerText.includes('Core-ASW-01-UPDATED')`, 15_000);
  await rest(`managed_interface_latest?target_id=eq.${telemetryTargetId}&if_index=eq.1`, "PATCH", { rx_util_percent: 40 });
  await waitFor(cdp, `(() => { const table=[...document.querySelectorAll('table')].find((item)=>item.innerText.includes('Errors Δ')); return table&&table.innerText.includes('40%'); })()`, 15_000);
  const afterRealtime = await cdp.evaluate(`({ pathname: location.pathname, origin: performance.timeOrigin })`);
  assert(afterRealtime.pathname === beforeRealtime.pathname, "Realtime update caused navigation");
  assert(afterRealtime.origin === beforeRealtime.origin, "Realtime update caused a full reload");

  // --- 6. Desktop layout ----------------------------------------------------
  const desktop = await cdp.evaluate(`({ overflow: document.documentElement.scrollWidth > window.innerWidth, width: window.innerWidth })`);
  assert(!desktop.overflow && desktop.width >= 1000, "Desktop profile has horizontal overflow");

  // --- 7. Viewer read-only + no secrets in DOM ------------------------------
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  await clickExactButton(cdp, "Tutup"); await clickExactButton(cdp, "Keluar");
  await waitFor(cdp, `location.pathname === '/login'`, 20_000);
  await login(cdp, viewerEmail, password);
  await waitFor(cdp, `document.body.innerText.includes(${JSON.stringify(switchIp)})`, 20_000);
  await clickHealthFixtureRow(cdp, switchIp, "23.4 ms");
  await waitFor(cdp, `document.body.innerText.includes('View Device Profile')`, 10_000);
  await clickExactButton(cdp, "View Device Profile");
  await waitFor(cdp, `document.querySelector('[aria-label="Device Profile ${switchIp}"]') !== null`, 10_000);
  await waitFor(cdp, `document.querySelector('[aria-label="Device Profile ${switchIp}"]').innerText.includes('Connected')`, 10_000);
  const viewerProfile = await cdp.evaluate(`document.querySelector('[aria-label="Device Profile ${switchIp}"]').innerText`);
  assert(viewerProfile.includes("Management telemetry"), "Viewer cannot read telemetry section");
  const viewerControls = await cdp.evaluate(`[...document.querySelector('[aria-label="Device Profile ${switchIp}"]').querySelectorAll('button')].map((button)=>button.textContent.trim())`);
  assert(!viewerControls.some((label) => ["Inspect", "Inspect again", "Save identity", "Save detected evidence", "Add to Health Watch"].includes(label)), "Viewer profile exposed admin controls");
  const viewerBody = await cdp.evaluate(`document.body.innerText`);
  assert(!viewerBody.includes(secrets.community) && !viewerBody.includes(secrets.authPass) && !viewerBody.includes(secrets.privPass), "Viewer DOM leaked a secret");
  await clientPageNav(cdp, "/admin");
  await waitFor(cdp, `location.pathname !== '/admin'`, 20_000);

  // --- 8. Mobile layout -----------------------------------------------------
  await navigate(cdp, "/dashboard");
  await waitFor(cdp, `document.body.innerText.includes(${JSON.stringify(switchIp)})`, 20_000);
  await clickHealthFixtureRow(cdp, switchIp, "23.4 ms");
  await waitFor(cdp, `document.body.innerText.includes('View Device Profile')`, 10_000);
  await clickExactButton(cdp, "View Device Profile");
  await waitFor(cdp, `document.querySelector('[aria-label="Device Profile ${switchIp}"]') !== null`, 10_000);
  await waitFor(cdp, `document.querySelector('[aria-label="Device Profile ${switchIp}"]').innerText.includes('Management telemetry')`, 10_000);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const mobile = await cdp.evaluate(`({ dialog: !!document.querySelector('[aria-label="Device Profile ${switchIp}"]'), overflow: document.documentElement.scrollWidth > window.innerWidth })`);
  assert(mobile.dialog && !mobile.overflow, "Mobile profile has horizontal overflow");
  const mobileBody = await cdp.evaluate(`document.body.innerText`);
  assert(!mobileBody.includes(secrets.community) && !mobileBody.includes(secrets.authPass), "Mobile DOM leaked a secret");
  await cdp.send("Emulation.clearDeviceMetricsOverride");

  // --- 9. Existing surfaces unaffected (smoke; no probes executed) ----------
  await clickExactButton(cdp, "Tutup");
  await navigate(cdp, "/traffic");
  await waitFor(cdp, `document.body.innerText.includes('Core-ASW-01')`, 20_000);
  await navigate(cdp, "/diagnostics");
  await selectOptionValue(cdp, marker);
  await waitFor(cdp, `document.body.innerText.includes('Synthetic switch') && document.body.innerText.toLowerCase().includes('diagnostic complete')`, 20_000);
  await navigate(cdp, "/dashboard");
  await waitFor(cdp, `document.body.innerText.includes('23.4 ms')`, 20_000);
  const healthBody = await cdp.evaluate(`document.body.innerText`);
  assert(healthBody.includes("23.4 ms") && !healthBody.includes(secrets.community), "Health Watch regression or secret leak");

  const during = await operationalSnapshot();
  assert(during.events === before.events + 1, "Browser E2E changed events");
  outcome = {
    ok: true, fixture_marker: marker,
    fixture_ids: { admin_user: adminId, viewer_user: viewerId, runner: runnerId, switch_node: switchNodeId, core_node: coreNodeId, health_target: healthTargetId, telemetry_target: telemetryTargetId, created_target: createdTargetId, speed_event: speedEventId, diagnostic_job: diagnosticJobId, traffic_session: trafficSessionId },
    admin_config_flow: true, profile_telemetry_section: true,
    physical_count_semantics: true, logical_not_counted: true,
    interface_table: true, interface_detail: true, null_util_not_zero: true,
    recent_delta_semantics: true, realtime_without_refresh: true,
    viewer_read_only: true, desktop_layout: true, mobile_layout: true,
    no_horizontal_overflow: true, no_credentials_in_dom: true,
    device_inspector_surface_ok: true, health_unaffected: true,
    traffic_unaffected: true, diagnostics_unaffected: true,
    snmp_udp_161_used: false, inspector_probe_run: false, ping_mtr_iperf_run: false,
    events_delta: during.events - before.events,
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
  await rest("diagnostic_runners", "POST", { id: runnerId, display_name: `${marker} synthetic runner`, last_seen_at: now, health_status: "online", health_error_code: null, capabilities: { fixture_marker: marker, source_locations: [marker], targets: [{ id: `${marker}-switch`, label: "Synthetic switch", host: switchIp, iperf_port: 5201, environment: "lan" }], durations: [5], operations: ["network_discovery", "device_inspect", "traffic_live", "bandwidth_and_path"], traffic_durations_seconds: [300], device_inspector: { available: true, probe_engine: "python_socket" }, snmp_telemetry: { enabled: true, max_concurrent: 2, poll_intervals_seconds: [30, 60], versions: ["3", "2c"], credential_profiles: ["monitoring-readonly", "core-readonly"] } } });
  await rest("network_nodes", "POST", { id: switchNodeId, ip_address: `${switchIp}/32`, name: `${marker} Core-ASW-01`, device_type: "managed_switch", location: "Synthetic fixture", created_at: now, updated_at: now });
  await rest("network_nodes", "POST", { id: coreNodeId, ip_address: `${coreIp}/32`, name: `${marker} Core-DSW-02`, device_type: "layer3_switch", location: "Synthetic fixture", created_at: now, updated_at: now });
  await rest(`network_nodes?id=eq.${switchNodeId}`, "PATCH", { detected_fingerprint: switchFingerprint(switchIp), last_inspected_at: now });
  await rest("network_targets", "POST", { id: healthTargetId, node_id: switchNodeId, runner_id: runnerId, enabled: true, critical: false, probe_method: "icmp", probe_interval_seconds: 3600, timeout_ms: 1000, failure_threshold: 3, recovery_threshold: 2, latency_warning_ms: 60000, loss_warning_percent: 100, created_by: adminId, created_at: now, updated_at: now });
  await rest("network_health_latest", "POST", { target_id: healthTargetId, status: "online", latency_ms: healthLatency, packet_loss_percent: 0, last_checked_at: now, last_success_at: now, consecutive_failures: 0, sample_count: 1, updated_at: now });
  await rest("managed_telemetry_targets", "POST", { id: telemetryTargetId, node_id: switchNodeId, runner_id: runnerId, enabled: true, credential_profile_ref: "monitoring-readonly", snmp_version: "3", snmp_port: 161, poll_interval_seconds: 60, oper_error_threshold: 5, discard_threshold: 10, util_warning_percent: 80, util_critical_percent: 95, util_sustained_seconds: 300, created_by: adminId, created_at: now, updated_at: now });
  await rest("managed_device_latest", "POST", { target_id: telemetryTargetId, status: "connected", sys_name: "Core-ASW-01", sys_descr: "Juniper EX4300 synthetic switch", sys_object_id: "1.3.6.1.4.1.2636.1.1.1.4.84.0", uptime_seconds: 90061, manufacturer: "Juniper Networks", model: "EX4300-24P", serial_number: "SN-TEL-0001", last_polled_at: now, last_success_at: now, consecutive_poll_failures: 0, error_category: null, updated_at: now });
  const interfaces = [
    { if_index: 1, name: "Gi0/1", description: "GE-0/0/1 uplink", if_type: 6, is_physical: true, admin_status: "up", oper_status: "up", speed_bps: 1000000000, rx_rate_bps: 125000000, tx_rate_bps: 250000000, rx_util_percent: 12.5, tx_util_percent: 25, rx_errors_cumulative: 100, tx_errors_cumulative: 50, in_discards_cumulative: 200, out_discards_cumulative: 100, rx_errors_delta: 2, tx_errors_delta: 0, in_discards_delta: 5, out_discards_delta: 0 },
    { if_index: 2, name: "Gi0/2", description: "GE-0/0/2 access", if_type: 6, is_physical: true, admin_status: "up", oper_status: "down", speed_bps: 1000000000, rx_rate_bps: null, tx_rate_bps: null, rx_util_percent: null, tx_util_percent: null, rx_errors_cumulative: null, tx_errors_cumulative: null, in_discards_cumulative: null, out_discards_cumulative: null, rx_errors_delta: null, tx_errors_delta: null, in_discards_delta: null, out_discards_delta: null },
    { if_index: 3, name: "Gi0/3", description: "FE-0/0/3 legacy", if_type: 6, is_physical: true, admin_status: "up", oper_status: "up", speed_bps: 100000000, rx_rate_bps: null, tx_rate_bps: null, rx_util_percent: null, tx_util_percent: null, rx_errors_cumulative: null, tx_errors_cumulative: null, in_discards_cumulative: null, out_discards_cumulative: null, rx_errors_delta: null, tx_errors_delta: null, in_discards_delta: null, out_discards_delta: null },
    { if_index: 4, name: "Gi0/4", description: "GE-0/0/4 idle", if_type: 6, is_physical: true, admin_status: "up", oper_status: "up", speed_bps: 1000000000, rx_rate_bps: 0, tx_rate_bps: 0, rx_util_percent: 0, tx_util_percent: 0, rx_errors_cumulative: 0, tx_errors_cumulative: 0, in_discards_cumulative: 0, out_discards_cumulative: 0, rx_errors_delta: 0, tx_errors_delta: 0, in_discards_delta: 0, out_discards_delta: 0 },
    { if_index: 5, name: "Gi0/5", description: "GE-0/0/5", if_type: 6, is_physical: true, admin_status: "up", oper_status: "up", speed_bps: 1000000000, rx_rate_bps: null, tx_rate_bps: null, rx_util_percent: null, tx_util_percent: null, rx_errors_cumulative: null, tx_errors_cumulative: null, in_discards_cumulative: null, out_discards_cumulative: null, rx_errors_delta: null, tx_errors_delta: null, in_discards_delta: 8, out_discards_delta: 0 },
    { if_index: 6, name: "Gi0/6", description: "GE-0/0/6", if_type: 6, is_physical: true, admin_status: "up", oper_status: "up", speed_bps: 100000000, rx_rate_bps: null, tx_rate_bps: null, rx_util_percent: 99, tx_util_percent: 10, rx_errors_cumulative: null, tx_errors_cumulative: null, in_discards_cumulative: null, out_discards_cumulative: null, rx_errors_delta: null, tx_errors_delta: null, in_discards_delta: null, out_discards_delta: null },
    { if_index: 7, name: "Gi0/7", description: "GE-0/0/7", if_type: 6, is_physical: true, admin_status: "up", oper_status: "up", speed_bps: 1000000000, rx_rate_bps: null, tx_rate_bps: null, rx_util_percent: null, tx_util_percent: null, rx_errors_cumulative: null, tx_errors_cumulative: null, in_discards_cumulative: null, out_discards_cumulative: null, rx_errors_delta: null, tx_errors_delta: null, in_discards_delta: null, out_discards_delta: null },
    { if_index: 8, name: "Gi0/8", description: "GE-0/0/8", if_type: 6, is_physical: true, admin_status: "up", oper_status: "up", speed_bps: 1000000000, rx_rate_bps: null, tx_rate_bps: null, rx_util_percent: null, tx_util_percent: null, rx_errors_cumulative: null, tx_errors_cumulative: null, in_discards_cumulative: null, out_discards_cumulative: null, rx_errors_delta: null, tx_errors_delta: null, in_discards_delta: null, out_discards_delta: null },
    { if_index: 4096, name: "Vlan10", description: "VLAN 10", if_type: 135, is_physical: false, admin_status: "up", oper_status: "up", speed_bps: 1000000000, rx_rate_bps: null, tx_rate_bps: null, rx_util_percent: null, tx_util_percent: null, rx_errors_cumulative: null, tx_errors_cumulative: null, in_discards_cumulative: null, out_discards_cumulative: null, rx_errors_delta: null, tx_errors_delta: null, in_discards_delta: null, out_discards_delta: null },
    { if_index: 8192, name: "Loopback0", description: "Loopback", if_type: 24, is_physical: false, admin_status: "up", oper_status: "up", speed_bps: null, rx_rate_bps: null, tx_rate_bps: null, rx_util_percent: null, tx_util_percent: null, rx_errors_cumulative: null, tx_errors_cumulative: null, in_discards_cumulative: null, out_discards_cumulative: null, rx_errors_delta: null, tx_errors_delta: null, in_discards_delta: null, out_discards_delta: null },
  ];
  for (const row of interfaces) await rest("managed_interface_latest", "POST", { target_id: telemetryTargetId, ...row, last_polled_at: now, updated_at: now });
  await rest("events", "POST", { id: speedEventId, created_at: now, severity: "medium", title: "Interface speed changed", description: "Synthetic fixture event", raw_context: { kind: "speed_changed", if_index: 6 }, source: "managed_telemetry", source_ref: telemetryTargetId });
  await rest("device_inspection_sessions", "POST", { runner_id: runnerId, inspection_id: inspectionSessionId, requested_by: adminId, target_ip: `${switchIp}/32`, authorization_source: "inventory", status: "completed", stage: "complete", result: switchFingerprint(switchIp), created_at: now, started_at: now, completed_at: now, expires_at: new Date(Date.now() + 600_000).toISOString(), updated_at: now });
  await rest("diagnostic_jobs", "POST", { id: diagnosticJobId, runner_id: runnerId, requested_by: adminId, status: "completed", type: "bandwidth_and_path", source_label: marker, target_id: `${marker}-target`, target_label: "Synthetic switch", target_host: switchIp, iperf_port: 5201, connection_type: "wifi", duration_seconds: 5, environment: "lan", stage: "complete", progress: {}, created_at: now, started_at: now, completed_at: now, updated_at: now });
  await rest("traffic_live_sessions", "POST", { id: trafficSessionId, runner_id: runnerId, requested_by: adminId, status: "completed", duration_seconds: 300, capture_scope: "this_device", stage: "complete", created_at: now, started_at: now, completed_at: now, updated_at: now });
  await rest("traffic_live_snapshots", "POST", { runner_id: runnerId, session_id: trafficSessionId, captured_at: now, summary: { observed_tx_mbps: 0.5, observed_rx_mbps: 0.4, packets_observed: 12, packets_per_second: 3, active_flows: 1, dominant_protocol: "tcp" }, flows: [{ flow_key: `${marker}-flow`, src_ip: switchIp, dst_ip: "192.168.88.200", src_port: 443, dst_port: 53000, protocol: "tcp", service: "HTTPS", first_seen: now, last_seen: now, total_bytes: 4096, packet_count: 8, bytes_delta: 4096, packets_delta: 8, packets_per_second: 2, rate_mbps: 0.4, peak_rate_mbps: 0.4, rate_trend: "stable", status: "active" }], conversations: [], top_talkers: [{ ip: switchIp, rate_mbps: 0.4, total_bytes: 4096, active_flows: 1 }], payload_bytes: 800, updated_at: now });
}

function switchFingerprint(ip) {
  return {
    schema_version: 1, ip, reachable: true, route_role: "on_link", same_subnet: true,
    network_context: { is_this_device: false, automated_role: null, interface_index: 1, interface_alias: "GE-0/0/1", interface_description: "Synthetic fixture", interface_type: "physical" },
    network_identity: { mac: null, mac_kind: "unavailable", mac_vendor: null, tls_identity: null },
    detected_identity: { manufacturer: "Juniper Networks", model: "EX4300", model_number: "EX4300-24P", os_family: "Junos", likely_label: "Synthetic managed switch" },
    likely_device_type: "managed_switch", capabilities: ["managed_switch"], confidence: "high",
    observed_services: [], observed_software: [],
    evidence: [{ source: "fixture", label: "Inspection evidence", value: "Stored browser E2E fixture (no probe executed)" }],
    probe_summary: { tcp_ports_checked: [], tcp_open_count: 0, upnp_checked: false, optional_skips: ["all"] },
    limitations: ["Controlled result; no network probe executed."],
  };
}

async function cleanupFixtures() {
  if (createdTargetId) await remove(`managed_telemetry_targets?id=eq.${createdTargetId}`);
  await remove(`traffic_live_snapshots?runner_id=eq.${encodeURIComponent(runnerId)}&session_id=eq.${trafficSessionId}`);
  await remove(`traffic_live_sessions?id=eq.${trafficSessionId}`);
  await remove(`diagnostic_jobs?id=eq.${diagnosticJobId}`);
  await remove(`events?id=eq.${speedEventId}`);
  await remove(`managed_interface_latest?target_id=eq.${telemetryTargetId}`);
  await remove(`managed_device_latest?target_id=eq.${telemetryTargetId}`);
  await remove(`managed_telemetry_targets?id=eq.${telemetryTargetId}`);
  await remove(`device_inspection_sessions?runner_id=eq.${encodeURIComponent(runnerId)}`);
  await remove(`network_health_latest?target_id=eq.${healthTargetId}`);
  await remove(`network_targets?id=eq.${healthTargetId}`);
  await remove(`network_nodes?id=eq.${switchNodeId}`);
  await remove(`network_nodes?id=eq.${coreNodeId}`);
  await remove(`diagnostic_runners?id=eq.${encodeURIComponent(runnerId)}`);
  if (adminId) await removeUser(adminId);
  if (viewerId) await removeUser(viewerId);
  const checks = {
    admin_user: adminId ? await userAbsent(adminId) : true,
    viewer_user: viewerId ? await userAbsent(viewerId) : true,
    runner: await absent(`diagnostic_runners?id=eq.${encodeURIComponent(runnerId)}&select=id`),
    switch_node: await absent(`network_nodes?id=eq.${switchNodeId}&select=id`),
    core_node: await absent(`network_nodes?id=eq.${coreNodeId}&select=id`),
    health_target: await absent(`network_targets?id=eq.${healthTargetId}&select=id`),
    health_latest: await absent(`network_health_latest?target_id=eq.${healthTargetId}&select=target_id`),
    telemetry_target: await absent(`managed_telemetry_targets?id=eq.${telemetryTargetId}&select=id`),
    created_target: createdTargetId ? await absent(`managed_telemetry_targets?id=eq.${createdTargetId}&select=id`) : true,
    device_latest: await absent(`managed_device_latest?target_id=eq.${telemetryTargetId}&select=target_id`),
    interface_latest: await absent(`managed_interface_latest?target_id=eq.${telemetryTargetId}&select=target_id`),
    speed_event: await absent(`events?id=eq.${speedEventId}&select=id`),
    diagnostic_job: await absent(`diagnostic_jobs?id=eq.${diagnosticJobId}&select=id`),
    traffic_session: await absent(`traffic_live_sessions?id=eq.${trafficSessionId}&select=id`),
    traffic_snapshot: await absent(`traffic_live_snapshots?runner_id=eq.${encodeURIComponent(runnerId)}&session_id=eq.${trafficSessionId}&select=session_id`),
    inspection_session: await absent(`device_inspection_sessions?runner_id=eq.${encodeURIComponent(runnerId)}&select=runner_id`),
  };
  assert(Object.values(checks).every(Boolean), `Fixture cleanup failed: ${Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name).join(", ")}`);
  if (before) assert(JSON.stringify(await operationalSnapshot()) === JSON.stringify(before), "Operational counts changed after cleanup");
  return { verified: true, checks, operational_counts_restored: true };
}

async function operationalSnapshot() {
  const tables = ["events", "traffic_metrics", "flows", "network_nodes", "network_targets", "network_health_latest", "diagnostic_runners", "diagnostic_jobs", "hop_measurements", "traffic_live_sessions", "traffic_live_snapshots", "device_inspection_sessions", "managed_telemetry_targets", "managed_device_latest", "managed_interface_latest"];
  const values = await Promise.all(tables.map(count));
  return Object.fromEntries(tables.map((table, index) => [table, values[index]]));
}

async function createUser(email, userPassword, role) {
  const response = await fetch(`${url}/auth/v1/admin/users`, { method: "POST", headers: { ...headers(), "Content-Type": "application/json" }, body: JSON.stringify({ email, password: userPassword, email_confirm: true }) });
  const user = await response.json();
  if (!response.ok || !user.id) throw new Error(`Could not create ${role} fixture`);
  if (role === "admin") adminId = user.id; else viewerId = user.id;
  await rest(`profiles?id=eq.${user.id}`, "PATCH", { status: "approved", role, approved_at: new Date().toISOString() });
  return user.id;
}

async function verifyFixtureVisibility() {
  const [adminLoginResponse, viewerLoginResponse] = await Promise.all([
    fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: serviceKey, "Content-Type": "application/json" }, body: JSON.stringify({ email: adminEmail, password }) }),
    fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: serviceKey, "Content-Type": "application/json" }, body: JSON.stringify({ email: viewerEmail, password }) }),
  ]);
  const adminLoginData = await adminLoginResponse.json();
  const viewerLoginData = await viewerLoginResponse.json();
  if (!adminLoginResponse.ok || !adminLoginData.access_token) throw new Error("Admin fixture visibility login failed");
  if (!viewerLoginResponse.ok || !viewerLoginData.access_token) throw new Error("Viewer fixture visibility login failed");
  const [adminResponse, viewerResponse] = await Promise.all([
    fetch(`${url}/rest/v1/managed_device_latest?target_id=eq.${telemetryTargetId}&select=target_id`, { headers: { Authorization: `Bearer ${adminLoginData.access_token}`, apikey: serviceKey } }),
    fetch(`${url}/rest/v1/managed_device_latest?target_id=eq.${telemetryTargetId}&select=target_id`, { headers: { Authorization: `Bearer ${viewerLoginData.access_token}`, apikey: serviceKey } }),
  ]);
  const [adminRows, viewerRows] = await Promise.all([adminResponse.json(), viewerResponse.json()]);
  return {
    directRest: adminResponse.ok && Array.isArray(adminRows) && adminRows.some((row) => row.target_id === telemetryTargetId),
    viewerRest: viewerResponse.ok && Array.isArray(viewerRows) && viewerRows.some((row) => row.target_id === telemetryTargetId),
    adminStatus: adminResponse.status,
    viewerStatus: viewerResponse.status,
  };
}

async function submitTelemetryTargetForm(client, { nodeId, runnerId: selectedRunner, profileRef }) {
  await waitFor(client, `(() => { const form=[...document.querySelectorAll('form')].find((item)=>item.querySelector('select[name="node_id"]')&&item.querySelector('input[name="credential_profile_ref"]')); return form&&Object.keys(form).some((key)=>key.startsWith('__reactProps')); })()`, 20_000);
  await client.evaluate(`(() => { const form=[...document.querySelectorAll('form')].find((item)=>item.querySelector('select[name="node_id"]')&&item.querySelector('input[name="credential_profile_ref"]'));if(!form)throw new Error('Telemetry form missing');const set=(el,value,eventType)=>{const proto=el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;const setter=Object.getOwnPropertyDescriptor(proto,'value').set;setter.call(el,value);el.dispatchEvent(new Event(eventType,{bubbles:true}));};set(form.querySelector('select[name="node_id"]'),${JSON.stringify(nodeId)},'change');set(form.querySelector('select[name="runner_id"]'),${JSON.stringify(selectedRunner)},'change');set(form.querySelector('select[name="snmp_version"]'),'3','change');set(form.querySelector('select[name="poll_interval_seconds"]'),'60','change');set(form.querySelector('input[name="credential_profile_ref"]'),${JSON.stringify(profileRef)},'input');form.requestSubmit(); })()`);
}

async function login(client, email, userPassword) {
  await waitFor(client, `(() => { const form=document.querySelector('form');const input=document.querySelector('input[name="email"]');return form&&input&&Object.keys(form).some((key)=>key.startsWith('__reactProps')); })()`, 20_000);
  await client.evaluate(`(() => { const set=(selector,value)=>{const input=document.querySelector(selector);const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));};set('input[name="email"]',${JSON.stringify(email)});set('input[name="password"]',${JSON.stringify(userPassword)});document.querySelector('form').requestSubmit(); })()`);
  try { await waitFor(client, `location.pathname === '/dashboard' || (document.body.innerText.includes('NETWORK OPERATIONS') && document.body.innerText.includes('Keluar'))`, 30_000); } catch { const debug = await client.evaluate(`({pathname:location.pathname,body:document.body.innerText.slice(0,500)})`); throw new Error(`Fixture login did not reach authenticated shell: ${JSON.stringify(debug)}`); }
  if (await client.evaluate(`location.pathname`) !== "/dashboard") await navigate(client, "/dashboard");
}

async function clickSummary(client, text) {
  await client.evaluate(`(() => { const summary=[...document.querySelectorAll('summary')].find((item)=>item.textContent.trim()===${JSON.stringify(text)}&&item.getClientRects().length);if(!summary)throw new Error('Summary missing');if(!summary.parentElement.open)summary.click(); })()`);
}

async function clickTableRow(client, text) {
  const rowReady = `(() => { const row=[...document.querySelectorAll('tr')].find((item)=>item.getClientRects().length&&item.textContent.includes(${JSON.stringify(text)})&&item.querySelector('td'));return row&&Object.keys(row).some((key)=>key.startsWith('__reactProps')); })()`;
  await waitFor(client, rowReady, 20_000);
  return client.evaluate(`(() => { const row=[...document.querySelectorAll('tr')].find((item)=>item.getClientRects().length&&item.textContent.includes(${JSON.stringify(text)})&&item.querySelector('td'));if(!row)throw new Error('Interface row missing');const result={row:row.textContent.trim().slice(0,200)};row.click();return result; })()`);
}

async function selectOptionValue(client, value) {
  try { await waitFor(client, `(() => { const select=[...document.querySelectorAll('select')].find((item)=>[...item.options].some((option)=>option.value===${JSON.stringify(value)}));return select&&Object.keys(select).some((key)=>key.startsWith('__reactProps')); })()`, 20_000); }
  catch { const debug = await client.evaluate(`({pathname:location.pathname,title:document.title,heading:document.querySelector('h1')?.textContent??null,body:document.body.innerText.slice(0,500),loadError:document.body.innerText.includes('Data diagnostik gagal dimuat')})`); throw new Error(`Fixture filter option unavailable: ${JSON.stringify(debug)}`); }
  await client.evaluate(`(() => { const select=[...document.querySelectorAll('select')].find((item)=>[...item.options].some((option)=>option.value===${JSON.stringify(value)}));if(!select)throw new Error('Fixture filter option missing');const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;setter.call(select,${JSON.stringify(value)});select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
}

async function clientPageNav(client, pathname) {
  await client.send("Page.navigate", { url: `http://localhost:3000${pathname}` });
  await waitFor(client, `location.pathname !== ${JSON.stringify(pathname)}`, 20_000);
}

async function clickHealthFixtureRow(client, ip, latency) {
  const rowReady = `(() => { const row=[...document.querySelectorAll('tr')].find((item)=>item.getClientRects().length&&item.textContent.includes(${JSON.stringify(ip)})&&item.textContent.includes(${JSON.stringify(latency)}));return row&&Object.keys(row).some((key)=>key.startsWith('__reactProps')); })()`;
  await waitFor(client, rowReady, 20_000);
  await client.evaluate(`(() => { const row=[...document.querySelectorAll('tr')].find((item)=>item.getClientRects().length&&item.textContent.includes(${JSON.stringify(ip)})&&item.textContent.includes(${JSON.stringify(latency)}));if(!row)throw new Error('Health fixture row missing');row.click(); })()`);
}

async function clickExactButton(client, text) {
  await client.evaluate(`(() => { const button=[...document.querySelectorAll('button')].find((item)=>item.textContent.trim()===${JSON.stringify(text)});if(!button)throw new Error('Button missing');const key=Object.keys(button).find((item)=>item.startsWith('__reactProps'));const handler=key&&button[key]?.onClick;if(typeof handler==='function')handler({currentTarget:button,target:button,preventDefault(){},stopPropagation(){}});else button.click(); })()`);
}

async function navigate(client, pathname) {
  const previousDocument = await client.evaluate(`performance.timeOrigin`);
  await client.send("Page.navigate", { url: `http://localhost:3000${pathname}` });
  await waitFor(client, `location.pathname === ${JSON.stringify(pathname)} && performance.timeOrigin !== ${JSON.stringify(previousDocument)}`, 20_000);
}

async function tableExists(table) {
  const response = await fetch(`${url}/rest/v1/${table}?select=id&limit=1`, { headers: headers() });
  return response.ok;
}

async function count(table) {
  const response = await fetch(`${url}/rest/v1/${table}?select=*`, { method: "HEAD", headers: { ...headers(), Prefer: "count=exact" } });
  if (!response.ok) throw new Error(`Count failed for ${table}`);
  return Number(response.headers.get("content-range")?.split("/")[1] ?? 0);
}

async function rest(resource, method, body) {
  const response = await fetch(`${url}/rest/v1/${resource}`, { method, headers: { ...headers(), "Content-Type": "application/json", Prefer: "return=representation" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Fixture write failed for ${resource}: HTTP ${response.status} ${await response.text().catch(() => "")}`);
  return response.status === 204 ? null : response.json();
}

async function get(resource) {
  const response = await fetch(`${url}/rest/v1/${resource}`, { headers: headers() });
  if (!response.ok) throw new Error(`Fixture read failed: HTTP ${response.status}`);
  return response.json();
}

async function remove(resource) {
  const response = await fetch(`${url}/rest/v1/${resource}`, { method: "DELETE", headers: headers() });
  if (!response.ok) throw new Error(`Exact cleanup failed: HTTP ${response.status}`);
}

async function absent(resource) { return (await get(resource)).length === 0; }

async function removeUser(id) {
  const response = await fetch(`${url}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: headers() });
  if (!response.ok) throw new Error("Exact user cleanup failed");
}

async function userAbsent(id) {
  const response = await fetch(`${url}/auth/v1/admin/users/${id}`, { headers: headers() });
  return response.status === 404;
}

function headers() { return { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey }; }

async function auditFixtureResidue() {
  const pattern = "like.e2e-managed-telemetry-*";
  const [runners, nodes, targets, usersResponse] = await Promise.all([
    get(`diagnostic_runners?id=${pattern}&select=id`),
    get(`network_nodes?name=${pattern}&select=id,name`),
    get(`managed_telemetry_targets?runner_id=${pattern}&select=id,node_id`),
    fetch(`${url}/auth/v1/admin/users?page=1&per_page=1000`, { headers: headers() }).then(expectApiJson),
  ]);
  const targetIds = targets.map((row) => row.id);
  const nodeIds = nodes.map((row) => row.id);
  const [devices, interfaces, events, sessions, healthTargets] = await Promise.all([
    targetIds.length ? Promise.all(targetIds.map((id) => get(`managed_device_latest?target_id=eq.${id}&select=target_id`))) : Promise.resolve([]),
    targetIds.length ? Promise.all(targetIds.map((id) => get(`managed_interface_latest?target_id=eq.${id}&select=target_id`))) : Promise.resolve([]),
    targetIds.length ? Promise.all(targetIds.map((id) => get(`events?source_ref=eq.${id}&select=id`))) : Promise.resolve([]),
    get(`device_inspection_sessions?runner_id=${pattern}&select=runner_id`),
    get(`network_targets?node_id=in.(${nodeIds.length ? nodeIds.join(",") : "00000000-0000-0000-0000-000000000000"})&select=id`),
  ]);
  const users = (usersResponse.users ?? []).filter((user) => typeof user.email === "string" && user.email.startsWith("e2e-managed-telemetry-")).map((user) => ({ id: user.id, email_marker: user.email.split("@")[0] }));
  const residual = {
    runners,
    nodes,
    targets,
    devices: devices.flat(),
    interfaces: interfaces.flat(),
    events: events.flat(),
    sessions,
    health_targets: healthTargets,
    users,
  };
  const clean = Object.values(residual).every((rows) => rows.length === 0);
  return { clean, ...residual };
}

async function closeExactE2EProfile(input) {
  const dataRoot = path.resolve(root, "runner", "data");
  const target = path.resolve(String(input ?? ""));
  if (!target.startsWith(dataRoot + path.sep) || !path.basename(target).startsWith("e2e-managed-telemetry-") || !existsSync(target)) throw new Error("Refusing non-E2E or missing profile path");
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

function Devtools(ws) { this.nextId = 1; this.pending = new Map(); this.open = () => new Promise((resolve, reject) => { this.socket = new WebSocket(ws); this.socket.onopen = resolve; this.socket.onerror = reject; this.socket.onmessage = (event) => { const message = JSON.parse(event.data); if (!message.id) return; const pending = this.pending.get(message.id); if (!pending) return; this.pending.delete(message.id); message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result); }; }); this.send = (method, params = {}) => { const id = this.nextId++; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params })); }); }; this.evaluate = async (expression) => { const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(`Browser expression failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`); return result.result.value; }; this.close = () => this.socket?.close(); }
async function waitFor(client, expression, timeout) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await client.evaluate(expression).catch(() => false)) return; await new Promise((resolve) => setTimeout(resolve, 250)); } throw new Error(`Browser wait timed out: ${expression}`); }
async function waitDevtoolsPort(directory) { const file = path.join(directory, "DevToolsActivePort"), deadline = Date.now() + 15_000; while (Date.now() < deadline) { if (existsSync(file)) return Number(readFileSync(file, "utf8").split(/\r?\n/)[0]); await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("Chrome DevTools unavailable"); }
async function expectJson(response) { if (!response.ok) throw new Error(`Chrome DevTools failed: HTTP ${response.status}`); return response.json(); }
function assert(condition, message) { if (!condition) throw new Error(message); }
function loadEnv(filename) { try { for (const raw of readFileSync(filename, "utf8").split(/\r?\n/)) { const line = raw.trim(); if (!line || line.startsWith("#")) continue; const index = line.indexOf("="); if (index < 1) continue; const key = line.slice(0, index).trim(); let value = line.slice(index + 1).trim(); if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1); if (process.env[key] === undefined) process.env[key] = value; } } catch {} }