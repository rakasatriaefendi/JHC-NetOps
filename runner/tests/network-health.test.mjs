import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { buildPingInvocation, NetworkHealthWatch, pingProcessWallTimeout, pingTarget } from "../src/network-health.mjs";

function target(overrides = {}) {
  return { id: "11111111-1111-4111-8111-111111111111", ip_address: "127.0.0.1", probe_method: "icmp",
    probe_interval_seconds: 30, timeout_ms: 1000, failure_threshold: 3, recovery_threshold: 2,
    latency_warning_ms: 100, loss_warning_percent: 40, ...overrides };
}
function watch(backend = { healthTargets: async () => ({ targets: [] }), publishHealth: async () => ({}) }) {
  return new NetworkHealthWatch({ runnerId: "runner-test", backend,
    cachePath: path.join(mkdtempSync(path.join(os.tmpdir(), "health-watch-")), "state.json"),
    ping: async () => ({ success: true, latency_ms: 1 }), now: () => 1_000 });
}

test("state transitions require three failures and two recovery successes", () => {
  const service = watch(); const item = target();
  service.applySample(item, { success: true, latency_ms: 2 }, 1_000);
  assert.equal(service.states[item.id].status, "online");
  service.applySample(item, { success: false, latency_ms: null }, 2_000);
  service.applySample(item, { success: false, latency_ms: null }, 3_000);
  assert.equal(service.states[item.id].status, "degraded");
  service.applySample(item, { success: false, latency_ms: null }, 4_000);
  assert.equal(service.states[item.id].status, "offline");
  service.applySample(item, { success: true, latency_ms: 2 }, 5_000);
  assert.equal(service.states[item.id].status, "offline");
  service.applySample(item, { success: true, latency_ms: 2 }, 6_000);
  assert.equal(service.states[item.id].status, "online");
  assert.deepEqual(service.pendingTransitions.map((event) => event.new_status), ["degraded", "offline", "online"]);
});

test("short window retains five samples and detects degraded latency", () => {
  const service = watch(); const item = target({ latency_warning_ms: 20 });
  for (let index = 0; index < 7; index += 1) service.applySample(item, { success: true, latency_ms: index === 6 ? 100 : 10 }, index * 1000);
  assert.equal(service.states[item.id].samples.length, 5);
  assert.equal(service.states[item.id].status, "degraded");
});

test("short-window packet loss can degrade without declaring offline", () => {
  const service = watch(); const item = target({ loss_warning_percent: 40, failure_threshold: 3 });
  service.applySample(item, { success: true, latency_ms: 2 }, 1_000);
  service.applySample(item, { success: false, latency_ms: null }, 2_000);
  assert.equal(service.states[item.id].status, "degraded");
  assert.equal(service.states[item.id].packetLossPercent, 50);
  assert.equal(service.states[item.id].consecutiveFailures, 1);
});

test("refresh ignores unsupported entries and handles multiple targets", async () => {
  const targets = [target(), target({ id: "22222222-2222-4222-8222-222222222222", ip_address: "192.0.2.1" }), { ...target(), id: "bad", ip_address: "hostname" }];
  const service = watch({ healthTargets: async () => ({ targets }), publishHealth: async () => ({}) });
  await service.refreshTargets(1_000);
  assert.deepEqual([...service.targets.keys()], targets.slice(0, 2).map((item) => item.id));
});

test("manual ping resolves the current runner-scoped target and does not mutate scheduled state", async () => {
  const item = target({ ip_address: "192.0.2.10", timeout_ms: 750 });
  const calls = [];
  const service = new NetworkHealthWatch({
    runnerId: "runner-test",
    backend: { healthTargets: async () => ({ targets: [item] }), publishHealth: async () => ({}) },
    cachePath: path.join(mkdtempSync(path.join(os.tmpdir(), "health-watch-")), "state.json"),
    ping: async (...args) => { calls.push(args); return { success: true, latency_ms: 7.5 }; },
  });
  assert.deepEqual(await service.manualPing(item.id), { ok: true, latency_ms: 7.5 });
  assert.deepEqual(calls[0].slice(0, 2), ["192.0.2.10", 750]);
  assert.deepEqual(service.states, {});
  assert.deepEqual(service.pendingTransitions, []);
});

test("manual ping normalizes timeout and unreachable without raw process output", async () => {
  const item = target();
  const create = (reply) => new NetworkHealthWatch({
    runnerId: "runner-test",
    backend: { healthTargets: async () => ({ targets: [item] }), publishHealth: async () => ({}) },
    cachePath: path.join(mkdtempSync(path.join(os.tmpdir(), "health-watch-")), "state.json"),
    ping: async () => reply,
  });
  assert.deepEqual(await create({ success: false, latency_ms: null, timed_out: true, stderr: "private" }).manualPing(item.id), { ok: false, category: "timeout" });
  assert.deepEqual(await create({ success: false, latency_ms: null, stderr: "private" }).manualPing(item.id), { ok: false, category: "unreachable" });
});

test("manual ping rejects unknown targets and successful replies without measured latency", async () => {
  const item = target();
  const unavailable = watch({ healthTargets: async () => ({ targets: [] }), publishHealth: async () => ({}) });
  await assert.rejects(unavailable.manualPing(item.id), (error) => error.code === "MANUAL_PING_TARGET_UNAVAILABLE");
  const invalid = new NetworkHealthWatch({
    runnerId: "runner-test",
    backend: { healthTargets: async () => ({ targets: [item] }), publishHealth: async () => ({}) },
    cachePath: path.join(mkdtempSync(path.join(os.tmpdir(), "health-watch-")), "state.json"),
    ping: async () => ({ success: true, latency_ms: null }),
  });
  await assert.rejects(invalid.manualPing(item.id), (error) => error.code === "MANUAL_PING_FAILED");
});

test("failed publish retains coalesced state and transition with backoff", async () => {
  let attempts = 0;
  const service = watch({ healthTargets: async () => ({ targets: [] }), publishHealth: async () => { attempts += 1; throw new Error("offline"); } });
  const item = target(); service.targets.set(item.id, item);
  service.applySample(item, { success: true, latency_ms: 1 }, 1_000);
  service.applySample(item, { success: false, latency_ms: null }, 2_000);
  await service.publish(2_000);
  assert.equal(attempts, 1); assert.equal(service.states[item.id].dirty, true);
  assert.equal(service.pendingTransitions.length, 1); assert.equal(service.retryAt, 7_000);
});

test("cached approved targets survive restart during backend outage", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "health-watch-"));
  const cachePath = path.join(directory, "state.json");
  const first = new NetworkHealthWatch({ runnerId: "runner-test", backend: { healthTargets: async () => ({ targets: [target()] }), publishHealth: async () => ({}) }, cachePath });
  await first.refreshTargets(1_000);
  const restarted = new NetworkHealthWatch({ runnerId: "runner-test", backend: { healthTargets: async () => { throw new Error("offline"); }, publishHealth: async () => ({}) }, cachePath });
  assert.deepEqual([...restarted.targets.keys()], [target().id]);
  await restarted.refreshTargets(2_000);
  assert.deepEqual([...restarted.targets.keys()], [target().id]);
});

test("tick launches a probe without blocking runner polling", async () => {
  let resolvePing; let calls = 0;
  const service = new NetworkHealthWatch({ runnerId: "runner-test", backend: { healthTargets: async () => ({ targets: [target()] }), publishHealth: async () => ({}) },
    cachePath: path.join(mkdtempSync(path.join(os.tmpdir(), "health-watch-")), "state.json"), now: () => 1_000,
    ping: () => { calls += 1; return new Promise((resolve) => { resolvePing = resolve; }); } });
  service.running = true;
  await service.tick();
  assert.equal(calls, 1); assert.equal(service.inFlight.size, 1);
  resolvePing({ success: true, latency_ms: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.inFlight.size, 0);
});

test("ping invocation is fixed, bounded, and rejects command injection", () => {
  const invocation = buildPingInvocation("192.0.2.10", 1000);
  assert.equal(invocation.executable, "C:\\Windows\\System32\\PING.EXE");
  assert.deepEqual(invocation.args, ["-4", "-n", "1", "-w", "1000", "192.0.2.10"]);
  assert.equal(invocation.options.shell, false);
  assert.throws(() => buildPingInvocation("127.0.0.1 & whoami", 1000));
  assert.throws(() => buildPingInvocation("127.0.0.1", 60_000));
});

function fakePingChild(onSpawn) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  queueMicrotask(() => onSpawn(child));
  return child;
}

test("ping child normal reply and normal timeout are normalized", async () => {
  const reply = await pingTarget("192.0.2.10", 400, undefined, () => fakePingChild((child) => {
    child.stdout.write("Reply from 192.0.2.10: time=7ms");
    child.emit("close", 0);
  }));
  assert.deepEqual(reply, { success: true, latency_ms: 7 });
  const timeout = await pingTarget("192.0.2.10", 400, undefined, () => fakePingChild((child) => child.emit("close", 1)));
  assert.deepEqual(timeout, { success: false, latency_ms: null });
});

test("runner kills a PING child that never exits at 400ms plus 250ms grace", async () => {
  let child;
  const started = Date.now();
  const result = await pingTarget("192.0.2.10", 400, undefined, () => (child = fakePingChild(() => {})));
  assert.equal(pingProcessWallTimeout(400), 650);
  assert.ok(Date.now() - started < 1_000);
  assert.equal(child.killed, true);
  assert.deepEqual(result, { success: false, latency_ms: null, timed_out: true });
});

test("ping process errors are bounded and do not leak the child", async () => {
  let child;
  await assert.rejects(
    pingTarget("192.0.2.10", 400, undefined, () => (child = fakePingChild((owned) => owned.emit("error", new Error("synthetic"))))),
    /Ping process failed/,
  );
  assert.equal(child.listenerCount("error"), 0);
});
