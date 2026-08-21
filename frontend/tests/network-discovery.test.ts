import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { DISCOVERY_RUNNER_FRESHNESS_MS, isDiscoveryRunnerOnline, observedTrafficIps, type DiscoveryRunner } from "../lib/network-discovery.ts";

const runner = (lastSeenAt: number): DiscoveryRunner => ({
  id: "runner-test",
  display_name: "Runner Test",
  last_seen_at: new Date(lastSeenAt).toISOString(),
  health_status: "online",
  capabilities: { operations: ["network_discovery"] },
});

test("initial fresh discovery runner heartbeat is online", () => {
  assert.equal(isDiscoveryRunnerOnline(runner(10_000), 10_001), true);
});

test("a newer Realtime heartbeat keeps the discovery runner online after 30 seconds", () => {
  const later = 10_000 + DISCOVERY_RUNNER_FRESHNESS_MS + 1;
  assert.equal(isDiscoveryRunnerOnline(runner(10_000), later), false);
  assert.equal(isDiscoveryRunnerOnline(runner(later), later), true);
});

test("a genuinely stale discovery runner heartbeat becomes offline", () => {
  assert.equal(isDiscoveryRunnerOnline(runner(10_000), 10_000 + DISCOVERY_RUNNER_FRESHNESS_MS + 1), false);
});

test("bounded drawer subscription includes runner heartbeats and cleanup", () => {
  const source = readFileSync(new URL("../components/dashboard/network-discovery-drawer.tsx", import.meta.url), "utf8");
  assert.match(source, /table: "diagnostic_runners"/);
  assert.match(source, /filter: `id=eq\.\$\{runner\.id\}`/);
  assert.match(source, /removeChannel\(channel\)/);
  assert.match(source, /\[open, runner\?\.id\]/);
});

test("discovery correlates Traffic by IP without copying flow payloads", () => {
  const ips = observedTrafficIps([{
    flows: [
      { src_ip: "192.168.188.73", dst_ip: "192.168.188.219" },
      { src_ip: "192.168.188.73", dst_ip: "1.1.1.1" },
    ],
    top_talkers: [{ ip: "192.168.188.91" }],
  }]);
  assert.deepEqual(ips.sort(), ["1.1.1.1", "192.168.188.219", "192.168.188.73", "192.168.188.91"].sort());
});
