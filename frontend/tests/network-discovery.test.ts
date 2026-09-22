import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const { DISCOVERY_RUNNER_FRESHNESS_MS, isDiscoveryRunnerAvailable, isDiscoveryRunnerOnline, normalizeDiscoveryRunners, observedTrafficIps } = await import("../lib/network-discovery-client.ts");

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

  const [normalized] = normalizeDiscoveryRunners([localRunner]);
  assert.deepEqual(normalized, {
    id: "it-lt8",
    display_name: "IT LT8 Runner",
    health_status: "online",
    last_seen_at: localRunner.last_seen_at,
    capabilities: { operations: localRunner.capabilities.operations },
  });
  assert.equal(isDiscoveryRunnerAvailable(normalized, now), true);
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

test("authoritative polling keeps a healthy runner available beyond the original snapshot window", () => {
  const firstHeartbeat = runner(10_000);
  assert.equal(isDiscoveryRunnerAvailable(firstHeartbeat, 20_000), true);
  assert.equal(isDiscoveryRunnerAvailable(runner(40_000), 40_001), true);
});

test("a transient refresh failure retains the last runner only through its normal freshness window", () => {
  const lastKnownRunner = runner(10_000);
  assert.equal(isDiscoveryRunnerAvailable(lastKnownRunner, 20_000), true);
  assert.equal(isDiscoveryRunnerAvailable(
    lastKnownRunner,
    10_000 + DISCOVERY_RUNNER_FRESHNESS_MS + 1,
  ), false);
});

test("dashboard loads authoritative discovery runners independently from Traffic", () => {
  const page = readFileSync(new URL("../app/(protected)/dashboard/page.tsx", import.meta.url), "utf8");
  assert.match(page, /loadDiscoveryRunners\(traffic\.data\.runners\)/);
  assert.match(page, /discoveryRunners=\{discoveryRunners\.data\}/);
});

test("drawer refreshes runners immediately and every ten seconds only while open", () => {
  const source = readFileSync(new URL("../components/dashboard/network-discovery-drawer.tsx", import.meta.url), "utf8");
  assert.match(source, /if \(!open\) return;[\s\S]*void refreshRunners\(\);/);
  assert.match(source, /setInterval\(\(\) => void refreshRunners\(\), 10_000\)/);
  assert.match(source, /clearInterval\(interval\)/);
  assert.match(source, /if \(!result\.ok\) return;[\s\S]*setLiveRunners\(result\.data\)/);
  assert.match(source, /catch \{[\s\S]*Retain the last authoritative snapshot/);
});

test("runner refresh action is authenticated, authority-aware, uncached, and secret-safe", () => {
  const action = readFileSync(new URL("../app/actions/network-discovery.ts", import.meta.url), "utf8");
  const persistence = readFileSync(new URL("../lib/application-persistence.ts", import.meta.url), "utf8");
  const drawer = readFileSync(new URL("../components/dashboard/network-discovery-drawer.tsx", import.meta.url), "utf8");
  assert.match(action, /await requireApprovedProfile\(\)/);
  assert.match(action, /authority === "local_postgres"[\s\S]*await localRunners\(\)/);
  assert.match(action, /supabase\.from\("diagnostic_runners"\)/);
  assert.match(persistence, /fetch\([\s\S]*cache: "no-store"/);
  assert.doesNotMatch(drawer, /LOCAL_BACKEND_FRONTEND_TOKEN|localRunners|localApplicationRequest/);
});

test("local runner liveness ignores Supabase heartbeat while Supabase mode retains it", () => {
  const source = readFileSync(new URL("../components/dashboard/network-discovery-drawer.tsx", import.meta.url), "utf8");
  assert.match(source, /table: "diagnostic_runners"/);
  assert.match(source, /filter: `id=eq\.\$\{runner\.id\}`/);
  assert.match(source, /if \(runnerAuthority === "supabase"\)[\s\S]*table: "diagnostic_runners"/);
  assert.match(source, /removeChannel\(channel\)/);
  assert.match(source, /\[open, runner\?\.id, runnerAuthority\]/);
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
