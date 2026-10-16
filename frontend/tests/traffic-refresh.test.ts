import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { TrafficRefreshCoordinator, startTrafficRefresh, type TrafficRefreshTimers } from "../lib/traffic-refresh.ts";
import type { NetworkHealthEventStream, NetworkHealthRealtimeStatus } from "../lib/network-health-realtime.ts";

const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class Clock implements TrafficRefreshTimers {
  time = 0;
  next = 0;
  tasks = new Map<number, { at: number; callback: () => void }>();
  now = () => this.time;
  setTimeout = (callback: () => void, delay: number) => {
    const id = ++this.next;
    this.tasks.set(id, { at: this.time + delay, callback });
    return id;
  };
  clearTimeout = (id: unknown) => { if (typeof id === "number") this.tasks.delete(id); };
  async advance(ms: number) {
    const end = this.time + ms;
    while (true) {
      const next = [...this.tasks].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      this.time = next[1].at;
      this.tasks.delete(next[0]);
      next[1].callback();
      await flush();
    }
    this.time = end;
    await flush();
  }
}
class Stream implements NetworkHealthEventStream {
  handlers = new Map<string, Set<(event: Event) => void>>();
  closed = false;
  addEventListener(type: string, handler: (event: Event) => void) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler);
  }
  removeEventListener(type: string, handler: (event: Event) => void) { this.handlers.get(type)?.delete(handler); }
  close() { this.closed = true; }
  emit(type: "open" | "error") { for (const handler of this.handlers.get(type) ?? []) handler(new Event(type)); }
  invalidation(topic: string, key: string | null = "it-lt8") {
    this.raw(JSON.stringify({ version: 1, topic, aggregate_key: key }));
  }
  raw(data: string) {
    for (const handler of this.handlers.get("invalidation") ?? []) handler(new MessageEvent("invalidation", { data }));
  }
}
function harness(options: { active?: boolean; visible?: boolean; read?: () => Promise<number> } = {}) {
  const clock = new Clock();
  const streams: Stream[] = [];
  const statuses: NetworkHealthRealtimeStatus[] = [];
  const applied: number[] = [];
  let reads = 0;
  let active = options.active ?? false;
  const controller = startTrafficRefresh({
    read: async () => { reads += 1; return options.read ? options.read() : reads; },
    apply: (value) => applied.push(value),
    isActive: () => active,
    diagnosticsRelevant: (key) => key !== "known-job",
    onStatus: (status) => statuses.push(status),
    visible: options.visible ?? true,
    createEventStream: (url) => {
      assert.equal(url, "/api/realtime/events");
      const stream = new Stream(); streams.push(stream); return stream;
    },
    timers: clock,
  });
  return { clock, streams, statuses, applied, controller, reads: () => reads, setActive: (next: boolean) => { active = next; } };
}

test("Traffic SSR seed needs no duplicate runner read; healthy SSE has only a 60s watchdog", async () => {
  const h = harness();
  assert.equal(h.reads(), 0);
  h.streams[0].emit("open");
  h.streams[0].invalidation("sync", null);
  await h.clock.advance(250);
  assert.equal(h.reads(), 1);
  await h.clock.advance(59_999);
  assert.equal(h.reads(), 1, "neither 5s state nor 10s runner polling remains");
  assert.equal(h.clock.tasks.size, 1);
  await h.clock.advance(1);
  assert.equal(h.reads(), 2);
  assert.deepEqual(h.statuses, ["connecting", "connected"]);
  h.controller.dispose();
  assert.equal(h.clock.tasks.size, 0);
});

test("Traffic, runner diagnostics and sync invalidate; irrelevant and malformed events do not", async () => {
  const h = harness();
  const stream = h.streams[0]; stream.emit("open");
  for (const topic of ["traffic", "diagnostics", "sync"]) {
    stream.invalidation(topic);
    await h.clock.advance(250);
  }
  assert.equal(h.reads(), 3);
  stream.invalidation("network_health");
  stream.invalidation("device_inspector");
  stream.invalidation("diagnostics", "known-job");
  stream.invalidation("diagnostics", "not:a:runner:key");
  stream.raw("not JSON"); stream.raw("x".repeat(1_025));
  await h.clock.advance(1_000);
  assert.equal(h.reads(), 3);
  stream.invalidation("diagnostics", "new-runner");
  await h.clock.advance(250);
  assert.equal(h.reads(), 4, "unknown valid runner keys must not hide runner registration");
  h.controller.dispose();
});

test("bursty invalidations coalesce, including at most one trailing read during a slow response", async () => {
  const first = deferred<number>();
  let calls = 0;
  const h = harness({ read: () => ++calls === 1 ? first.promise : Promise.resolve(calls) });
  const stream = h.streams[0]; stream.emit("open");
  for (let i = 0; i < 50; i += 1) stream.invalidation("traffic");
  await h.clock.advance(250);
  assert.equal(h.reads(), 1);
  for (let i = 0; i < 50; i += 1) stream.invalidation("traffic");
  await h.clock.advance(10_000);
  assert.equal(h.reads(), 1);
  assert.equal(h.clock.tasks.size, 0, "no fallback/watchdog runs beside a read");
  first.resolve(1); await flush();
  await h.clock.advance(250);
  assert.equal(h.reads(), 2);
  assert.deepEqual(h.applied, [1, 2]);
  h.controller.dispose();
});

test("coordinator returns shared trailing Promises and never overlaps physical reads", async () => {
  const first = deferred<number>(); const second = deferred<number>();
  const applied: number[] = []; let reads = 0;
  const coordinator = new TrafficRefreshCoordinator(() => ++reads === 1 ? first.promise : second.promise, (value) => applied.push(value));
  const initial = coordinator.request();
  const trailing = coordinator.request();
  assert.equal(coordinator.request(), trailing);
  assert.equal(reads, 1);
  first.resolve(1); await initial; await flush();
  assert.equal(reads, 2);
  second.resolve(2); await trailing;
  assert.deepEqual(applied, [1, 2]);
  coordinator.dispose();
});

for (const operation of ["start", "stop"]) {
  test(`${operation} confirmation cannot use a read that started before mutation completed`, async () => {
    const before = deferred<number>(); const after = deferred<number>();
    let reads = 0; const applied: number[] = [];
    const coordinator = new TrafficRefreshCoordinator(() => ++reads === 1 ? before.promise : after.promise, (value) => applied.push(value));
    const initial = coordinator.request();
    let confirmed = false;
    // The action invokes request(true) only after awaiting its mutation.
    const confirmation = coordinator.request(true).then(() => { confirmed = true; });
    before.resolve(1); await flush();
    assert.equal(reads, 2);
    assert.equal(applied.length, 0, "pre-mutation response must not overwrite new state");
    assert.equal(confirmed, false);
    after.resolve(2); await confirmation; await initial;
    assert.deepEqual(applied, [2]);
    coordinator.dispose();
  });
}

test("failed post-mutation read rejects confirmation and retains the last snapshot", async () => {
  const h = harness({ read: async () => { throw new Error("private details"); } });
  await assert.rejects(h.controller.confirmMutation(), /^Error: Traffic refresh failed$/);
  assert.equal(h.applied.length, 0);
  h.controller.dispose();
});

test("mutation confirmation uses the same single-flight service as an in-flight SSE read", async () => {
  const before = deferred<number>(); const after = deferred<number>(); let reads = 0;
  const h = harness({ read: () => ++reads === 1 ? before.promise : after.promise });
  h.streams[0].emit("open"); h.streams[0].invalidation("traffic");
  await h.clock.advance(250);
  let confirmed = false;
  const confirmation = h.controller.confirmMutation().then(() => { confirmed = true; });
  assert.equal(reads, 1);
  before.resolve(1); await flush();
  assert.equal(reads, 2);
  assert.equal(h.applied.length, 0);
  assert.equal(confirmed, false);
  after.resolve(2); await confirmation; await flush();
  assert.deepEqual(h.applied, [2]);
  assert.equal(h.clock.tasks.size, 1);
  h.controller.dispose();
});

test("disconnected fallback is 5s active / 30s idle with one timer, and recovery replaces it", async () => {
  for (const active of [true, false]) {
    const h = harness({ active }); const stream = h.streams[0];
    stream.emit("open"); stream.emit("error");
    const delay = active ? 5_000 : 30_000;
    await h.clock.advance(delay - 1); assert.equal(h.reads(), 0);
    await h.clock.advance(1); assert.equal(h.reads(), 1);
    assert.equal(h.clock.tasks.size, 1);
    stream.emit("open"); stream.invalidation("sync", null);
    await h.clock.advance(250); assert.equal(h.reads(), 2);
    await h.clock.advance(59_999); assert.equal(h.reads(), 2);
    await h.clock.advance(1); assert.equal(h.reads(), 3);
    assert.equal(h.streams.length, 1, "EventSource owns reconnect; errors do not create duplicate streams");
    h.controller.dispose();
  }
});

test("hidden tabs suspend stream/scheduler; visible sync reconciles once and cleanup is repeatable", async () => {
  const h = harness(); const first = h.streams[0]; first.emit("open");
  first.invalidation("traffic");
  h.controller.setVisible(false);
  assert.equal(first.closed, true);
  assert.equal(h.clock.tasks.size, 0);
  await h.clock.advance(120_000); assert.equal(h.reads(), 0);
  first.invalidation("traffic"); assert.equal(h.clock.tasks.size, 0);
  h.controller.setVisible(true); h.controller.setVisible(true);
  assert.equal(h.streams.length, 2);
  h.streams[1].emit("open"); h.streams[1].invalidation("sync", null);
  await h.clock.advance(250); assert.equal(h.reads(), 1);
  h.controller.dispose(); h.controller.dispose();
  assert.equal(h.streams[1].closed, true);
  assert.equal(h.clock.tasks.size, 0);
  const hidden = harness({ visible: false });
  assert.equal(hidden.streams.length, 0); assert.equal(hidden.clock.tasks.size, 0);
  hidden.controller.dispose();
});

test("hidden in-flight read settles without scheduled work; visible reconciliation waits serially", async () => {
  const slow = deferred<number>(); let calls = 0;
  const h = harness({ read: () => ++calls === 1 ? slow.promise : Promise.resolve(calls) });
  h.streams[0].emit("open"); h.streams[0].invalidation("traffic");
  await h.clock.advance(250);
  h.controller.setVisible(false);
  h.controller.setVisible(true);
  h.streams[1].emit("open"); h.streams[1].invalidation("sync");
  await h.clock.advance(2_000);
  assert.equal(h.reads(), 1);
  slow.resolve(1); await flush(); await h.clock.advance(250);
  assert.equal(h.reads(), 2);
  assert.equal(h.clock.tasks.size, 1);
  h.controller.dispose();
});

test("unmount rejects waiting callers and suppresses late responses; a fresh mount still works", async () => {
  const slow = deferred<number>(); const applied: number[] = [];
  const coordinator = new TrafficRefreshCoordinator(() => slow.promise, (value) => applied.push(value));
  const waiting = coordinator.request(); const trailing = coordinator.request(true);
  const rejected = Promise.all([assert.rejects(waiting), assert.rejects(trailing)]);
  coordinator.dispose(); await rejected;
  slow.resolve(9); await flush(); assert.equal(applied.length, 0);
  const fresh = new TrafficRefreshCoordinator(async () => 10, (value) => applied.push(value));
  await fresh.request(); assert.deepEqual(applied, [10]); fresh.dispose();
});

test("reconnect/error bursts and failed reads cannot create a request storm", async () => {
  const h = harness({ active: true, read: async () => { throw new Error("unavailable"); } });
  const stream = h.streams[0]; stream.emit("open"); stream.invalidation("sync");
  await h.clock.advance(250); assert.equal(h.reads(), 1);
  for (let i = 0; i < 50; i += 1) {
    stream.emit("error"); stream.emit("open"); stream.invalidation("sync");
  }
  assert.equal(h.clock.tasks.size, 1);
  await h.clock.advance(4_999); assert.equal(h.reads(), 1);
  await h.clock.advance(1); assert.equal(h.reads(), 2);
  assert.equal(h.streams.length, 1);
  h.controller.dispose();
});

test("Traffic refresh leaves Dashboard Health Watch on its existing realtime helper", () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  assert.match(source("../components/dashboard/network-health-dashboard.tsx"), /startNetworkHealthRealtime/);
  const helper = source("../lib/network-health-realtime.ts");
  assert.match(helper, /topics: \["network_health"\]/);
  assert.match(helper, /NETWORK_HEALTH_FALLBACK_INTERVAL_MS = 60_000/);
  const traffic = source("../components/traffic/traffic-live-page.tsx");
  assert.match(traffic, /knownJobs\.has\(key\)/);
  assert.match(traffic, /current\.runners\.some\(\(item\) => item\.id === key\)/);
  assert.doesNotMatch(traffic, /setRunnerId\([^)]*nextState|router\.refresh|LOCAL_BACKEND_FRONTEND_TOKEN/);
});
