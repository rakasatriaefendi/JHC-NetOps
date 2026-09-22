import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const { DISCOVERY_RUNNER_FRESHNESS_MS, isDiscoveryRunnerAvailable, isDiscoveryRunnerOnline, observedTrafficIps } = await import("../lib/network-discovery-client.ts");

interface DiscoveryRunner {
  id: string;
  display_name: string;
  last_seen_at: string;
  health_status: "online" | "degraded";
  capabilities: { operations?: string[] };
}

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

test("fresh local PostgreSQL runner with discovery operation and no targets is available", () => {
  const now = Date.now();
  const localRunner = {
    id: "it-lt8",
    display_name: "IT LT8 Runner",
    health_status: "online" as const,
    last_seen_at: new Date(now).toISOString(),
    capabilities: {
      targets: [],
      operations: [
        "bandwidth_and_path",
        "traffic_live",
        "network_discovery",
        "device_inspect",
        "manual_ping",
      ],
    },
  };

  assert.equal(isDiscoveryRunnerAvailable(localRunner, now), true);
  assert.equal(isDiscoveryRunnerAvailable({
    ...localRunner,
    last_seen_at: new Date(now - DISCOVERY_RUNNER_FRESHNESS_MS - 1).toISOString(),
  }, now), false);
  assert.equal(isDiscoveryRunnerAvailable({ ...localRunner, health_status: "degraded" }, now), false);
  assert.equal(isDiscoveryRunnerAvailable({
    ...localRunner,
    capabilities: { targets: [], operations: ["traffic_live", "manual_ping"] },
  }, now), false);
});

test("dashboard loads authoritative discovery runners independently from Traffic", () => {
  const page = readFileSync(new URL("../app/(protected)/dashboard/page.tsx", import.meta.url), "utf8");
  assert.match(page, /loadDiscoveryRunners\(traffic\.data\.runners\)/);
  assert.match(page, /discoveryRunners=\{discoveryRunners\.data\}/);
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
