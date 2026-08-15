import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runnerEnv = envFile(path.join(root, "runner", ".env"));
const frontendEnv = envFile(path.join(root, "frontend", ".env.local"));
const url = runnerEnv.SUPABASE_URL;
const serviceKey = runnerEnv.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = frontendEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY || frontendEnv.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (!url || !serviceKey || !anonKey) throw new Error("Required local Supabase credentials are missing");
const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const fixture = randomUUID().slice(0, 8);
const runnerId = `health-e2e-${fixture}`;
const userIds = [];
const eventIds = [];
let nodeIds = [];

try {
  const before = await counts();
  must(await service.from("diagnostic_runners").insert({ id: runnerId, display_name: "Health E2E Runner", health_status: "online", capabilities: {} }));
  const insertedNodes = must(await service.from("network_nodes").insert([
    { ip_address: "192.0.2.10", name: "Health E2E Online", device_type: "server", location: "TEST" },
    { ip_address: "192.0.2.11", name: "Health E2E Disabled", device_type: "server", location: "TEST" },
  ]).select("id"));
  nodeIds = insertedNodes.map((row) => row.id);
  const targets = must(await service.from("network_targets").insert([
    { node_id: nodeIds[0], runner_id: runnerId, enabled: true, critical: true, probe_interval_seconds: 15, timeout_ms: 250 },
    { node_id: nodeIds[1], runner_id: runnerId, enabled: false, critical: false, probe_interval_seconds: 30, timeout_ms: 1000 },
  ]).select("id,enabled"));
  const enabledTarget = targets.find((target) => target.enabled);
  const listed = await invoke({ action: "list_targets", runner_id: runnerId });
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.deepEqual(listed.body.data.targets.map((target) => target.id), [enabledTarget.id]);

  const checked = new Date().toISOString();
  const onlineState = state(enabledTarget.id, "online", checked, 2, 0, 0, 1);
  let response = await invoke({ action: "publish", runner_id: runnerId, states: [onlineState], transitions: [] });
  assert.equal(response.status, 200);
  response = await invoke({ action: "publish", runner_id: runnerId, states: [onlineState], transitions: [] });
  assert.equal(response.status, 200);
  const latestCount = must(await service.from("network_health_latest").select("target_id", { count: "exact", head: true }).eq("target_id", enabledTarget.id), true).count;
  assert.equal(latestCount, 1);

  const offlineEvent = randomUUID(); eventIds.push(offlineEvent);
  const offlineState = state(enabledTarget.id, "offline", new Date().toISOString(), null, 100, 3, 5);
  const offlineTransition = transition(offlineEvent, enabledTarget.id, "online", "offline", offlineState);
  response = await invoke({ action: "publish", runner_id: runnerId, states: [offlineState], transitions: [offlineTransition] });
  assert.equal(response.status, 200); assert.equal(response.body.data.events, 1);
  response = await invoke({ action: "publish", runner_id: runnerId, states: [offlineState], transitions: [offlineTransition] });
  assert.equal(response.status, 200); assert.equal(response.body.data.events, 0);
  assert.equal(must(await service.from("events").select("id", { count: "exact", head: true }).eq("id", offlineEvent), true).count, 1);

  const recoveryEvent = randomUUID(); eventIds.push(recoveryEvent);
  const recoveryState = state(enabledTarget.id, "online", new Date().toISOString(), 1, 0, 0, 2);
  response = await invoke({ action: "publish", runner_id: runnerId, states: [recoveryState], transitions: [transition(recoveryEvent, enabledTarget.id, "offline", "online", recoveryState)] });
  assert.equal(response.status, 200);
  const recovered = must(await service.from("events").select("id,resolved_at").in("id", eventIds));
  assert.ok(recovered.every((event) => event.resolved_at));
  response = await invoke({ action: "publish", runner_id: runnerId, states: [{ ...onlineState, status: "broken" }], transitions: [] });
  assert.equal(response.status, 400);

  const viewer = await tempUser("viewer");
  const admin = await tempUser("admin");
  const viewerRead = await viewer.from("network_targets").select("id").eq("runner_id", runnerId);
  assert.equal(viewerRead.error, null); assert.equal(viewerRead.data.length, 2);
  const viewerLatest = await viewer.from("network_health_latest").select("target_id").eq("target_id", enabledTarget.id);
  const viewerEvents = await viewer.from("events").select("id").in("id", eventIds);
  assert.equal(viewerLatest.error, null); assert.equal(viewerLatest.data.length, 1);
  assert.equal(viewerEvents.error, null); assert.equal(viewerEvents.data.length, 2);
  const viewerWrite = await viewer.from("network_targets").update({ critical: false }).eq("id", enabledTarget.id).select("id");
  assert.ok(viewerWrite.error || viewerWrite.data.length === 0);
  const viewerLatestWrite = await viewer.from("network_health_latest").update({ status: "offline" }).eq("target_id", enabledTarget.id).select("target_id");
  assert.ok(viewerLatestWrite.error || viewerLatestWrite.data.length === 0);
  const viewerSession = await viewer.auth.getSession();
  const untrustedPublish = await fetch(`${url}/functions/v1/network-health`, { method: "POST", headers: { Authorization: `Bearer ${viewerSession.data.session.access_token}`, apikey: anonKey, "Content-Type": "application/json" }, body: JSON.stringify({ action: "publish", runner_id: runnerId, states: [offlineState], transitions: [] }) });
  assert.equal(untrustedPublish.status, 403);
  const adminWrite = await admin.from("network_targets").update({ critical: false }).eq("id", enabledTarget.id).select("id");
  assert.equal(adminWrite.error, null); assert.equal(adminWrite.data.length, 1);

  const after = await counts();
  assert.equal(after.traffic_metrics, before.traffic_metrics);
  assert.equal(after.non_health_events, before.non_health_events);
  console.log(JSON.stringify({ ok: true, enabled_filter: true, latest_single_row: true, transition_dedupe: true, recovery_resolve: true, invalid_rejected: true, viewer_target_latest_event_read: true, viewer_target_latest_write_rejected: true, untrusted_runner_publish_rejected: true, admin_write: true, traffic_metrics_unchanged: true, non_health_events_unchanged: true }));
} finally {
  if (eventIds.length) await service.from("events").delete().in("id", eventIds);
  if (nodeIds.length) await service.from("network_nodes").delete().in("id", nodeIds);
  await service.from("diagnostic_runners").delete().eq("id", runnerId);
  for (const id of userIds) await service.auth.admin.deleteUser(id);
}

async function tempUser(role) {
  const email = `health-e2e-${role}-${fixture}@example.invalid`;
  const password = `Health-${randomUUID()}-A1!`;
  const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) throw created.error ?? new Error("User creation failed");
  userIds.push(created.data.user.id);
  must(await service.from("profiles").update({ role, status: "approved", approved_at: new Date().toISOString(), approved_by: created.data.user.id }).eq("id", created.data.user.id));
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const signed = await client.auth.signInWithPassword({ email, password });
  if (signed.error) throw signed.error;
  return client;
}
async function counts() {
  const traffic = must(await service.from("traffic_metrics").select("id", { count: "exact", head: true }), true).count;
  const events = must(await service.from("events").select("id", { count: "exact", head: true }).neq("source", "network_health"), true).count;
  return { traffic_metrics: traffic, non_health_events: events };
}
async function invoke(body) {
  const response = await fetch(`${url}/functions/v1/network-health`, { method: "POST", headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
function state(targetId, status, lastCheckedAt, latency, loss, failures, samples) { return { target_id: targetId, status, latency_ms: latency, packet_loss_percent: loss, last_checked_at: lastCheckedAt, last_success_at: latency === null ? null : lastCheckedAt, consecutive_failures: failures, sample_count: samples }; }
function transition(eventId, targetId, previous, next, current) { return { event_id: eventId, target_id: targetId, previous_status: previous, new_status: next, occurred_at: current.last_checked_at, latency_ms: current.latency_ms, packet_loss_percent: current.packet_loss_percent, consecutive_failures: current.consecutive_failures }; }
function must(result, includeMetadata = false) { if (result.error) throw result.error; return includeMetadata ? result : result.data; }
function envFile(file) { const result = {}; for (const line of readFileSync(file, "utf8").split(/\r?\n/)) { const match = line.match(/^([A-Z0-9_]+)=(.*)$/); if (match) result[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, ""); } return result; }
