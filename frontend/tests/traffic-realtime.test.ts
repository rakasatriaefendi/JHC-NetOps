import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type {
  NetworkHealthEventStream,
  NetworkHealthRealtimeTimers,
} from "../lib/network-health-realtime.ts";

const { startLocalRealtimeInvalidation } = await import("../lib/network-health-realtime.ts");

test("Traffic invalidations coalesce and synthetic sync refetches authoritative state", () => {
  const stream = new FakeEventStream();
  const timers = new FakeTimers();
  const statuses: string[] = [];
  let refreshes = 0;
  const stop = startLocalRealtimeInvalidation({
    topics: ["traffic"],
    refresh: () => { refreshes += 1; },
    onStatus: (status) => statuses.push(status),
    debounceMs: 250,
    fallbackIntervalMs: 60_000,
    createEventStream: () => stream,
    timers,
  });

  stream.emit("open");
  stream.emitInvalidation("network_health", { snapshot: { untrusted: true } });
  assert.equal(timers.timeoutCount, 0);
  for (let index = 0; index < 8; index += 1) {
    stream.emitInvalidation("traffic", { snapshot: { sequence: index } });
  }
  assert.equal(timers.timeoutCount, 1, "a Traffic burst must schedule one authoritative refetch");
  timers.flushTimeouts();
  assert.equal(refreshes, 1);
  stream.emitInvalidation("sync", { rows: [{ should_not_be_merged: true }] });
  timers.flushTimeouts();
  assert.equal(refreshes, 2);
  assert.deepEqual(statuses, ["connecting", "connected"]);

  stream.emit("error");
  assert.equal(timers.intervalCount, 1);
  assert.equal(timers.lastIntervalDelay, 60_000);
  stream.emit("open");
  assert.equal(timers.intervalCount, 0, "native EventSource reconnect must stop fallback polling");
  stop();
  assert.equal(stream.closed, true);
  assert.equal(stream.listenerCount, 0);
  assert.equal(timers.timerCount, 0);
});

test("local Traffic consumers refetch and keep Supabase compatibility isolated", () => {
  const dashboard = source("../components/dashboard/local-traffic-summary.tsx");
  const trafficLive = source("../components/traffic/traffic-live-page.tsx");
  const discovery = source("../components/dashboard/network-discovery-drawer.tsx");

  const dashboardLocal = dashboard.slice(
    dashboard.indexOf('if (initialAuthority === "local_postgres")'),
    dashboard.indexOf("const supabase = createClient()"),
  );
  assert.match(dashboardLocal, /startLocalRealtimeInvalidation/);
  assert.match(dashboardLocal, /topics: \["traffic"\]/);
  assert.match(dashboard, /getTrafficStateAction\(\)/);
  assert.doesNotMatch(dashboardLocal, /createClient|\.channel\(|postgres_changes|payload\.new/);
  assert.match(dashboard, /supabase\.channel\("dashboard-local-traffic"\)/);

  const trafficLiveLocal = trafficLive.slice(
    trafficLive.indexOf('if (initialAuthority === "local_postgres")'),
    trafficLive.indexOf("const supabase = createClient()", trafficLive.indexOf('if (initialAuthority === "local_postgres")')),
  );
  assert.match(trafficLiveLocal, /startLocalRealtimeInvalidation/);
  assert.match(trafficLiveLocal, /topics: \["traffic"\]/);
  assert.doesNotMatch(trafficLiveLocal, /createClient|\.channel\(|postgres_changes|payload\.new/);
  assert.match(trafficLive, /setInterval\(\(\) => void refresh\(\), 5_000\)/);
  assert.match(trafficLive, /setInterval\(\(\) => void refreshRunners\(\), 10_000\)/);
  assert.match(trafficLive, /supabase[\s\S]+\.channel\("traffic-live-snapshot"\)/);

  const discoveryLocal = discovery.slice(
    discovery.indexOf('if (runnerAuthority === "local_postgres")'),
    discovery.indexOf("const supabase = createClient()", discovery.indexOf('if (runnerAuthority === "local_postgres")')),
  );
  assert.match(discoveryLocal, /startLocalRealtimeInvalidation/);
  assert.match(discoveryLocal, /topics: \["traffic"\]/);
  assert.match(discoveryLocal, /getTrafficStateAction\(\)/);
  assert.match(discoveryLocal, /observedTrafficIps/);
  assert.doesNotMatch(discoveryLocal, /createClient|\.channel\(|postgres_changes|payload\.new/);
  assert.match(discovery, /table: "traffic_live_snapshots"/);
  assert.match(discovery, /table: "network_discovery_sessions"/);
  assert.match(discovery, /table: "diagnostic_runners"/);
});

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

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

  emitInvalidation(topic: string, extra: Record<string, unknown> = {}): void {
    const data = JSON.stringify({
      version: 1,
      event_id: "11111111-1111-4111-8111-111111111111",
      topic,
      aggregate_key: "it-lt8",
      occurred_at: "2026-09-29T00:00:00.000Z",
      ...extra,
    });
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
  lastIntervalDelay: number | null = null;

  setTimeout(callback: () => void): unknown {
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

  get timeoutCount(): number { return this.timeouts.size; }
  get intervalCount(): number { return this.intervals.size; }
  get timerCount(): number { return this.timeoutCount + this.intervalCount; }
}
