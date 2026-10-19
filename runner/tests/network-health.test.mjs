import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { buildPingInvocation, manualPingCompletionLog, NetworkHealthWatch, pingProcessWallTimeout, pingTarget } from "../src/network-health.mjs";

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

test("quiet empty Health Watch resumes target discovery from heartbeat without a restart", async () => {
  let idle = true; let now = 1_000; let gets = 0; let probes = 0; let publishes = 0;
  const item = target({ probe_interval_seconds: 1800 });
  const service = watch({
    monitoringIdle: (kind) => kind === "health" && idle,
    healthTargets: async () => { gets += 1; return { targets: [item] }; },
    publishHealth: async () => { publishes += 1; return {}; },
  });
  service.now = () => now; service.running = true;
  service.ping = async () => { probes += 1; return { success: true, latency_ms: 1 }; };
  for (; now < 301_000; now += 1_000) await service.tick();
  assert.equal(gets, 0); assert.equal(probes, 0); assert.equal(publishes, 0);
  idle = false; await service.tick(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gets, 1); assert.equal(probes, 1);
  assert.equal(service.states[item.id].nextProbeAt, now + 1_800_000);
  await service.stop();
});

test("missing or expired idle hint retains Health GET refresh and failure retry", async () => {
  let now = 1_000; let gets = 0;
  const service = watch({ monitoringIdle: () => false,
    healthTargets: async () => { gets += 1; if (gets === 2) throw new Error("offline"); return { targets: [] }; },
    publishHealth: async () => ({}) });
  service.now = () => now; service.running = true;
  await service.tick(); now += 60_000; await service.tick(); now += 10_000; await service.tick();
  assert.equal(gets, 3); await service.stop();
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

test("Health presets schedule the next probe by target interval, including failures", () => {
  for (const interval of [15, 30, 60, 900, 1800]) {
    const service = watch(); const item = target({ probe_interval_seconds: interval });
    service.applySample(item, { success: true, latency_ms: 1 }, 1_000);
    assert.equal(service.states[item.id].nextProbeAt, 1_000 + interval * 1000);
    service.applySample(item, { success: false, latency_ms: null }, 2_000);
    assert.equal(service.states[item.id].nextProbeAt, 2_000 + interval * 1000);
  }
});

test("Health target refresh retains presets and readable legacy custom intervals", async () => {
  for (const interval of [15, 30, 60, 900, 1800, 45]) {
    const item = target({ probe_interval_seconds: interval });
    const service = watch({ healthTargets: async () => ({ targets: [item] }), publishHealth: async () => ({}) });
    await service.refreshTargets(1000);
    assert.equal(service.targets.get(item.id).probe_interval_seconds, interval);
  }
});

test("Health interval refresh reschedules existing state; an old in-flight sample cannot restore old cadence", async () => {
  let item = target();
  const service = watch({ healthTargets: async () => ({ targets: [item] }), publishHealth: async () => ({}) });
  await service.refreshTargets(1000);
  service.applySample(item, { success: true, latency_ms: 1 }, 1000);
  const inFlightTarget = item;
  item = target({ probe_interval_seconds: 1800 });
  await service.refreshTargets(2000);
  assert.equal(service.states[item.id].nextProbeAt, 1000 + 1800 * 1000);
  service.applySample(inFlightTarget, { success: true, latency_ms: 1 }, 3000);
  assert.equal(service.states[item.id].nextProbeAt, 3000 + 1800 * 1000);
});

test("lightweight Health ticks do not issue probes before a Moderate target is due", async () => {
  let now = 1000; let calls = 0;
  const item = target({ probe_interval_seconds: 900 });
  const service = new NetworkHealthWatch({ runnerId: "runner-test",
    backend: { healthTargets: async () => ({ targets: [item] }), publishHealth: async () => ({}) },
    cachePath: path.join(mkdtempSync(path.join(os.tmpdir(), "health-presets-")), "state.json"),
    now: () => now, ping: async () => { calls += 1; return { success: true, latency_ms: 1 }; } });
  await service.refreshTargets(now);
  service.applySample(item, { success: true, latency_ms: 1 }, now);
  service.running = true;
  now = 900999;
  await service.tick();
  assert.equal(calls, 0);
  now = 901000;
  await service.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(service.states[item.id].nextProbeAt, now + 900 * 1000);
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
  const invocation = buildPingInvocation("192.0.2.10", 1000, "win32");
  assert.equal(invocation.executable, "C:\\Windows\\System32\\PING.EXE");
  assert.deepEqual(invocation.args, ["-4", "-n", "1", "-w", "1000", "192.0.2.10"]);
  assert.equal(invocation.options.shell, false);
  assert.throws(() => buildPingInvocation("127.0.0.1 & whoami", 1000, "win32"));
  assert.throws(() => buildPingInvocation("127.0.0.1", 60_000, "win32"));
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
  }), "win32");
  assert.deepEqual(reply, { success: true, latency_ms: 7, packet_loss_percent: 0 });
  const timeout = await pingTarget("192.0.2.10", 400, undefined, () => fakePingChild((child) => child.emit("close", 1)), "win32");
  assert.deepEqual(timeout, { success: false, latency_ms: null, packet_loss_percent: 100 });
});

test("Linux ping distinguishes packet loss, malformed output, and non-zero exits", async () => {
  const run = (output, code) => pingTarget("192.0.2.10", 400, undefined, () => fakePingChild((child) => {
    child.stdout.end(output);
    child.emit("close", code);
  }), "linux");
  assert.deepEqual(await run([
    "1 packets transmitted, 0 packets received, 100% packet loss",
    "",
  ].join("\n"), 1), { success: false, latency_ms: null, packet_loss_percent: 100 });
  assert.deepEqual(await run("unexpected successful-process output", 0),
    { success: false, latency_ms: null, packet_loss_percent: 100 });
  assert.deepEqual(await run("64 bytes from 192.0.2.10: icmp_seq=0 ttl=64 time=0.500 ms\n0% packet loss", 2),
    { success: false, latency_ms: null, packet_loss_percent: 100 });
});

test("Linux ping also normalizes iputils output and locale decimal separators", async () => {
  const output = [
    "PING 192.0.2.10 (192.0.2.10) 56(84) bytes of data.",
    "64 bytes from 192.0.2.10: icmp_seq=1 ttl=64 time=0,742 ms",
    "1 packets transmitted, 1 received, 0% packet loss, time 0ms",
    "rtt min/avg/max/mdev = 0,742/0,742/0,742/0,000 ms",
  ].join("\n");
  const result = await pingTarget("192.0.2.10", 400, undefined, () => fakePingChild((child) => {
    child.stdout.end(output);
    child.emit("close", 0);
  }), "linux");
  assert.deepEqual(result, { success: true, latency_ms: 0.742, packet_loss_percent: 0 });
});

test("manual ping completion log reports bounded result fields without process output", () => {
  assert.equal(
    manualPingCompletionLog("job-1", "target-1", { ok: true, latency_ms: 0.527 }),
    "Manual ping job-1 completed for Health target target-1: reachable=true loss=0 latency_ms=0.527",
  );
  assert.equal(
    manualPingCompletionLog("job-2", "target-2", { ok: false, category: "timeout", stderr: "not-for-logs" }),
    "Manual ping job-2 completed for Health target target-2: reachable=false loss=100 latency_ms=null",
  );
});

test("runner kills a PING child that never exits at 400ms plus 250ms grace", async () => {
  let child;
  const started = Date.now();
  const result = await pingTarget("192.0.2.10", 400, undefined, () => (child = fakePingChild(() => {})), "win32");
  assert.equal(pingProcessWallTimeout(400), 650);
  assert.ok(Date.now() - started < 1_000);
  assert.equal(child.killed, true);
  assert.deepEqual(result, { success: false, latency_ms: null, packet_loss_percent: 100, timed_out: true });
});

test("ping process errors are bounded and do not leak the child", async () => {
  let child;
  await assert.rejects(
    pingTarget("192.0.2.10", 400, undefined, () => (child = fakePingChild((owned) => owned.emit("error", new Error("synthetic")))), "win32"),
    /Ping process failed/,
  );
  assert.equal(child.listenerCount("error"), 0);
});
