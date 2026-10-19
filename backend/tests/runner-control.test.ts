import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { WebSocket } from "ws";
import { buildServer } from "../src/server.js";
import { MonitoringRuntime } from "../src/runner-control/runtime.js";
import { RunnerWorkService } from "../src/runner-work/service.js";
import type { WorkKind } from "../src/runner-work/contract.js";

const TOKEN = "test-control-token-not-a-real-credential";
const runner = { id: "it-lt8", display_name: "IT LT8 Runner", health_status: "online", health_error_code: null,
  capabilities: { source_locations: [], targets: [], durations: [5], traffic_durations_seconds: [300],
    operations: ["bandwidth_and_path", "traffic_live", "network_discovery", "device_inspect", "manual_ping"], snmp_telemetry: { enabled: false } } };
const health = () => JSON.stringify({ type: "health", runner, ready: true, busy: false, policy_revision: 0 });
async function fixture(reconcileMs = 10_000, busy?: () => Promise<boolean>) {
  let available: readonly WorkKind[] = [];
  let heartbeatWrites = 0;
  let read = async (): Promise<readonly WorkKind[]> => available;
  const work = { available: async () => read(), recover: async () => {} };
  const service = new RunnerWorkService(work);
  const runtime = new MonitoringRuntime(0);
  const server = buildServer({ logger: false, runnerWork: { token: TOKEN, service }, runnerControl: {
    token: TOKEN, service, runtime, work, busy: busy ?? (async () => available.length > 0), reconcileMs,
    heartbeat: { upsertHeartbeat: async (row) => { heartbeatWrites++; return row; }, expireStaleTrafficSessions: async () => {} },
  } });
  const origin = await server.listen({ host: "127.0.0.1", port: 0 });
  const connect = (token = TOKEN) => new WebSocket(origin.replace("http:", "ws:") + "/api/runner/control", { headers: { authorization: `Bearer ${token}` } });
  return { server, connect, runtime, service, setWork: (value: readonly WorkKind[]) => { available = value; },
    setRead: (value: typeof read) => { read = value; }, writes: () => heartbeatWrites };
}

test("enqueue during busy reconciliation cannot publish stale STANDBY evidence", { timeout: 2000 }, async () => {
  let release!: (value: boolean) => void;
  let secondRead!: () => void;
  const checkedAfterEnqueue = new Promise<void>((resolve) => { secondRead = resolve; });
  let reads = 0;
  const f = await fixture(10_000, async () => {
    if (++reads === 1) return new Promise<boolean>((resolve) => { release = resolve; });
    secondRead(); return true;
  });
  const socket = f.connect();
  const states: unknown[] = [];
  socket.on("message", (raw) => {
    const event = JSON.parse(raw.toString()) as Record<string, unknown>;
    if (event.type === "runtime" || event.type === "ready") states.push(event.state);
  });
  try {
    await once(socket, "open"); const ready = message(socket, "ready"); socket.send(health()); await ready;
    states.length = 0;
    f.setWork(["manual_ping"]); f.service.wake("it-lt8");
    release(false); // An older snapshot must not overwrite the committed enqueue hint.
    await checkedAfterEnqueue;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(states.includes("STANDBY"), false);
    assert.equal(f.runtime.snapshot().state, "DRAINING");
  } finally { socket.terminate(); await f.server.close(); }
});
function message(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const received = (data: { toString(): string }) => {
      const event = JSON.parse(data.toString()) as Record<string, unknown>;
      if (event.type === type) { cleanup(); resolve(event); }
    };
    const closed = () => { cleanup(); reject(new Error("Unexpected close")); };
    const cleanup = () => { socket.off("message", received); socket.off("close", closed); };
    socket.on("message", received); socket.once("close", closed);
  });
}
test("control authenticates, reconciles before ready, persists real health, prevents duplicate runner", async () => {
  const f = await fixture(); const socket = f.connect();
  try {
    await once(socket, "open");
    f.setWork(["manual_ping", "traffic"]);
    const work = message(socket, "work_available"); const ready = message(socket, "ready"); socket.send(health());
    assert.deepEqual((await work).available, ["manual_ping", "traffic"]); await ready;
    assert.equal(f.writes(), 1);
    const duplicate = f.connect(); await once(duplicate, "open"); const closed = once(duplicate, "close"); duplicate.send(health());
    assert.equal((await closed)[0], 1008);
    f.setWork(["discovery", "device_inspector"]);
    const next = message(socket, "work_available"); f.service.wake("it-lt8");
    assert.deepEqual((await next).available, ["discovery", "device_inspector"]);
  } finally { socket.terminate(); await f.server.close(); }
});

test("enqueue during initial queue query gets a trailing durable check; hints never assign work", async () => {
  const f = await fixture(); const socket = f.connect();
  try {
    let release!: (value: readonly WorkKind[]) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let reads = 0;
    f.setRead(async () => {
      if (++reads === 1) { entered(); return new Promise((resolve) => { release = resolve; }); }
      return ["manual_ping"];
    });
    await once(socket, "open"); const ready = message(socket, "ready"); socket.send(health());
    await started; f.service.wake("it-lt8"); release([]); await ready;
    const next = await message(socket, "work_available");
    assert.deepEqual(next.available, ["manual_ping"]); assert.ok(reads >= 2);
  } finally { socket.terminate(); await f.server.close(); }
});

test("missed hint is recovered internally without HTTP, duplicate hints coalesce, DB failure closes control", async () => {
  const f = await fixture(20); const socket = f.connect();
  try {
    await once(socket, "open"); const ready = message(socket, "ready"); socket.send(health()); await ready;
    f.setWork(["discovery"]); // Bypass the ordinary enqueue/hint writer.
    assert.deepEqual((await message(socket, "work_available")).available, ["discovery"]);
    let reads = 0; f.setRead(async () => { reads++; return ["traffic"]; });
    const work = message(socket, "work_available");
    for (let index = 0; index < 100; index++) f.service.wake("it-lt8");
    assert.deepEqual((await work).available, ["traffic"]); assert.equal(reads, 1);
    f.setRead(async () => { throw new Error("database temporarily unavailable"); });
    const closed = once(socket, "close"); f.service.wake("it-lt8");
    assert.equal((await closed)[0], 1011);
  } finally { socket.terminate(); await f.server.close(); }
});
test("control rejects unauthorized upgrade, malformed and oversized frames; shutdown closes sessions", async () => {
  const f = await fixture();
  try {
    const unauthorized = f.connect("invalid");
    const status = await new Promise<number>((resolve) => {
      unauthorized.on("unexpected-response", (_request, response) => { resolve(response.statusCode ?? 0); response.resume(); unauthorized.terminate(); });
      unauthorized.on("error", () => {});
    });
    assert.equal(status, 401);
    for (const payload of ["bad-json", "x".repeat(32_769)]) {
      const socket = f.connect(); await once(socket, "open"); const closed = once(socket, "close"); socket.send(payload);
      assert.ok([1008, 1009].includes(Number((await closed)[0])));
    }
    const socket = f.connect(); await once(socket, "open"); const ready = message(socket, "ready"); socket.send(health()); await ready;
    const closed = once(socket, "close"); await f.server.close(); await closed;
  } finally { await f.server.close(); }
});
test("presence grace, multiple tabs, drain and fail-closed uncertainty have deterministic transitions", () => {
  let now = 0; const runtime = new MonitoringRuntime(30_000, () => now);
  runtime.connection(1); runtime.evidence(false, false, false);
  assert.equal(runtime.snapshot().state, "STANDBY");
  const first = runtime.enter(); assert.equal(runtime.snapshot().state, "ACTIVATING");
  runtime.evidence(false, true, false); const second = runtime.enter(); first();
  assert.equal(runtime.snapshot().state, "ACTIVE"); second();
  now = 29_999; assert.equal(runtime.snapshot().state, "ACTIVE");
  now = 30_000; runtime.evidence(true, true, false); assert.equal(runtime.snapshot().state, "DRAINING");
  assert.equal(runtime.snapshot().monitoring, false);
  const returning = runtime.enter(); assert.equal(runtime.snapshot().state, "ACTIVATING");
  runtime.evidence(true, true, false); assert.equal(runtime.snapshot().state, "ACTIVE"); returning();
  now += 30_000; runtime.evidence(false, true, false); assert.equal(runtime.snapshot().state, "STANDBY");
  runtime.evidence(false, true, true); assert.equal(runtime.snapshot().state, "DEGRADED");
});

test("old readiness evidence cannot make a new activation live until current policy is acknowledged", async () => {
  const f = await fixture(); const socket = f.connect();
  try {
    await once(socket, "open"); const initial = message(socket, "ready"); socket.send(health()); await initial;
    const leave = f.runtime.enter(); assert.equal(f.runtime.snapshot().state, "ACTIVATING");
    f.service.wake("it-lt8"); // Busy reconciliation reuses old runner reports.
    const stale = message(socket, "ready"); socket.send(health());
    assert.equal((await stale).state, "ACTIVATING");
    const acknowledged = message(socket, "ready");
    socket.send(JSON.stringify({ type: "health", runner, ready: true, busy: false, policy_revision: f.runtime.policyRevision }));
    assert.equal((await acknowledged).state, "ACTIVE");
    leave(); assert.equal(f.runtime.snapshot().state, "DRAINING");
    const paused = message(socket, "ready");
    socket.send(JSON.stringify({ type: "health", runner, ready: false, busy: false, policy_revision: f.runtime.policyRevision }));
    assert.equal((await paused).state, "STANDBY");
    const returning = f.runtime.enter(); assert.equal(f.runtime.snapshot().state, "ACTIVATING"); returning();
  } finally { socket.terminate(); await f.server.close(); }
});
