import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const env = envFile(path.join(root, "runner", ".env"));
const config = JSON.parse(readFileSync(path.join(root, "runner", "config.local.json"), "utf8"));
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const suffix = randomUUID().slice(0, 8);
let nodeIds = [], targetIds = [];
const trafficBefore = await count("traffic_metrics");
const nonHealthBefore = await nonHealthCount();

try {
  const runner = must(await db.from("diagnostic_runners").select("id").eq("id", config.runner_id).maybeSingle());
  assert.ok(runner, "Configured runner has not registered in Supabase");
  const nodes = must(await db.from("network_nodes").insert([
    { ip_address: "127.0.0.1", name: `Health Live Loopback ${suffix}`, device_type: "server", location: "TEST FIXTURE" },
    { ip_address: "198.51.100.254", name: `Health Live Recovery ${suffix}`, device_type: "server", location: "TEST FIXTURE" },
  ]).select("id"));
  nodeIds = nodes.map((node) => node.id);
  const targets = must(await db.from("network_targets").insert(nodes.map((node) => ({ node_id: node.id, runner_id: config.runner_id, enabled: true, critical: true, probe_interval_seconds: 15, timeout_ms: 250, failure_threshold: 3, recovery_threshold: 2, latency_warning_ms: 100, loss_warning_percent: 40 }))).select("id,node_id"));
  targetIds = targets.map((target) => target.id);
  restartRunner();
  console.log("Runner restarted; waiting for concurrent ONLINE/OFFLINE state...");
  await waitFor(async () => {
    const latest = must(await db.from("network_health_latest").select("target_id,status,last_checked_at").in("target_id", targetIds));
    return latest.length === 2 && latest.some((row) => row.target_id === targetIds[0] && row.status === "online") && latest.some((row) => row.target_id === targetIds[1] && row.status === "offline");
  }, 90_000);
  assert.equal(await latestCount(), 2);
  const offlineEvents = must(await db.from("events").select("id").eq("source", "network_health").eq("source_ref", targetIds[1]));
  assert.equal(offlineEvents.length, 1, "OFFLINE transition should create exactly one event");

  restartRunner();
  await delay(4_000);
  assert.equal(await latestCount(), 2, "Restart must not duplicate latest rows");
  const cacheAfterRestart = JSON.parse(readFileSync(path.join(root, "runner", "data", "network-health-state.json"), "utf8"));
  assert.ok(cacheAfterRestart.states?.[targetIds[1]], "Local state must survive runner restart");

  must(await db.from("network_nodes").update({ ip_address: "127.0.0.2" }).eq("id", nodeIds[1]));
  console.log("Failure target changed to controlled loopback; waiting for two-success recovery...");
  await waitFor(async () => {
    const row = must(await db.from("network_health_latest").select("status").eq("target_id", targetIds[1]).maybeSingle());
    return row?.status === "online";
  }, 90_000);
  const transitions = must(await db.from("events").select("id,resolved_at,raw_context").eq("source", "network_health").eq("source_ref", targetIds[1]).order("created_at"));
  assert.equal(transitions.length, 2); assert.ok(transitions.every((event) => event.resolved_at));
  const heartbeat = must(await db.from("diagnostic_runners").select("last_seen_at").eq("id", config.runner_id).single());
  assert.ok(Date.now() - Date.parse(heartbeat.last_seen_at) < 30_000, "Heartbeat must remain fresh during health probes");
  assert.equal(await count("traffic_metrics"), trafficBefore);
  assert.equal(await nonHealthCount(), nonHealthBefore);
  console.log(JSON.stringify({ ok: true, one_target_online: true, concurrent_targets: 2, threshold_offline: true, recovery_two_successes: true, latest_rows: 2, transition_events: 2, restart_state_persisted: true, heartbeat_responsive: true, traffic_metrics_unchanged: true, non_health_events_unchanged: true }));
} finally {
  if (targetIds.length) await db.from("events").delete().eq("source", "network_health").in("source_ref", targetIds);
  if (nodeIds.length) await db.from("network_nodes").delete().in("id", nodeIds);
  restartRunner(false);
}

function restartRunner(required = true) {
  const result = spawnSync("powershell.exe", ["-ExecutionPolicy", "Bypass", "-File", path.join(root, "runner", "task.ps1"), "restart"], { encoding: "utf8", windowsHide: true });
  if (required && result.status !== 0) throw new Error(`Runner restart failed: ${result.stderr || result.stdout}`);
}
async function waitFor(check, timeout) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await check()) return; await delay(3_000); } throw new Error("Timed out waiting for runner health state"); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function latestCount() { const result = await db.from("network_health_latest").select("target_id", { count: "exact", head: true }).in("target_id", targetIds); if (result.error) throw result.error; return result.count; }
async function count(table) { const result = await db.from(table).select("id", { count: "exact", head: true }); if (result.error) throw result.error; return result.count; }
async function nonHealthCount() { const result = await db.from("events").select("id", { count: "exact", head: true }).neq("source", "network_health"); if (result.error) throw result.error; return result.count; }
function must(result) { if (result.error) throw result.error; return result.data; }
function envFile(file) { const result = {}; for (const line of readFileSync(file, "utf8").split(/\r?\n/)) { const match = line.match(/^([A-Z0-9_]+)=(.*)$/); if (match) result[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, ""); } return result; }
