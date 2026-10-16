import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { NetworkHealthWatch } from "../src/network-health.mjs";
import { runControlPlane, controlDelay } from "../src/control-plane.mjs";

function harness(overrides = {}) {
  const shutdown = new AbortController();
  const calls = [];
  const executed = [];
  const sleeps = [];
  const backend = {
    waitForWork: async () => { shutdown.abort(); return { supported: true, available: [], timed_out: true }; },
  };
  const execute = {};
  for (const [kind, method] of [["manual_ping", "claimManualPing"], ["traffic", "claimTraffic"],
    ["discovery", "claimDiscovery"], ["device_inspector", "claimInspection"]]) {
    backend[method] = async (runnerId) => { calls.push([kind, runnerId]); return { id: kind }; };
    execute[kind] = async (job) => { executed.push(job.id); shutdown.abort(); };
  }
  Object.assign(backend, overrides);
  const options = { backend, runnerId: "it-lt8", manualPingEnabled: true, execute, signal: shutdown.signal,
    sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5 };
  return { shutdown, calls, executed, sleeps, backend, options };
}

test("idle wait timeouts never issue four empty claims, including after restart", async () => {
  for (let restart = 0; restart < 2; restart += 1) {
    const h = harness(); let waits = 0;
    h.backend.waitForWork = async () => {
      if (++waits === 6) h.shutdown.abort();
      return { supported: true, available: [], timed_out: true };
    };
    await runControlPlane(h.options);
    assert.equal(waits, 6); assert.equal(h.calls.length, 0); assert.equal(h.executed.length, 0);
  }
});

test("available work uses authenticated atomic claims in existing priority, never the hint as a job", async () => {
  const h = harness({ waitForWork: async () => ({ supported: true, timed_out: false,
    available: ["device_inspector", "traffic", "discovery", "manual_ping"] }) });
  await runControlPlane(h.options);
  assert.deepEqual(h.calls, [["manual_ping", "it-lt8"]]);
  assert.deepEqual(h.executed, ["manual_ping"]);
});

test("lost claim races do not execute twice and only advertised subsystems are claimed", async () => {
  const h = harness({ waitForWork: async () => ({ supported: true, timed_out: false, available: ["traffic", "discovery"] }) });
  h.backend.claimTraffic = async (runnerId) => { h.calls.push(["traffic", runnerId]); return null; };
  await runControlPlane(h.options);
  assert.deepEqual(h.calls, [["traffic", "it-lt8"], ["discovery", "it-lt8"]]);
  assert.deepEqual(h.executed, ["discovery"]);
});

test("manual ping disabled is respected; active Traffic remains serial and stop handling stays with agent", async () => {
  const h = harness({ waitForWork: async () => ({ supported: true, timed_out: false, available: ["traffic", "manual_ping"] }) });
  h.options.manualPingEnabled = false;
  let finish;
  const active = new Promise((resolve) => { finish = resolve; });
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  h.options.execute.traffic = async () => { started(); await active; h.shutdown.abort(); };
  const running = runControlPlane(h.options);
  await entered;
  assert.deepEqual(h.calls, [["traffic", "it-lt8"]]);
  finish(); await running;
  assert.equal(h.calls.length, 1);
  const main = readFileSync(new URL("../src/main.mjs", import.meta.url), "utf8");
  assert.match(main, /await runTrafficAgent\(config, session/);
  assert.match(main, /await backend\.completeTraffic/);
});

test("legacy capability fallback retains bearer claims and probes support again after 60s", async () => {
  const h = harness(); let time = 0; let waits = 0;
  h.backend.waitForWork = async () => { waits += 1; return { supported: false }; };
  for (const method of ["claimManualPing", "claimTraffic", "claimDiscovery", "claimInspection"]) {
    h.backend[method] = async () => { h.calls.push(method); return null; };
  }
  h.options.now = () => time;
  h.options.sleep = async (ms) => { time += ms; if (time >= 62_000) h.shutdown.abort(); };
  await runControlPlane(h.options);
  assert.equal(waits, 2);
  assert.equal(h.calls.length, 31 * 4);
});

test("network/503/auth errors use bounded jittered backoff, not fallback claims", async () => {
  for (const status of [undefined, 503, 401, 403]) {
    const h = harness({ waitForWork: async () => { const error = new Error("unavailable"); error.status = status; throw error; } });
    h.options.sleep = async (ms) => { h.sleeps.push(ms); if (h.sleeps.length === 8) h.shutdown.abort(); };
    await runControlPlane(h.options);
    assert.deepEqual(h.sleeps, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    assert.equal(h.calls.length, 0);
  }
});

test("shutdown cancels an outstanding wait without retry or claims", async () => {
  const h = harness(); let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  h.backend.waitForWork = async (runnerId, signal) => {
    assert.equal(runnerId, "it-lt8"); entered();
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    throw new Error("aborted");
  };
  const running = runControlPlane(h.options); await started; h.shutdown.abort(); await running;
  assert.equal(h.calls.length, 0); assert.equal(h.sleeps.length, 0);
  await controlDelay(30_000, h.shutdown.signal);
});

test("--once keeps bounded legacy claims without opening a long wait", async () => {
  const h = harness(); h.options.once = true;
  h.backend.waitForWork = async () => { throw new Error("must not wait in once mode"); };
  await runControlPlane(h.options);
  assert.deepEqual(h.executed, ["manual_ping"]);
});

test("two schedulers cannot execute the same atomically claimed job twice", async () => {
  const a = harness(); const b = harness(); let claimed = false; let executions = 0;
  const backend = {
    claimTraffic: async () => { if (claimed) return null; claimed = true; return { id: "one-durable-job" }; },
    claimDiscovery: async () => null, claimInspection: async () => null,
  };
  const options = (h) => ({ ...h.options, backend, once: true, manualPingEnabled: false,
    execute: { traffic: async () => { executions += 1; } } });
  await Promise.all([runControlPlane(options(a)), runControlPlane(options(b))]);
  assert.equal(executions, 1);
});

test("Health 1800s scheduling, heartbeat and SNMP remain independent of control wait", () => {
  const source = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
  const main = source("../src/main.mjs");
  assert.match(main, /healthWatch\.start\(\)/); assert.match(main, /telemetryWatch\.start\(\)/);
  assert.match(main, /startHeartbeatLoop/); assert.match(main, /config\.heartbeat_interval_ms/);
  const health = source("../src/network-health.mjs");
  assert.match(health, /probe_interval_seconds/);
  assert.doesNotMatch(source("../src/control-plane.mjs"), /probe_interval|heartbeat_interval|snmp/);
});

test("an outstanding work wait does not change the Health Watch 1800-second due time", async () => {
  const h = harness(); let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  h.backend.waitForWork = async (runnerId, signal) => {
    assert.equal(runnerId, "it-lt8"); entered();
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    throw new Error("stopped");
  };
  // No start(), probe() or filesystem access: exercise production
  // sample scheduling on an isolated in-memory watch while control is waiting.
  const watch = Object.create(NetworkHealthWatch.prototype);
  watch.states = {}; watch.pendingTransitions = []; watch.targets = new Map();
  watch.persist = () => {};
  const target = { id: "11111111-1111-4111-8111-111111111111", probe_interval_seconds: 1800,
    failure_threshold: 3, recovery_threshold: 2, latency_warning_ms: 100, loss_warning_percent: 40 };
  const running = runControlPlane(h.options);
  try {
    await started;
    watch.applySample(target, { success: true, latency_ms: 1 }, 1_000);
    assert.equal(watch.states[target.id].nextProbeAt, 1_801_000);
  } finally { h.shutdown.abort(); await running; }
});
