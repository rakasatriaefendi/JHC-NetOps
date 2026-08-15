import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadRunnerConfig } from "../src/config.mjs";
import { runPreflight } from "../src/wsl.mjs";

const runnerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = loadRunnerConfig(path.join(runnerRoot, "config.local.json"));
runPreflight(config);

const target = config.targets.find((item) => item.environment === "localhost_demo");
if (!target) throw new Error("A localhost_demo target is required");

const durationSeconds = Number(process.env.E2E_DURATION_SECONDS ?? 10);
if (!config.durations.includes(durationSeconds)) {
  throw new Error("E2E_DURATION_SECONDS must exist in the runner duration allow-list");
}

const url = process.env.SUPABASE_URL.replace(/\/$/, "");
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const headers = { Authorization: `Bearer ${key}`, apikey: key, "Content-Type": "application/json" };

const active = await rest("diagnostic_jobs?select=id&runner_id=eq." + encodeURIComponent(config.runner_id) + "&status=in.(queued,running)");
if (active.length) throw new Error("Runner already has an active job");
const admins = await rest("profiles?select=id&role=eq.admin&status=eq.approved&limit=1");
if (!admins[0]?.id) throw new Error("No approved admin profile is available");

const [runnerBefore] = await runnerState();
assert(runnerBefore, "Runner heartbeat row was not found");
assert(heartbeatAge(runnerBefore) <= 30, "Runner was offline before the test");

const before = await counts();
const inserted = await rest("diagnostic_jobs", {
  method: "POST",
  headers: { Prefer: "return=representation" },
  body: {
    runner_id: config.runner_id,
    requested_by: admins[0].id,
    status: "queued",
    type: "bandwidth_and_path",
    source_label: config.source_locations[0],
    target_id: target.id,
    target_label: target.label,
    target_host: target.host,
    iperf_port: target.iperf_port,
    connection_type: "wifi",
    duration_seconds: durationSeconds,
    environment: "localhost_demo",
    stage: "queued",
    progress: {},
  },
});
const jobId = inserted[0].id;

let sawLiveMbps = false;
let heartbeatChanged = false;
let maxHeartbeatAgeSeconds = 0;
const stages = new Set(["queued"]);
const deadline = Date.now() + (durationSeconds * 2 + 120) * 1000;
let job;

while (Date.now() < deadline) {
  const [state] = await rest(`diagnostic_jobs?select=*&id=eq.${jobId}`);
  const [runner] = await runnerState();
  if (state) {
    job = state;
    stages.add(state.stage);
    if (typeof state.progress?.current_mbps === "number") sawLiveMbps = true;
  }
  if (runner) {
    maxHeartbeatAgeSeconds = Math.max(maxHeartbeatAgeSeconds, heartbeatAge(runner));
    heartbeatChanged ||= runner.last_seen_at !== runnerBefore.last_seen_at;
  }
  if (job?.status === "completed" || job?.status === "failed") break;
  await delay(250);
}

const bandwidth = await rest(`bandwidth_measurements?select=*&job_id=eq.${jobId}&order=direction.asc`);
const hops = await rest(`hop_measurements?select=*&job_id=eq.${jobId}&order=hop_number.asc`);
const after = await counts();

assert(job?.status === "completed" && job.stage === "complete", "Job did not complete");
assert(Object.keys(job.progress).length === 0, "Completed job retained temporary progress");
assert(bandwidth.length === 2, "Expected exactly two bandwidth rows");
assert(new Set(bandwidth.map((row) => row.direction)).size === 2, "Upload/download directions are incomplete");
assert(bandwidth.every((row) => row.bitrate_mbps > 0 && row.environment === "localhost_demo"), "Bandwidth semantics are invalid");
assert(hops.length >= 1 && hops.every((row) => row.environment === "localhost_demo"), "MTR result is invalid");
assert(after.events === before.events, "events count changed");
assert(after.traffic_metrics === before.traffic_metrics, "traffic_metrics count changed");
assert(after.bandwidth_measurements === before.bandwidth_measurements + 2, "Bandwidth row count delta is not two");
assert(after.hop_measurements === before.hop_measurements + hops.length, "Hop row count delta is invalid");
assert(sawLiveMbps, "Live Mbps was not observed in job progress");
assert(heartbeatChanged, "Runner heartbeat did not update while the job was active");
assert(maxHeartbeatAgeSeconds <= 30, "Runner heartbeat became stale while the job was active");

console.log(JSON.stringify({
  job_id: jobId,
  status: job.status,
  stages_observed: [...stages],
  live_mbps_observed: sawLiveMbps,
  heartbeat_updated_during_job: heartbeatChanged,
  max_heartbeat_age_seconds: Number(maxHeartbeatAgeSeconds.toFixed(1)),
  bandwidth: bandwidth.map((row) => ({ direction: row.direction, bitrate_mbps: row.bitrate_mbps, retransmits: row.retransmits })),
  hops: hops.map((row) => ({ hop: row.hop_number, ip: row.hop_ip, avg_latency_ms: row.avg_latency_ms, loss_percent: row.loss_percent })),
  count_delta: { bandwidth_measurements: 2, hop_measurements: hops.length, events: 0, traffic_metrics: 0 },
  environment: "localhost_demo",
}, null, 2));

async function counts() {
  return {
    bandwidth_measurements: await count("bandwidth_measurements"),
    hop_measurements: await count("hop_measurements"),
    events: await count("events"),
    traffic_metrics: await count("traffic_metrics"),
  };
}

async function count(table) {
  const response = await fetch(`${url}/rest/v1/${table}?select=id`, { method: "HEAD", headers: { ...headers, Prefer: "count=exact" } });
  if (!response.ok) throw new Error(`Count failed for ${table}`);
  return Number(response.headers.get("content-range")?.split("/")[1] ?? 0);
}

function runnerState() {
  return rest(`diagnostic_runners?select=id,last_seen_at&id=eq.${encodeURIComponent(config.runner_id)}`);
}

async function rest(resource, options = {}) {
  const response = await fetch(`${url}/rest/v1/${resource}`, {
    method: options.method ?? "GET",
    headers: { ...headers, ...(options.headers ?? {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!response.ok) throw new Error(`Database verification request failed with HTTP ${response.status}`);
  return response.status === 204 ? [] : response.json();
}

function heartbeatAge(runner) {
  return Math.max(0, (Date.now() - new Date(runner.last_seen_at).getTime()) / 1000);
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function assert(condition, message) { if (!condition) throw new Error(message); }
