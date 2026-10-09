import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type {
  NetworkHealthEventStream,
  NetworkHealthRealtimeTimers,
} from "../lib/network-health-realtime.ts";

const {
  NETWORK_HEALTH_FALLBACK_INTERVAL_MS,
  NETWORK_HEALTH_REALTIME_DEBOUNCE_MS,
  startNetworkHealthRealtime,
  startLocalRealtimeInvalidation,
} = await import("../lib/network-health-realtime.ts");

test("Network Health uses same-origin local invalidations and coalesces a health burst", () => {
  const stream = new FakeEventStream();
  const timers = new FakeTimers();
  const statuses: string[] = [];
  let streamUrl = "";
  let refreshes = 0;
  const stop = startNetworkHealthRealtime({
    refresh: () => { refreshes += 1; },
    onStatus: (status) => statuses.push(status),
    createEventStream: (url) => { streamUrl = url; return stream; },
    timers,
  });

  assert.equal(streamUrl, "/api/realtime/events");
  assert.deepEqual(statuses, ["connecting"]);
  stream.emit("open");
  assert.deepEqual(statuses, ["connecting", "connected"]);

  stream.emitInvalidation("unrelated_topic");
  assert.equal(timers.timeoutCount, 0);
  stream.emitInvalidation("sync");
  for (let index = 0; index < 6; index += 1) stream.emitInvalidation("network_health");
  assert.equal(timers.timeoutCount, 1);
  assert.equal(timers.lastTimeoutDelay, NETWORK_HEALTH_REALTIME_DEBOUNCE_MS);
  timers.flushTimeouts();
  assert.equal(refreshes, 1);

  stop();
  assert.equal(stream.closed, true);
  assert.equal(stream.listenerCount, 0);
  assert.equal(timers.timerCount, 0);
});

test("degraded local SSE enables bounded fallback and reconnect sync restores healthy mode", () => {
  const stream = new FakeEventStream();
  const timers = new FakeTimers();
  const statuses: string[] = [];
  let refreshes = 0;
  const stop = startNetworkHealthRealtime({
    refresh: () => { refreshes += 1; },
    onStatus: (status) => statuses.push(status),
    createEventStream: () => stream,
    timers,
  });

  stream.emit("error");
  stream.emit("error");
  assert.equal(statuses.at(-1), "fallback");
  assert.equal(timers.intervalCount, 1, "repeated errors must not create competing fallback loops");
  assert.equal(timers.lastIntervalDelay, NETWORK_HEALTH_FALLBACK_INTERVAL_MS);
  timers.tickIntervals();
  timers.flushTimeouts();
  assert.equal(refreshes, 1);

  stream.emit("open");
  assert.equal(statuses.at(-1), "connected");
  assert.equal(timers.intervalCount, 0, "healthy SSE must suppress fallback polling");
  timers.tickIntervals();
  timers.flushTimeouts();
  assert.equal(refreshes, 1);

  stream.emitInvalidation("sync");
  timers.flushTimeouts();
  assert.equal(refreshes, 2, "synthetic reconnect sync must refetch authoritative state");
  stop();
});

test("unmount clears pending refresh and fallback resources without changing dashboard data", () => {
  const stream = new FakeEventStream();
  const timers = new FakeTimers();
  let refreshes = 0;
  const stop = startNetworkHealthRealtime({
    refresh: () => { refreshes += 1; },
    onStatus: () => {},
    createEventStream: () => stream,
    timers,
  });
  stream.emitInvalidation("network_health");
  stream.emit("error");
  assert.equal(timers.timeoutCount, 1);
  assert.equal(timers.intervalCount, 1);

  stop();
  assert.equal(timers.timerCount, 0);
  assert.equal(stream.closed, true);
  timers.flushTimeouts();
  timers.tickIntervals();
  assert.equal(refreshes, 0);
});

test("slow authoritative refetch is single-flight and invalidations retain only one trailing refresh", async () => {
  const stream = new FakeEventStream();
  const timers = new FakeTimers();
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let refreshes = 0;
  const stop = startLocalRealtimeInvalidation({
    topics: ["device_inspector"], debounceMs: 250, fallbackIntervalMs: 2_000,
    refresh: () => { refreshes += 1; return pending; },
    onStatus: () => {}, createEventStream: () => stream, timers,
  });
  stream.emitInvalidation("sync");
  timers.flushTimeouts();
  assert.equal(refreshes, 1);
  stream.emit("error");
  for (let index = 0; index < 20; index += 1) {
    stream.emitInvalidation("device_inspector");
    timers.tickIntervals();
    timers.flushTimeouts();
  }
  assert.equal(refreshes, 1, "neither SSE nor fallback overlaps the active request");
  assert.equal(timers.timeoutCount, 0);
  release();
  await pending;
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(timers.timeoutCount, 1, "all in-flight events coalesce without losing the last invalidation");
  timers.flushTimeouts();
  assert.equal(refreshes, 2);
  stop();
});

test("a rejected refetch remains recoverable, but disposing an in-flight refetch prevents trailing work", async () => {
  const stream = new FakeEventStream();
  const timers = new FakeTimers();
  let reject: () => void = () => {};
  const pending = new Promise<void>((resolve, fail) => { void resolve; reject = () => fail(new Error("read failed")); });
  let refreshes = 0;
  const stop = startLocalRealtimeInvalidation({
    topics: ["traffic"], debounceMs: 250, fallbackIntervalMs: 60_000,
    refresh: () => { refreshes += 1; return pending; },
    onStatus: () => {}, createEventStream: () => stream, timers,
  });
  stream.emitInvalidation("sync");
  timers.flushTimeouts();
  stream.emitInvalidation("traffic");
  reject();
  await pending.catch(() => {});
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(timers.timeoutCount, 1);
  timers.flushTimeouts();
  assert.equal(refreshes, 2);
  stream.emitInvalidation("traffic");
  stop();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(timers.timerCount, 0);
  assert.equal(stream.closed, true);
  assert.equal(refreshes, 2);
});

test("Inspector subscription depends on identity/lifecycle primitives, not each freshly refetched row", () => {
  const inspector = readFileSync(new URL("../components/device-profile/device-profile-provider.tsx", import.meta.url), "utf8");
  const effectStart = inspector.indexOf('inspectionAuthority !== "local_postgres"');
  const effectEnd = inspector.indexOf("}, [", effectStart);
  assert.ok(effectStart >= 0 && effectEnd > effectStart);
  const effect = inspector.slice(effectStart, effectEnd);
  assert.match(effect, /getDeviceInspectionSessionAction\(selectedRunnerId\)\.then/);
  assert.match(effect, /target_ip === openedIp\) setSession\(result\.data\)/);
  assert.match(effect, /topics: \["device_inspector"\]/);
  assert.match(effect, /refresh: refreshSession/);
  assert.doesNotMatch(effect, /void getDeviceInspectionSessionAction/, "return the promise so invalidations can be coalesced in flight");
  assert.match(inspector.slice(effectEnd), /^\}, \[inspectionAuthority, openedIp, selectedRunnerId, inspectionStatus\]\)/);
  assert.match(inspector, /const openedIp = opened\?\.ipAddress/);
  assert.match(inspector, /const selectedRunnerId = runner\?\.id/);
  assert.match(inspector, /const inspectionStatus = session\?\.status/);
  assert.doesNotMatch(inspector, /\[inspectionAuthority, opened, runner, session\]/);
  const summary = readFileSync(new URL("../components/dashboard/local-traffic-summary.tsx", import.meta.url), "utf8");
  assert.match(summary, /const refresh = \(\) => getTrafficStateAction\(\)\.then/);
  assert.doesNotMatch(summary, /^\s*refresh\(\);/m, "use initial data and SSE sync, not a duplicate mount refetch");
});

test("Network Health consumer has no Supabase channel or Edge Function fallback", () => {
  const dashboard = readFileSync(new URL("../components/dashboard/network-health-dashboard.tsx", import.meta.url), "utf8");
  const realtime = readFileSync(new URL("../lib/network-health-realtime.ts", import.meta.url), "utf8");
  const authoritativeSource = readFileSync(new URL("../lib/network-health.ts", import.meta.url), "utf8");

  assert.doesNotMatch(dashboard, /supabase|createClient|\.channel\(|postgres_changes|removeChannel/);
  assert.doesNotMatch(`${dashboard}\n${realtime}`, /functions\.invoke|network-health["']/);
  assert.match(realtime, /new EventSource\(url\)/);
  assert.match(realtime, /"\/api\/realtime\/events"/);
  assert.match(dashboard, /router\.refresh\(\)/);
  assert.match(authoritativeSource, /return loadNetworkHealthLocal\(\)/);
  assert.match(authoritativeSource, /localHealthTargets\(\)/);
  assert.match(authoritativeSource, /localEvents\(20, "network_health"\)/);
});

class FakeEventStream implements NetworkHealthEventStream {
  closed = false;
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  addEventListener(type: "open" | "error" | "invalidation", listener: (event: Event) => void): void {
    const group = this.listeners.get(type) ?? new Set();
    group.add(listener);
    this.listeners.set(type, group);
  }

  removeEventListener(type: "open" | "error" | "invalidation", listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void { this.closed = true; }

  emit(type: "open" | "error"): void {
    for (const listener of this.listeners.get(type) ?? []) listener(new Event(type));
  }

  emitInvalidation(topic: string): void {
    const data = JSON.stringify({ version: 1, event_id: "test", topic, aggregate_key: null, occurred_at: "2026-09-25T00:00:00.000Z" });
    for (const listener of this.listeners.get("invalidation") ?? []) {
      listener(new MessageEvent("invalidation", { data }));
    }
  }

  get listenerCount(): number {
    return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0);
  }
}

class FakeTimers implements NetworkHealthRealtimeTimers {
  private nextId = 1;
  private readonly timeouts = new Map<number, () => void>();
  private readonly intervals = new Map<number, () => void>();
  lastTimeoutDelay: number | null = null;
  lastIntervalDelay: number | null = null;

  setTimeout(callback: () => void, delayMs: number): unknown {
    this.lastTimeoutDelay = delayMs;
    const id = this.nextId++;
    this.timeouts.set(id, callback);
    return id;
  }

  clearTimeout(handle: unknown): void { this.timeouts.delete(Number(handle)); }

  setInterval(callback: () => void, delayMs: number): unknown {
    this.lastIntervalDelay = delayMs;
    const id = this.nextId++;
    this.intervals.set(id, callback);
    return id;
  }

  clearInterval(handle: unknown): void { this.intervals.delete(Number(handle)); }

  flushTimeouts(): void {
    const callbacks = [...this.timeouts.values()];
    this.timeouts.clear();
    for (const callback of callbacks) callback();
  }

  tickIntervals(): void {
    for (const callback of [...this.intervals.values()]) callback();
  }

  get timeoutCount(): number { return this.timeouts.size; }
  get intervalCount(): number { return this.intervals.size; }
  get timerCount(): number { return this.timeoutCount + this.intervalCount; }
}
