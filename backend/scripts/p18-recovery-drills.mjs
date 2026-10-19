/** Real loopback HTTP/WebSocket, fake durable repository/claims/agent boundary.
 * No .env, database, credentials, external device or privileged collector. */
import assert from "node:assert/strict";
import { buildServer } from "../src/server.ts";
import { MonitoringRuntime } from "../src/runner-control/runtime.ts";
import { RunnerWorkService } from "../src/runner-work/service.ts";
import { BackendClient } from "../../runner/src/backend.mjs";
import { RunnerControlSocket } from "../../runner/src/control-socket.mjs";
import { runControlPlane } from "../../runner/src/control-plane.mjs";

const token = "p18-drill-fixture-credential-not-secret";
const runner = { id: "p18-drill", display_name: "P18 fixture", health_status: "online", health_error_code: null,
  capabilities: { source_locations: [], targets: [], durations: [5], traffic_durations_seconds: [300],
    operations: ["bandwidth_and_path", "traffic_live", "network_discovery", "device_inspect", "manual_ping"] } };
const queue = new Map(); const executed = []; const latencies = [];
const kinds = ["manual_ping", "traffic", "discovery", "device_inspector"];
const claims = { "/api/runner/network-health": "manual_ping", "/api/runner/traffic": "traffic",
  "/api/runner/network-discovery": "discovery", "/api/runner/device-inspector": "device_inspector" };
let healthyDatabase = true;
let running = false;
async function build(port = 0) {
  const runtime = new MonitoringRuntime(0);
  const repository = { available: async () => {
    if (!healthyDatabase) throw new Error("Simulated unavailable repository");
    return kinds.filter((kind) => queue.has(kind));
  }, recover: async () => {} };
  const service = new RunnerWorkService(repository);
  const server = buildServer({ logger: false, runnerWork: { token, service }, runnerControl: { token, service,
    work: repository, runtime, busy: async () => running || queue.size > 0,
    heartbeat: { upsertHeartbeat: async (row) => row, expireStaleTrafficSessions: async () => {} } } });
  for (const [path, kind] of Object.entries(claims)) {
    server.post(path, async (request, reply) => {
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      assert.equal(request.body.runner_id, runner.id);
      // Atomic fixture take. Production atomic SQL is covered by repository tests.
      const job = queue.get(kind) ?? null; queue.delete(kind);
      return reply.send({ data: job });
    });
  }
  server.post("/api/application/ping-jobs", async (_request, reply) => {
    queue.set("manual_ping", { id: "committed-ping", queuedAt: performance.now() });
    return reply.code(201).send({ data: { id: "committed-ping" } });
  });
  const origin = await server.listen({ host: "127.0.0.1", port });
  return { server, service, origin, runtime };
}
async function until(predicate) {
  const deadline = performance.now() + 15_000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, "Recovery drill deadline");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
let fixture = await build();
const backend = new BackendClient({ url: fixture.origin, token }, "local_postgres");
const control = new RunnerControlSocket({ url: fixture.origin, headers: backend.localBackendHeaders, runner: () => runner,
  sleep: async (_ms, signal) => { if (!signal.aborted) await new Promise((resolve) => setTimeout(resolve, 10)); } });
backend.control = control;
const shutdown = new AbortController();
const execute = Object.fromEntries(kinds.map((kind) => [kind, async (job) => {
  running = true; executed.push(`${kind}:${job.id}`); latencies.push({ kind, hint_to_execution_ms: performance.now() - job.queuedAt });
  running = false;
}]));
let dispatch;
let replacement;
let replacementDispatch;
const replacementShutdown = new AbortController();
try {
  // Job queued before connection: initial reconciliation must deliver it.
  queue.set("device_inspector", { id: "preconnect", queuedAt: performance.now() });
  control.start(); await until(() => control.healthy);
  dispatch = runControlPlane({ backend, runnerId: runner.id, manualPingEnabled: true, execute, signal: shutdown.signal });
  await until(() => executed.length === 1);
  await fetch(fixture.origin + "/api/application/ping-jobs", { method: "POST" });
  await until(() => executed.length === 2);
  assert.equal(executed[1], "manual_ping:committed-ping");
  // Queue all kinds, duplicate hints: one execution each, existing priority.
  for (const kind of kinds) queue.set(kind, { id: kind, queuedAt: performance.now() });
  for (let n = 0; n < 100; n++) fixture.service.wake(runner.id);
  await until(() => executed.length === 6);
  assert.deepEqual(executed.slice(2), kinds.map((kind) => `${kind}:${kind}`));
  assert.equal(new Set(executed).size, executed.length);
  // Lose transport, queue while disconnected, recover by durable reconciliation.
  control.socket.terminate();
  queue.set("discovery", { id: "disconnected", queuedAt: performance.now() });
  await until(() => executed.length === 7);
  // Simulated DB outage closes control; restoring it reconciles the retained job.
  healthyDatabase = false; fixture.service.wake(runner.id);
  await until(() => !control.healthy);
  queue.set("traffic", { id: "db-recovery", queuedAt: performance.now() }); healthyDatabase = true;
  await until(() => executed.length === 8);
  // Restart backend on same loopback port. Shared fixture queue represents PG
  // durability; this is not a real database restart or persistence benchmark.
  const port = Number(new URL(fixture.origin).port);
  await fixture.server.close(); queue.set("manual_ping", { id: "restart", queuedAt: performance.now() });
  fixture = await build(port);
  await until(() => executed.length === 9);
  assert.equal(executed.at(-1), "manual_ping:restart");
  assert.equal(fixture.runtime.snapshot().monitoring, false);
  // Cold runner restart has no cached hints and must re-read durable work.
  shutdown.abort(); await control.stop(); await dispatch;
  const replacementBackend = new BackendClient({ url: fixture.origin, token }, "local_postgres");
  replacement = new RunnerControlSocket({ url: fixture.origin, headers: replacementBackend.localBackendHeaders, runner: () => runner });
  replacementBackend.control = replacement;
  queue.set("device_inspector", { id: "runner-restart", queuedAt: performance.now() });
  replacement.start(); await until(() => replacement.healthy);
  replacementDispatch = runControlPlane({ backend: replacementBackend, runnerId: runner.id, manualPingEnabled: true,
    execute, signal: replacementShutdown.signal });
  await until(() => executed.length === 10);
  assert.equal(executed.at(-1), "device_inspector:runner-restart");
  assert.equal(new Set(executed).size, executed.length, "completed work is never replayed on either restart");
  console.log(JSON.stringify({ result: "PASS", boundary: "real sockets, fake PostgreSQL/claims/agents", executed, latencies,
    actual_traffic_rx_tx_snmp_discovery_fingerprints: "NOT RUN" }));
} finally {
  shutdown.abort(); await control.stop(); await dispatch; await fixture.server.close();
  replacementShutdown.abort(); await replacement?.stop(); await replacementDispatch;
}
