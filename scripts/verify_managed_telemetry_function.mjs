import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "frontend", "package.json"));
const { createClient } = require("@supabase/supabase-js");

loadEnv(path.join(root, "runner", ".env"));
loadEnv(path.join(root, "frontend", ".env.local"));
const url = (process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL)?.replace(/\/$/, "");
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !serviceKey || !anonKey) throw new Error("Function verification prerequisites are unavailable");

const fn = `${url}/functions/v1/managed-telemetry`;
const SECRET_RE = /"(?:password|passwd|secret|community|auth_password|priv_password|snmp2c_community_encrypted|credential)\s*"/i;
const stamp = `${Date.now()}-${randomBytes(3).toString("hex")}`;
const marker = `verify-fn-managed-telemetry-${stamp}`;
const runnerA = marker;
const runnerB = `${marker}-B`;
const runnerC = `${marker}-C`;
const nodeAId = randomUUID();
const nodeBId = randomUUID();
const nodeCId = randomUUID();
const nodeDId = randomUUID();
const targetA = randomUUID();
const targetB = randomUUID();
const targetC = randomUUID();
const targetD = randomUUID();
const eventDownId = randomUUID();
const eventErrId = randomUUID();
const eventUpId = randomUUID();
const openDownId = randomUUID();
const password = `Tmp-${randomBytes(18).toString("base64url")}!`;
const adminEmail = `${marker}-admin@example.invalid`;
const secretSentinel = "FN-SNMP-community-secret";
let adminId = null;
let adminToken = null;
  let adminRefresh = null;
let before = null;
let outcome = null;
let primaryError = null;
let cleanup = null;
let cleanupError = null;

try {
  assert(await tableExists("managed_telemetry_targets"), "Managed telemetry schema is not applied yet");
  before = await operationalSnapshot();
  adminId = await createUser(adminEmail, password);
  await createFixtures();

  const serviceHeaders = serviceHeadersFn();
  const publishBody = (runnerId, device, interfaces, transitions) => ({ action: "publish", runner_id: runnerId, device, interfaces, transitions });

  // --- 1. Authorization ------------------------------------------------------
  const browserPublish = await invoke({ ...publishBody(runnerA, validDevice(), []), },
    { Authorization: `Bearer ${anonKey}`, apikey: anonKey });
  assert(browserPublish.status === 403, `Browser-equivalent publish should be 403, got ${browserPublish.status}`);
  const garbagePublish = await invoke({ ...publishBody(runnerA, validDevice(), []), },
    { Authorization: "Bearer garbage-token", apikey: "garbage-token" });
  assert(garbagePublish.status === 401 || garbagePublish.status === 403, `Non-JWT publish should be rejected, got ${garbagePublish.status}`);
  const crossRunnerPublish = await invoke(publishBody(runnerA, validDevice(targetC), [validInterface(targetC, 1)]), serviceHeaders);
  assert(crossRunnerPublish.status === 403, `Cross-runner publish should be 403, got ${crossRunnerPublish.status}`);

  // --- 2. list_targets -------------------------------------------------------
  const listed = await invoke({ action: "list_targets", runner_id: runnerA }, serviceHeaders);
  assert(listed.status === 200, `list_targets status ${listed.status}`);
  const listedData = listed.body.data;
  assert(Array.isArray(listedData.targets), "list_targets data.targets missing");
  const targetIds = listedData.targets.map((t) => t.id);
  assert(targetIds.length === 2 && targetIds.includes(targetA) && targetIds.includes(targetB) && !targetIds.includes(targetC) && !targetIds.includes(targetD), "list_targets wrong target set");
  const listedA = listedData.targets.find((t) => t.id === targetA);
  for (const field of ["id", "node_id", "runner_id", "enabled", "credential_profile_ref", "snmp_version", "snmp_port", "poll_interval_seconds", "oper_error_threshold", "discard_threshold", "util_warning_percent", "util_critical_percent", "util_sustained_seconds", "config_updated_at", "ip_address", "name", "device_type", "location", "latest"]) {
    assert(field in listedA, `list_targets missing field ${field}`);
  }
  assert(listedA.enabled === true, "list_targets enabled flag wrong");
  assert(listedA.credential_profile_ref === "monitoring-readonly", "list_targets credential profile ref wrong");
  assert(listedA.latest === null, "target A latest should be null before publish");
  assert(!SECRET_RE.test(JSON.stringify(listedData)), "list_targets leaked a secret-shaped field");
  const disabled = await get(`managed_telemetry_targets?id=eq.${targetD}&select=id,enabled`);
  assert(disabled.length === 1 && disabled[0].enabled === false, "disabled target state was not preserved");
  const listedB = await invoke({ action: "list_targets", runner_id: runnerB }, serviceHeaders);
  assert(listedB.status === 200 && Array.isArray(listedB.body.data.targets) && listedB.body.data.targets.length === 0, "list_targets for empty runner should return empty array");

  // --- 3. publish bounded payload --------------------------------------------
  const device = validDevice();
  const interfaces = [1, 2, 3, 4, 5, 6].map((idx) => validInterface(targetA, idx));
  const transitions = [
    { event_id: eventDownId, target_id: targetA, kind: "interface_down", severity: "high", title: "Interface Gi0/2 is down", description: "Operational status changed from up to down.", raw_context: { target_id: targetA, if_index: 2, name: "Gi0/2" }, occurred_at: new Date().toISOString() },
    { event_id: eventErrId, target_id: targetA, kind: "errors_threshold", severity: "medium", title: "Interface Gi0/1 error spike", description: "6 new interface errors observed.", raw_context: { target_id: targetA, if_index: 1, name: "Gi0/1", error_delta: 6 }, occurred_at: new Date().toISOString() },
  ];
  const publish1 = await invoke(publishBody(runnerA, device, interfaces, transitions), serviceHeaders);
  if (publish1.status !== 200) console.error("PUBLISH_DEBUG", JSON.stringify(publish1));
  assert(publish1.status === 200, `publish status ${publish1.status} ${JSON.stringify(publish1.body)} ${publish1.raw}`);
  assert(publish1.body.data.devices === 1 && publish1.body.data.interfaces === 6 && publish1.body.data.events === 2, "publish result counts wrong");

  const deviceRows = await get(`managed_device_latest?target_id=eq.${targetA}&select=*`);
  assert(deviceRows.length === 1, "device latest upsert wrong");
  assert(deviceRows[0].sys_name === device.sys_name && deviceRows[0].status === "connected" && deviceRows[0].last_success_at, "device latest content wrong");
  const interfaceRows = await get(`managed_interface_latest?target_id=eq.${targetA}&select=if_index,name,is_physical`);
  assert(interfaceRows.length === 6, "interface batch upsert wrong");
  assert(interfaceRows.map((r) => r.if_index).sort((a, b) => a - b).join(",") === "1,2,3,4,5,6", "interface batch indexes wrong");
  for (const eventId of [eventDownId, eventErrId]) {
    const events = await get(`events?id=eq.${eventId}&select=id,source,source_ref,severity,title,resolved_at,raw_context`);
    assert(events.length === 1, "published event missing");
    assert(events[0].source === "managed_telemetry" && events[0].source_ref === targetA && events[0].raw_context.kind && events[0].resolved_at === null, "published event shape wrong");
  }

  // --- 4. event dedup --------------------------------------------------------
  const dedup = await invoke(publishBody(runnerA, { ...device, uptime_seconds: 120000 }, interfaces, transitions), serviceHeaders);
  assert(dedup.status === 200 && dedup.body.data.events === 0, "duplicate transitions should insert 0 events");

  // --- 5. recovery resolution ------------------------------------------------
  const nowIso = new Date().toISOString();
  await rest("events", "POST", { id: openDownId, created_at: nowIso, severity: "high", title: "Open interface down", source: "managed_telemetry", source_ref: targetA, raw_context: { kind: "interface_down", if_index: 2, name: "Gi0/2", target_id: targetA } });
  const recovery = await invoke(publishBody(runnerA, device, interfaces, [
    { event_id: eventUpId, target_id: targetA, kind: "interface_up", severity: "low", title: "Interface Gi0/2 recovered", raw_context: { target_id: targetA, if_index: 2, name: "Gi0/2" }, occurred_at: nowIso },
  ]), serviceHeaders);
  assert(recovery.status === 200 && recovery.body.data.events === 1, "recovery publish events wrong");
  const openAfter = await get(`events?id=eq.${openDownId}&select=id,resolved_at`);
  assert(openAfter.length === 1 && openAfter[0].resolved_at !== null && Date.parse(openAfter[0].resolved_at) === Date.parse(nowIso), "open interface_down event not resolved");
  const downEventAfter = await get(`events?id=eq.${eventDownId}&select=id,resolved_at`);
  assert(downEventAfter.length === 1 && downEventAfter[0].resolved_at !== null && Date.parse(downEventAfter[0].resolved_at) === Date.parse(nowIso), "duplicate interface_down event not resolved");
  const upEvent = await get(`events?id=eq.${eventUpId}&select=id,resolved_at`);
  assert(upEvent.length === 1 && upEvent[0].resolved_at === null, "recovery event itself should stay open");

  // --- 6. stale cleanup scope ------------------------------------------------
  const stalePublish = await invoke(publishBody(runnerA, device, [validInterface(targetA, 1), validInterface(targetA, 2), validInterface(targetA, 3)], []), serviceHeaders);
  assert(stalePublish.status === 200 && stalePublish.body.data.interfaces === 3, "stale-cleanup publish wrong");
  const afterStale = await get(`managed_interface_latest?target_id=eq.${targetA}&select=if_index`);
  assert(afterStale.length === 3 && afterStale.map((r) => r.if_index).sort((a, b) => a - b).join(",") === "1,2,3", "stale interfaces for target A not cleaned");
  const targetBInterfaces = await get(`managed_interface_latest?target_id=eq.${targetB}&select=if_index`);
  assert(targetBInterfaces.length === 3 && targetBInterfaces.map((r) => r.if_index).sort((a, b) => a - b).join(",") === "100,101,102", "stale cleanup leaked into another target");
  const targetCInterfaces = await get(`managed_interface_latest?target_id=eq.${targetC}&select=if_index`);
  assert(targetCInterfaces.length === 1 && targetCInterfaces[0].if_index === 900, "target C interface rows changed");

  // --- 7. payload limits and secret-key rejection ----------------------------
  const overCount = await invoke(publishBody(runnerA, device, Array.from({ length: 201 }, (_, i) => validInterface(targetA, i)), []), serviceHeaders);
  assert(overCount.status === 400, "over-200 interface payload should be rejected");
  const oversized = await invoke(publishBody(runnerA, device, Array.from({ length: 200 }, (_, i) => ({ ...validInterface(targetA, i), name: "x".repeat(128), description: "x".repeat(128) })), []), serviceHeaders);
  assert(oversized.status === 400, "over-64KiB payload should be rejected");
  const secretPayload = await invoke(publishBody(runnerA, { ...validDevice(), community: secretSentinel }, [validInterface(targetA, 1)], []), serviceHeaders);
  assert(secretPayload.status === 400, "payload carrying a secret-shaped key should be rejected");

  // --- 8. Realtime-compatible latest state ----------------------------------
  let realtimeObserved = null;
  try {
    realtimeObserved = await realtimeProbe(marker, targetA, "Core-ASW-01-REALTIME", adminToken, adminRefresh, async () => {
      const realtimePublish = await invoke(publishBody(runnerA, { ...device, sys_name: "Core-ASW-01-REALTIME" }, [validInterface(targetA, 1), validInterface(targetA, 2), validInterface(targetA, 3)], []), serviceHeaders);
      assert(realtimePublish.status === 200, `realtime publish failed ${realtimePublish.status}`);
    });
  } catch (error) {
    assert(false, `Realtime delivery of function-produced state failed: ${error.message}`);
  }

  // --- 9. approved-read RLS + no secrets persisted ---------------------------
  const rlsDevice = await fetch(`${url}/rest/v1/managed_device_latest?target_id=eq.${targetA}&select=sys_name,status`, { headers: { Authorization: `Bearer ${adminToken}`, apikey: anonKey } });
  assert(rlsDevice.status === 200, `approved RLS read status ${rlsDevice.status}`);
  const rlsDeviceRows = await rlsDevice.json();
  assert(Array.isArray(rlsDeviceRows) && rlsDeviceRows.some((row) => row.sys_name === "Core-ASW-01-REALTIME"), "approved RLS cannot read function-produced device latest");
  const rlsTarget = await fetch(`${url}/rest/v1/managed_telemetry_targets?id=eq.${targetA}&select=id,credential_profile_ref`, { headers: { Authorization: `Bearer ${adminToken}`, apikey: anonKey } });
  assert(rlsTarget.status === 200, "approved RLS cannot read target config");
  const targetConfig = await get(`managed_telemetry_targets?id=eq.${targetA}&select=id,credential_profile_ref,snmp2c_community_encrypted`);
  assert(targetConfig.length === 1 && targetConfig[0].snmp2c_community_encrypted === null, "secret column populated");
  assert(!JSON.stringify(targetConfig).includes(secretSentinel), "secret persisted in target row");
  const storedEvents = await get(`events?id=in.(${eventDownId},${eventErrId},${eventUpId})&select=id,raw_context`);
  assert(!JSON.stringify(storedEvents).includes(secretSentinel), "secret persisted in event rows");

  // --- 10. list_targets reflects latest --------------------------------------
  const listedAgain = await invoke({ action: "list_targets", runner_id: runnerA }, serviceHeaders);
  const listedAAgain = listedAgain.body.data.targets.find((t) => t.id === targetA);
  assert(listedAAgain.latest && listedAAgain.latest.status === "connected" && listedAAgain.latest.last_polled_at, "list_targets latest missing after publish");

  outcome = {
    ok: true, fixture_marker: marker,
    fixture_ids: { admin_user: adminId, runner_a: runnerA, runner_b: runnerB, runner_c: runnerC, node_a: nodeAId, node_b: nodeBId, node_c: nodeCId, target_a: targetA, target_b: targetB, target_c: targetC, event_down: eventDownId, event_err: eventErrId, event_up: eventUpId, open_down: openDownId },
    browser_publish_rejected: true, non_jwt_rejected: true, cross_runner_rejected: true,
    list_targets_scoped: true, list_targets_empty_runner: true, list_targets_shape: true,
    publish_accepted: true, device_upsert: true, interface_upsert: true,
    event_insert: true, event_dedup: true, recovery_resolution: true,
    stale_cleanup_scoped: true, other_target_unaffected: true,
    interface_count_limit: true, payload_size_limit: true, secret_key_rejected: true,
    realtime_delivery: true, approved_read_rls: true, no_secrets_persisted: true,
    list_targets_latest: true,
  };
} catch (error) {
  primaryError = error;
} finally {
  try {
    cleanup = await cleanupFixtures();
  } catch (error) {
    cleanupError = error;
  }
}

if (cleanupError) throw cleanupError;
if (primaryError) {
  console.error(JSON.stringify({ ok: false, cleanup }, null, 2));
  throw primaryError;
}
console.log(JSON.stringify({ ...outcome, cleanup }, null, 2));

async function realtimeProbe(channelTag, targetId, expectedSysName, accessToken, refreshToken, trigger) {
  return await new Promise((resolve, reject) => {
    const supabase = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const state = { subscribed: false, sawSysName: null, sawOther: [] };
    const finish = (error) => {
      clearTimeout(timer);
      try { supabase.removeChannel(channel); } catch {}
      if (error) reject(new Error(`${error.message} (subscribed=${state.subscribed}, sawSysName=${state.sawSysName ?? "null"}, otherEvents=${state.sawOther.length})`));
      else resolve(true);
    };
    const timer = setTimeout(() => finish(new Error("realtime delivery timeout")), 25_000);
    const channel = supabase.channel(channelTag, { config: { private: false } });
    channel
      .on("postgres_changes", { event: "*", schema: "public", table: "managed_device_latest", filter: `target_id=eq.${targetId}` }, (payload) => {
        const sysName = payload?.new?.sys_name ?? null;
        if (sysName === expectedSysName) { state.sawSysName = sysName; finish(null); }
        else state.sawOther.push(`${payload?.eventType ?? "?"}:${sysName}`);
      });
    supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken ?? "" })
      .then(() => {
        channel.subscribe(async (status, error) => {
          if (status === "SUBSCRIBED") {
            state.subscribed = true;
            setTimeout(async () => {
              try { await trigger(); } catch (e) { finish(e); }
            }, 600);
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            finish(new Error(`realtime ${status}: ${error?.message ?? ""}`));
          }
        });
      })
      .catch((e) => finish(new Error(`realtime setSession failed: ${e.message}`)));
  });
}

async function createUser(email, userPassword) {
  const response = await fetch(`${url}/auth/v1/admin/users`, { method: "POST", headers: { ...serviceHeadersFn(), "Content-Type": "application/json" }, body: JSON.stringify({ email, password: userPassword, email_confirm: true }) });
  const user = await response.json();
  if (!response.ok || !user.id) throw new Error("Could not create admin fixture user");
  await rest(`profiles?id=eq.${user.id}`, "PATCH", { status: "approved", role: "admin", approved_at: new Date().toISOString() });
  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: anonKey, "Content-Type": "application/json" }, body: JSON.stringify({ email, password: userPassword }) });
  const loginData = await login.json();
  if (!login.ok || !loginData.access_token) throw new Error("Admin fixture login failed");
  adminToken = loginData.access_token;
  adminRefresh = loginData.refresh_token ?? null;
  return user.id;
}

async function createFixtures() {
  const now = new Date().toISOString();
  const capability = { fixture_marker: marker, operations: ["device_inspect", "snmp_telemetry"], snmp_telemetry: { enabled: true, max_concurrent: 2, poll_intervals_seconds: [30, 60], versions: ["3", "2c"], credential_profiles: ["monitoring-readonly", "core-readonly"] }, device_inspector: { available: true, probe_engine: "python_socket" } };
  await rest("diagnostic_runners", "POST", { id: runnerA, display_name: `${marker} runner A`, last_seen_at: now, health_status: "online", health_error_code: null, capabilities: capability });
  await rest("diagnostic_runners", "POST", { id: runnerB, display_name: `${marker} runner B`, last_seen_at: now, health_status: "online", health_error_code: null, capabilities: capability });
  await rest("diagnostic_runners", "POST", { id: runnerC, display_name: `${marker} runner C`, last_seen_at: now, health_status: "online", health_error_code: null, capabilities: capability });
  await rest("network_nodes", "POST", { id: nodeAId, ip_address: "192.168.88.211/32", name: `${marker} Core-ASW-01`, device_type: "managed_switch", location: "Synthetic fixture", created_at: now, updated_at: now });
  await rest("network_nodes", "POST", { id: nodeBId, ip_address: "192.168.88.212/32", name: `${marker} Core-DSW-02`, device_type: "layer3_switch", location: "Synthetic fixture", created_at: now, updated_at: now });
  await rest("network_nodes", "POST", { id: nodeCId, ip_address: "192.168.88.213/32", name: `${marker} Core-ASW-03`, device_type: "managed_switch", location: "Synthetic fixture", created_at: now, updated_at: now });
  await rest("network_nodes", "POST", { id: nodeDId, ip_address: "192.168.88.214/32", name: `${marker} Disabled-ASW-04`, device_type: "managed_switch", location: "Synthetic fixture", created_at: now, updated_at: now });
  for (const [targetId, nodeId, runnerId] of [[targetA, nodeAId, runnerA], [targetB, nodeBId, runnerA], [targetC, nodeCId, runnerC]]) {
    await rest("managed_telemetry_targets", "POST", { id: targetId, node_id: nodeId, runner_id: runnerId, enabled: true, credential_profile_ref: "monitoring-readonly", snmp_version: "3", snmp_port: 161, poll_interval_seconds: 60, oper_error_threshold: 5, discard_threshold: 10, util_warning_percent: 80, util_critical_percent: 95, util_sustained_seconds: 300, created_by: adminId, created_at: now, updated_at: now });
  }
  await rest("managed_telemetry_targets", "POST", { id: targetD, node_id: nodeDId, runner_id: runnerA, enabled: false, credential_profile_ref: "monitoring-readonly", snmp_version: "3", snmp_port: 161, poll_interval_seconds: 60, oper_error_threshold: 5, discard_threshold: 10, util_warning_percent: 80, util_critical_percent: 95, util_sustained_seconds: 300, created_by: adminId, created_at: now, updated_at: now });
  const now2 = new Date().toISOString();
  await rest("managed_device_latest", "POST", { target_id: targetB, status: "connected", sys_name: `${marker}-DSW`, last_polled_at: now2, last_success_at: now2, consecutive_poll_failures: 0, updated_at: now2 });
  for (const idx of [100, 101, 102]) await rest("managed_interface_latest", "POST", { target_id: targetB, if_index: idx, name: `Eth${idx}`, is_physical: true, admin_status: "up", oper_status: "up", speed_bps: 1000000000, last_polled_at: now2, updated_at: now2 });
  await rest("managed_device_latest", "POST", { target_id: targetC, status: "connected", sys_name: `${marker}-ASW3`, last_polled_at: now2, last_success_at: now2, consecutive_poll_failures: 0, updated_at: now2 });
  await rest("managed_interface_latest", "POST", { target_id: targetC, if_index: 900, name: "Eth900", is_physical: true, admin_status: "up", oper_status: "up", speed_bps: 1000000000, last_polled_at: now2, updated_at: now2 });
}

function validDevice(targetId = targetA) {
  return {
    target_id: targetId, status: "connected", sys_name: "Core-ASW-01", sys_descr: "Juniper EX4300 synthetic switch",
    sys_object_id: "1.3.6.1.4.1.2636.1.1.1.4.84.0", uptime_seconds: 90061, manufacturer: "Juniper Networks",
    model: "EX4300-24P", serial_number: "SN-TEL-0001", last_polled_at: new Date().toISOString(),
    last_success_at: new Date().toISOString(), consecutive_poll_failures: 0, error_category: null,
  };
}

function validInterface(targetId, ifIndex) {
  return {
    target_id: targetId, if_index: ifIndex, name: `Gi0/${ifIndex}`, description: `GE-0/0/${ifIndex} synthetic`,
    if_type: 6, is_physical: true, admin_status: "up", oper_status: "up", speed_bps: 1000000000,
    rx_rate_bps: 125000000, tx_rate_bps: 250000000, rx_util_percent: 12.5, tx_util_percent: 25,
    rx_errors_cumulative: 100, tx_errors_cumulative: 50, in_discards_cumulative: 200, out_discards_cumulative: 100,
    rx_errors_delta: 2, tx_errors_delta: 0, in_discards_delta: 5, out_discards_delta: 0,
    last_polled_at: new Date().toISOString(),
  };
}

async function cleanupFixtures() {
  for (const id of [eventUpId, openDownId, eventErrId, eventDownId]) await remove(`events?id=eq.${id}`);
  for (const targetId of [targetA, targetB, targetC, targetD]) {
    await remove(`managed_interface_latest?target_id=eq.${targetId}`);
    await remove(`managed_device_latest?target_id=eq.${targetId}`);
    await remove(`managed_telemetry_targets?id=eq.${targetId}`);
  }
  await remove(`network_nodes?id=eq.${nodeAId}`);
  await remove(`network_nodes?id=eq.${nodeBId}`);
  await remove(`network_nodes?id=eq.${nodeCId}`);
  await remove(`network_nodes?id=eq.${nodeDId}`);
  await remove(`diagnostic_runners?id=eq.${encodeURIComponent(runnerA)}`);
  await remove(`diagnostic_runners?id=eq.${encodeURIComponent(runnerB)}`);
  await remove(`diagnostic_runners?id=eq.${encodeURIComponent(runnerC)}`);
  if (adminId) await removeUser(adminId);
  const checks = {
    admin_user: adminId ? await userAbsent(adminId) : true,
    runner_a: await absent(`diagnostic_runners?id=eq.${encodeURIComponent(runnerA)}&select=id`),
    runner_b: await absent(`diagnostic_runners?id=eq.${encodeURIComponent(runnerB)}&select=id`),
    runner_c: await absent(`diagnostic_runners?id=eq.${encodeURIComponent(runnerC)}&select=id`),
    node_a: await absent(`network_nodes?id=eq.${nodeAId}&select=id`),
    node_b: await absent(`network_nodes?id=eq.${nodeBId}&select=id`),
    node_c: await absent(`network_nodes?id=eq.${nodeCId}&select=id`),
    node_d: await absent(`network_nodes?id=eq.${nodeDId}&select=id`),
    target_a: await absent(`managed_telemetry_targets?id=eq.${targetA}&select=id`),
    target_b: await absent(`managed_telemetry_targets?id=eq.${targetB}&select=id`),
    target_c: await absent(`managed_telemetry_targets?id=eq.${targetC}&select=id`),
    target_d: await absent(`managed_telemetry_targets?id=eq.${targetD}&select=id`),
    device_a: await absent(`managed_device_latest?target_id=eq.${targetA}&select=target_id`),
    device_b: await absent(`managed_device_latest?target_id=eq.${targetB}&select=target_id`),
    device_c: await absent(`managed_device_latest?target_id=eq.${targetC}&select=target_id`),
    interface_a: await absent(`managed_interface_latest?target_id=eq.${targetA}&select=target_id`),
    interface_b: await absent(`managed_interface_latest?target_id=eq.${targetB}&select=target_id`),
    interface_c: await absent(`managed_interface_latest?target_id=eq.${targetC}&select=target_id`),
    event_down: await absent(`events?id=eq.${eventDownId}&select=id`),
    event_err: await absent(`events?id=eq.${eventErrId}&select=id`),
    event_up: await absent(`events?id=eq.${eventUpId}&select=id`),
    open_down: await absent(`events?id=eq.${openDownId}&select=id`),
  };
  assert(Object.values(checks).every(Boolean), `Fixture cleanup failed: ${Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name).join(", ")}`);
  const after = await operationalSnapshot();
  const diffs = Object.keys(before).filter((key) => before[key] !== after[key]);
  assert(diffs.length === 0, `Operational counts changed after cleanup: ${diffs.join(", ")}`);
  return { verified: true, checks, operational_counts_restored: true, operations_unchanged: after };
}

async function operationalSnapshot() {
  const tables = ["events", "traffic_metrics", "flows", "network_nodes", "network_targets", "network_health_latest", "diagnostic_runners", "diagnostic_jobs", "hop_measurements", "traffic_live_sessions", "traffic_live_snapshots", "device_inspection_sessions", "managed_telemetry_targets", "managed_device_latest", "managed_interface_latest"];
  const values = await Promise.all(tables.map(count));
  return Object.fromEntries(tables.map((table, index) => [table, values[index]]));
}

async function invoke(body, headers) {
  const response = await fetch(fn, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const text = await response.text();
  let payload = {};
  try { payload = JSON.parse(text); } catch {}
  return { status: response.status, body: payload, raw: text.slice(0, 500) };
}

function serviceHeadersFn() { return { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey }; }
function headers() { return serviceHeadersFn(); }

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

function assert(condition, message) { if (!condition) throw new Error(message); }

function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}
