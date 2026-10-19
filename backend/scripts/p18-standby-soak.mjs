/** Local real-socket soak; PostgreSQL/agent boundaries are deterministic fakes.
 * Run from backend: node --import tsx scripts/p18-standby-soak.mjs
 * Never loads .env, runner config, credentials or an actual PostgreSQL connection. */
import assert from "node:assert/strict";
import { buildServer } from "../src/server.ts";
import { MonitoringRuntime } from "../src/runner-control/runtime.ts";
import { RunnerWorkService } from "../src/runner-work/service.ts";
import { BackendClient } from "../../runner/src/backend.mjs";
import { RunnerControlSocket } from "../../runner/src/control-socket.mjs";
import { NetworkHealthWatch } from "../../runner/src/network-health.mjs";
import { ManagedTelemetryWatch } from "../../runner/src/snmp-telemetry.mjs";
import { startHeartbeatLoop } from "../../runner/src/heartbeat.mjs";
import { runControlPlane } from "../../runner/src/control-plane.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const duration = 300_000;
const token = "p18-local-soak-fixture-token-not-secret";
const runner = { id: "p18-fixture", display_name: "P18 local fixture", health_status: "online", health_error_code: null,
  capabilities: { source_locations: [], targets: [], durations: [5], traffic_durations_seconds: [300],
    operations: ["bandwidth_and_path", "traffic_live", "network_discovery", "device_inspect", "manual_ping"] } };
const calls = { available: 0, recovery: 0, busy: 0, heartbeat: 0, probes: 0, http: 0, ping: 0, pong: 0 };
const routes = [];
const work = { available: async () => { calls.available++; return []; }, recover: async () => { calls.recovery++; } };
const service = new RunnerWorkService(work);
const runtime = new MonitoringRuntime(0);
const server = buildServer({ logger: false, runnerWork: { token, service }, runnerControl: { token, service, work, runtime,
  busy: async () => { calls.busy++; return false; },
  heartbeat: { upsertHeartbeat: async (row) => { calls.heartbeat++; return row; }, expireStaleTrafficSessions: async () => {} } } });
server.addHook("onRequest", async (request) => { calls.http++; routes.push(request.routeOptions.url); });
const origin = await server.listen({ host: "127.0.0.1", port: 0 });
const backend = new BackendClient({ url: origin, token }, "local_postgres");
const directory = mkdtempSync(path.join(tmpdir(), "netops-p18-soak-"));
const health = new NetworkHealthWatch({ runnerId: runner.id, backend, cachePath: path.join(directory, "health.json"),
  ping: async () => { calls.probes++; throw new Error("Unexpected probe"); } });
const telemetry = new ManagedTelemetryWatch({ runnerId: runner.id, backend, config: {}, cachePath: path.join(directory, "snmp.json"),
  runAgent: async () => { calls.probes++; throw new Error("Unexpected SNMP"); } });
health.targets.set("configured-health", { id: "configured-health", enabled: true });
telemetry.targets.set("configured-snmp", { id: "configured-snmp", enabled: true });
health.setMonitoring(false); telemetry.setMonitoring(false);
backend.control = new RunnerControlSocket({ url: origin, headers: backend.localBackendHeaders, runner: () => runner,
  status: () => ({ ready: false, busy: health.draining || telemetry.draining }),
  onMode: ({ monitoring }) => { health.setMonitoring(monitoring); telemetry.setMonitoring(monitoring); } });
const shutdown = new AbortController();
let stopHeartbeat = () => {};
let dispatch;
let continuityTimer;
try {
  backend.control.start();
  const deadline = Date.now() + 5000;
  while (!backend.control.healthy) {
    assert.ok(Date.now() < deadline, "Control handshake deadline");
    await new Promise((resolve) => setImmediate(resolve));
  }
  backend.control.socket.on("ping", () => { calls.ping++; });
  // ws auto-pongs in response; observe actual outgoing pong frames via method.
  const pong = backend.control.socket.pong.bind(backend.control.socket);
  backend.control.socket.pong = (...args) => { calls.pong++; return pong(...args); };
  health.start(); telemetry.start();
  stopHeartbeat = startHeartbeatLoop(() => backend.heartbeat(runner), 60_000);
  dispatch = runControlPlane({ backend, runnerId: runner.id, manualPingEnabled: true, signal: shutdown.signal, execute: {} });
  const start = performance.now(); const cpu = process.cpuUsage(); const initial = { ...calls };
  let previousTick = performance.now(); let maximumGap = 0;
  continuityTimer = setInterval(() => {
    const current = performance.now(); maximumGap = Math.max(maximumGap, current - previousTick); previousTick = current;
  }, 1000);
  console.log(JSON.stringify({ phase: "steady_standby_started", duration_ms: duration, repository: "in-memory fake, NOT PostgreSQL" }));
  await new Promise((resolve) => setTimeout(resolve, duration));
  maximumGap = Math.max(maximumGap, performance.now() - previousTick);
  assert.ok(maximumGap < 5_000, `Soak invalid: host/event loop interruption ${maximumGap} ms`);
  assert.ok(calls.ping >= 25 && calls.pong >= 25, "Five minutes of actual keepalive activity required, not suspended wall time");
  assert.equal(calls.http - initial.http, 0, `Unexpected HTTP routes: ${JSON.stringify(routes)}`); assert.equal(calls.probes, 0);
  assert.equal(backend.control.healthy, true); assert.equal(runtime.snapshot().state, "STANDBY");
  assert.equal(health.targets.size, 1); assert.equal(telemetry.targets.size, 1);
  const used = process.cpuUsage(cpu);
  const sockets = await new Promise((resolve, reject) => server.server.getConnections((error, count) => error ? reject(error) : resolve(count)));
  assert.equal(sockets, 1, "Exactly one actual loopback control socket expected");
  console.log(JSON.stringify({ phase: "standby_result", elapsed_ms: performance.now() - start, http_requests: calls.http - initial.http,
    ws_ping_frames: calls.ping, ws_pong_frames: calls.pong, runner_sockets: sockets, device_probes: calls.probes,
    cpu_user_ms: used.user / 1000, cpu_system_ms: used.system / 1000, memory: process.memoryUsage(),
    maximum_event_loop_gap_ms: maximumGap,
    fake_repository_calls: calls, actual_postgresql_measurements: "NOT RUN" }));
} finally {
  shutdown.abort(); stopHeartbeat(); await backend.control.stop(); await dispatch;
  clearInterval(continuityTimer);
  await health.stop(); await telemetry.stop(); await server.close();
  // Only the exact mkdtemp fixture directory belongs to this harness.
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
  assert.match(path.basename(directory), /^netops-p18-soak-[A-Za-z0-9]+$/);
  rmSync(directory, { recursive: true });
}
