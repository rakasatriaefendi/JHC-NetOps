import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type {
  NetworkHealthEventStream,
  NetworkHealthRealtimeTimers,
} from "../lib/network-health-realtime.ts";

const { startLocalRealtimeInvalidation } = await import("../lib/network-health-realtime.ts");

test("Managed Telemetry invalidations coalesce, sync refetches, and cleanup is bounded", () => {
  const stream = new FakeEventStream();
  const timers = new FakeTimers();
  const statuses: string[] = [];
  let streamUrl = "";
  let refreshes = 0;
  const stop = startLocalRealtimeInvalidation({
    topics: ["managed_telemetry"],
    refresh: () => { refreshes += 1; },
    onStatus: (status) => statuses.push(status),
    debounceMs: 250,
    fallbackIntervalMs: 60_000,
    createEventStream: (url) => { streamUrl = url; return stream; },
    timers,
  });

  assert.equal(streamUrl, "/api/realtime/events");
  stream.emit("open");
  stream.emitInvalidation("traffic", { row: { must_not_merge: true } });
  assert.equal(timers.timeoutCount, 0);
  for (let index = 0; index < 12; index += 1) {
    stream.emitInvalidation("managed_telemetry", { interface: { if_index: index } });
  }
  assert.equal(timers.timeoutCount, 1, "a latest-state burst must schedule one authoritative refetch");
  assert.equal(timers.lastTimeoutDelay, 250);
  timers.flushTimeouts();
  assert.equal(refreshes, 1);

  stream.emitInvalidation("sync", { observed_hosts: [{ ip_address: "untrusted" }] });
  timers.flushTimeouts();
  assert.equal(refreshes, 2, "synthetic sync must refetch authoritative state");
  stream.emit("error");
  assert.equal(timers.intervalCount, 1);
  assert.equal(timers.lastIntervalDelay, 60_000);
  stream.emit("open");
  assert.equal(timers.intervalCount, 0);
  assert.deepEqual(statuses, ["connecting", "connected", "fallback", "connected"]);

  stop();
  assert.equal(stream.closed, true);
  assert.equal(stream.listenerCount, 0);
  assert.equal(timers.timerCount, 0);
});

test("Device Profile isolates local Managed Telemetry SSE from its Supabase compatibility branch", () => {
  const section = source("../components/device-profile/managed-telemetry-section.tsx");
  const action = source("../app/actions/snmp.ts");
  const localStart = section.indexOf('if (authority === "local_postgres")');
  const supabaseStart = section.indexOf("const supabase = createClient();", localStart);
  assert.ok(localStart >= 0, "local Managed Telemetry authority branch must exist");
  assert.ok(supabaseStart > localStart, "Supabase channel creation must follow the returning local branch");
  assert.equal([...section.matchAll(/const supabase = createClient\(\);/g)].length, 1);
  const localBranch = section.slice(localStart, supabaseStart);
  const supabaseBranch = section.slice(supabaseStart);

  assert.match(action, /const authority = applicationAuthority\(\)/);
  assert.match(action, /loadManagedTelemetryForNodeAction/);
  assert.match(action, /return \{[\s\S]*authority,[\s\S]*target,[\s\S]*interfaces:/);
  assert.match(localBranch, /startLocalRealtimeInvalidation/);
  assert.match(localBranch, /topics: \["managed_telemetry"\]/);
  assert.match(localBranch, /loadManagedTelemetryForNodeAction\(nodeId\)/);
  assert.match(localBranch, /debounceMs: 250/);
  assert.match(localBranch, /fallbackIntervalMs: 60_000/);
  assert.match(localBranch, /return \(\) => \{ cancelled = true; stopRealtime\(\); \};\s*\}\s*$/);
  assert.doesNotMatch(localBranch, /createClient|\.channel\(|postgres_changes|payload\.new/);

  for (const table of [
    "managed_device_latest",
    "managed_interface_latest",
    "managed_observed_hosts_latest",
  ]) {
    assert.match(supabaseBranch, new RegExp(`table: "${table}"`));
  }
  assert.match(supabaseBranch, /payload\.new as ManagedDeviceLatest/);
  assert.match(supabaseBranch, /removeChannel\(channel\)/);
  assert.doesNotMatch(supabaseBranch, /table: "events"/);
  assert.doesNotMatch(section, /LOCAL_BACKEND_(?:URL|FRONTEND_TOKEN)|localApplicationRequest/);
});

test("SNMP workspace, Observed LAN Hosts, and managed events remain server-snapshot only", () => {
  const workspace = source("../components/snmp/managed-telemetry-detail.tsx");
  const hosts = source("../components/snmp/observed-lan-hosts.tsx");
  const workspacePage = source("../app/(protected)/snmp/page.tsx");
  const hostsPage = source("../app/(protected)/snmp/[targetId]/hosts/page.tsx");
  const dataSource = source("../lib/managed-telemetry-source.ts");
  const combined = [workspace, hosts, workspacePage, hostsPage, dataSource].join("\n");

  assert.doesNotMatch(combined, /startLocalRealtimeInvalidation|new EventSource|\.channel\(|postgres_changes/);
  assert.match(dataSource, /loadManagedTelemetryWorkspace/);
  assert.match(dataSource, /loadManagedObservedHostsPage/);
  assert.doesNotMatch(source("../components/device-profile/managed-telemetry-section.tsx"), /table: "events"/);
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
      aggregate_key: "22222222-2222-4222-8222-222222222222",
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

  get timeoutCount(): number { return this.timeouts.size; }
  get intervalCount(): number { return this.intervals.size; }
  get timerCount(): number { return this.timeoutCount + this.intervalCount; }
}
