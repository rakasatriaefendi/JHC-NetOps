import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isRunnerFresh, type DiagnosticRunner } from "../lib/diagnostic-jobs.ts";
import { DISCOVERY_RUNNER_FRESHNESS_MS, isDiscoveryRunnerAvailable, isDiscoveryRunnerOnline } from "../lib/network-discovery-client.ts";
import { isRunnerHeartbeatFresh, RUNNER_FRESHNESS_MS } from "../lib/runner-freshness.ts";
import { isTrafficRunnerAvailable, TRAFFIC_RUNNER_FRESHNESS_MS } from "../lib/traffic.ts";
import { DEFAULT_MONITORING_INTERVAL, intervalForMode, MONITORING_INTERVALS } from "../lib/monitoring-modes.ts";

const epoch = Date.parse("2026-10-07T00:00:00.000Z");
function runner(lastSeen = epoch): DiagnosticRunner {
  return {
    id: "it-lt8", display_name: "IT LT8 Runner", last_seen_at: new Date(lastSeen).toISOString(),
    health_status: "online", health_error_code: null, preflight: {}, updated_at: new Date(lastSeen).toISOString(),
    capabilities: { source_locations: [], targets: [], durations: [],
      operations: ["bandwidth_and_path", "network_discovery", "traffic_live"] },
  };
}

function assertFresh(value: DiagnosticRunner, now: number, expected: boolean) {
  assert.equal(isRunnerHeartbeatFresh(value.last_seen_at, now), expected);
  assert.equal(isRunnerFresh(value, now), expected);
  assert.equal(isDiscoveryRunnerOnline(value, now), expected);
  assert.equal(isDiscoveryRunnerAvailable(value, now), expected);
  assert.equal(isTrafficRunnerAvailable(value, now), expected);
}

test("all active frontend freshness consumers share the bounded 120-second backend tolerance", () => {
  assert.equal(RUNNER_FRESHNESS_MS, 120_000);
  assert.equal(DISCOVERY_RUNNER_FRESHNESS_MS, RUNNER_FRESHNESS_MS);
  assert.equal(TRAFFIC_RUNNER_FRESHNESS_MS, RUNNER_FRESHNESS_MS);
  const backend = readFileSync(new URL("../../backend/src/persistence/control-plane.ts", import.meta.url), "utf8");
  assert.match(backend, /RUNNER_FRESHNESS_MS = 120_000;/);
  const drawer = readFileSync(new URL("../components/dashboard/network-discovery-drawer.tsx", import.meta.url), "utf8");
  assert.match(drawer, /Date\.parse\(runnerLastSeenAt\) \+ DISCOVERY_RUNNER_FRESHNESS_MS/);
});

test("a heartbeat remains fresh past 30 seconds and until the next 60-second heartbeat", () => {
  for (const age of [0, 30_000, 30_001, 59_999, 60_000, 60_001]) {
    assertFresh(runner(), epoch + age, true);
  }
});

test("consecutive 60-second heartbeats keep Discovery, Diagnostics, and Traffic continuously available", () => {
  for (let interval = 0; interval < 10; interval += 1) {
    const lastSeen = epoch + interval * 60_000;
    for (let age = 0; age <= 60_000; age += 1_000) assertFresh(runner(lastSeen), lastSeen + age, true);
  }
});

test("a stopped runner expires after the bounded threshold, not at 30 seconds", () => {
  assertFresh(runner(), epoch + 119_999, true);
  assertFresh(runner(), epoch + 120_000, true);
  assertFresh(runner(), epoch + 120_001, false);
  assertFresh(runner(), epoch + 180_000, false);
  assertFresh({ ...runner(), last_seen_at: "invalid" }, epoch, false);
});

test("heartbeat grace does not remove status or capability checks; empty targets are valid", () => {
  const fresh = runner();
  assertFresh(fresh, epoch + 60_000, true);
  const degraded = { ...fresh, health_status: "degraded" as const };
  assert.equal(isDiscoveryRunnerOnline(degraded, epoch), false);
  assert.equal(isTrafficRunnerAvailable(degraded, epoch), false);
  const incapable = { ...fresh, capabilities: { ...fresh.capabilities, operations: [] } };
  assert.equal(isDiscoveryRunnerAvailable(incapable, epoch), false);
  assert.equal(isTrafficRunnerAvailable(incapable, epoch), false);
  assert.equal(isDiscoveryRunnerAvailable(null, epoch), false);
  assert.equal(isTrafficRunnerAvailable(null, epoch), false);
  // Diagnostics' age-only helper still relies on its caller's online predicate.
  const diagnostics = readFileSync(new URL("../components/diagnostics/one-click-diagnostics.tsx", import.meta.url), "utf8");
  assert.match(diagnostics, /runner\.health_status === "online" && isRunnerFresh\(runner, now\)/);
});

test("freshness change preserves monitoring presets and the runner's configured claim/heartbeat cadence", () => {
  assert.deepEqual(MONITORING_INTERVALS, [15, 30, 60, 900, 1800]);
  assert.equal(DEFAULT_MONITORING_INTERVAL, 900);
  assert.equal(intervalForMode("moderate"), 900);
  assert.equal(intervalForMode("resource_saver"), 1800);
  assert.equal(intervalForMode("aggressive", 30), 30);
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const main = source("../../runner/src/main.mjs");
  assert.match(main, /startHeartbeatLoop\(\s*sendHeartbeat,\s*config\.heartbeat_interval_ms,/);
  assert.match(main, /if \(!once\) await delay\(config\.poll_interval_ms\)/);
  assert.match(main, /backend\.claimDiscovery\(config\.runner_id\)/);
  assert.match(main, /backend\.claimInspection\(config\.runner_id\)/);
  for (const path of ["../../runner/src/network-health.mjs", "../../runner/src/snmp-telemetry.mjs"]) {
    assert.match(source(path), /setInterval\(\(\) => void this\.tick\(\), 1_000\)/);
  }
  assert.match(source("../../runner/src/network-health.mjs"), /scheduledTarget\.probe_interval_seconds \* 1000/);
  assert.match(source("../../runner/src/snmp-telemetry.mjs"), /scheduledTarget\.poll_interval_seconds \* 1000/);
  assert.match(source("../../runner/src/config.mjs"), /value\[field\] < 1000 \|\| value\[field\] > 60000/);
});
