import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type {
  NetworkHealthEventStream,
  NetworkHealthRealtimeTimers,
} from "../lib/network-health-realtime.ts";

const { startLocalRealtimeInvalidation } = await import("../lib/network-health-realtime.ts");

test("Diagnostics local invalidations refetch authoritative state and coalesce bursts", () => {
  const stream = new FakeEventStream();
  const timers = new FakeTimers();
  const statuses: string[] = [];
  let refreshes = 0;
  const stop = startLocalRealtimeInvalidation({
    topics: ["diagnostics"],
    refresh: () => { refreshes += 1; },
    onStatus: (status) => statuses.push(status),
    debounceMs: 250,
    fallbackIntervalMs: 4_000,
    createEventStream: () => stream,
    timers,
  });

  stream.emit("open");
  stream.emitInvalidation("device_inspector", { status: "completed", result: { untrusted: true } });
  assert.equal(timers.timeoutCount, 0, "irrelevant row-shaped payload must not refresh Diagnostics");
  for (let index = 0; index < 8; index += 1) {
    stream.emitInvalidation("diagnostics", { status: "running", progress: index });
  }
  assert.equal(timers.timeoutCount, 1, "a burst must schedule one authoritative refetch");
  timers.flushTimeouts();
  assert.equal(refreshes, 1);
  stream.emitInvalidation("sync", { rows: [{ should_not_be_merged: true }] });
  timers.flushTimeouts();
  assert.equal(refreshes, 2);
  assert.deepEqual(statuses, ["connecting", "connected"]);

  stop();
  assert.equal(stream.closed, true);
  assert.equal(stream.listenerCount, 0);
  assert.equal(timers.timerCount, 0);
});

test("Device Inspector local invalidations refetch without accepting realtime row data", () => {
  const stream = new FakeEventStream();
  const timers = new FakeTimers();
  let refreshes = 0;
  const stop = startLocalRealtimeInvalidation({
    topics: ["device_inspector"],
    refresh: () => { refreshes += 1; },
    onStatus: () => {},
    debounceMs: 250,
    fallbackIntervalMs: 2_000,
    createEventStream: () => stream,
    timers,
  });

  stream.emitInvalidation("network_health", { result: { detected_identity: "untrusted" } });
  assert.equal(timers.timeoutCount, 0);
  stream.emitInvalidation("device_inspector", { result: { detected_identity: "untrusted" } });
  timers.flushTimeouts();
  assert.equal(refreshes, 1, "event metadata can only request an authoritative refetch");
  stream.emitInvalidation("sync", { result: { detected_identity: "also-untrusted" } });
  timers.flushTimeouts();
  assert.equal(refreshes, 2);

  stop();
  assert.equal(stream.closed, true);
  assert.equal(timers.timerCount, 0);
});

test("degraded local realtime uses one bounded fallback and cleanup removes every resource", () => {
  const stream = new FakeEventStream();
  const timers = new FakeTimers();
  let refreshes = 0;
  const stop = startLocalRealtimeInvalidation({
    topics: ["diagnostics"],
    refresh: () => { refreshes += 1; },
    onStatus: () => {},
    debounceMs: 250,
    fallbackIntervalMs: 4_000,
    createEventStream: () => stream,
    timers,
  });

  stream.emit("error");
  stream.emit("error");
  assert.equal(timers.intervalCount, 1);
  assert.equal(timers.lastIntervalDelay, 4_000);
  timers.tickIntervals();
  timers.flushTimeouts();
  assert.equal(refreshes, 1);
  stream.emit("open");
  assert.equal(timers.intervalCount, 0, "EventSource reconnect must stop fallback polling");
  stream.emitInvalidation("diagnostics");
  stop();
  timers.flushTimeouts();
  assert.equal(refreshes, 1, "cleanup must cancel a pending invalidation refresh");
  assert.equal(stream.listenerCount, 0);
  assert.equal(timers.timerCount, 0);
});

test("local Diagnostics and Device Inspector branches use SSE while Supabase compatibility remains isolated", () => {
  const diagnostics = source("../components/diagnostics/one-click-diagnostics.tsx");
  const inspector = source("../components/device-profile/device-profile-provider.tsx");
  const diagnosticsLocal = diagnostics.slice(diagnostics.indexOf('if (authority === "local_postgres")'),
    diagnostics.indexOf("const supabase = createClient()"));
  const inspectorLocal = inspector.slice(inspector.indexOf('inspectionAuthority !== "local_postgres"'),
    inspector.indexOf('inspectionAuthority !== "supabase"'));

  assert.match(diagnosticsLocal, /startLocalRealtimeInvalidation/);
  assert.match(diagnosticsLocal, /topics: \["diagnostics"\]/);
  assert.match(diagnosticsLocal, /refresh: \(\) => void refetchState\(\)/);
  assert.match(diagnostics, /const result = await getDiagnosticJobStateAction\(\)/);
  assert.doesNotMatch(diagnosticsLocal, /createClient|\.channel\(|postgres_changes|payload\.new/);
  assert.match(inspectorLocal, /startLocalRealtimeInvalidation/);
  assert.match(inspectorLocal, /topics: \["device_inspector"\]/);
  assert.match(inspectorLocal, /getDeviceInspectionSessionAction/);
  assert.doesNotMatch(inspectorLocal, /createClient|\.channel\(|postgres_changes|payload\.new/);
  assert.match(inspectorLocal, /\["queued", "running"\]\.includes\(session\.status\)/);
  assert.doesNotMatch(inspectorLocal, /startDeviceInspectionAction|startInspection\(/);
  assert.match(diagnostics, /supabase\.channel\("lan-diagnostics-live"\)/);
  assert.match(inspector, /supabase\.channel\(`device-inspector:/);
  assert.doesNotMatch(`${diagnosticsLocal}\n${inspectorLocal}`, /LOCAL_BACKEND_|127\.0\.0\.1/);
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
    const data = JSON.stringify({ version: 1, event_id: "test", topic, aggregate_key: "test", occurred_at: "2026-09-28T00:00:00.000Z", ...extra });
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

  tickIntervals(): void {
    for (const callback of [...this.intervals.values()]) callback();
  }

  get timeoutCount(): number { return this.timeouts.size; }
  get intervalCount(): number { return this.intervals.size; }
  get timerCount(): number { return this.timeoutCount + this.intervalCount; }
}
