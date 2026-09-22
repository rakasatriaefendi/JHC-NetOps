import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { ManagedTelemetryRepository } from "../src/managed-telemetry/repository.js";
import { SupabaseManagedTelemetryRepository } from "../src/managed-telemetry/repository.js";
import { normalizeObservedHosts, prepareObservedHostRows } from "../src/managed-telemetry/observed-hosts.js";
import type { NetworkHealthRepository } from "../src/network-health/repository.js";
import { SupabaseNetworkHealthRepository } from "../src/network-health/repository.js";
import { buildServer } from "../src/server.js";
import type { TrafficRepository } from "../src/traffic/repository.js";
import { SupabaseTrafficRepository } from "../src/traffic/repository.js";

const TOKEN = "local-runner-token-for-tests-only";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const NOW = new Date("2026-09-07T03:04:05.000Z");
const TARGET = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const EVENT = "33333333-3333-4333-8333-333333333333";

class FakeHealth implements NetworkHealthRepository {
  calls: string[] = [];
  async listTargets() { this.calls.push("list"); return { targets: [{ id: TARGET }] }; }
  async publish() { this.calls.push("publish"); return { states: 1, events: 0 }; }
  async claimManualPing() { this.calls.push("claim_manual_ping"); return null; }
  async completeManualPing() { this.calls.push("complete_manual_ping"); return null; }
  async failManualPing() { this.calls.push("fail_manual_ping"); return null; }
}
class FakeTraffic implements TrafficRepository {
  calls: string[] = [];
  async claim() { this.calls.push("claim"); return { id: SESSION }; }
  async updateSession() { this.calls.push("progress"); return null; }
  async updateSnapshot() { this.calls.push("snapshot"); return { stop_requested: false }; }
  async persistFlows() { this.calls.push("flows"); return { persisted: 1 }; }
  async finish() { this.calls.push("finish"); return null; }
}
class FakeTelemetry implements ManagedTelemetryRepository {
  calls: string[] = [];
  async listTargets() { this.calls.push("list"); return { targets: [{ id: TARGET }] }; }
  async publish() { this.calls.push("publish"); return { devices: 1, interfaces: 0, observed_hosts: 0, events: 0 }; }
}

function validHealthPublish() {
  return {
    action: "publish",
    runner_id: "runner-test",
    states: [{ target_id: TARGET, status: "online", latency_ms: 1.2, packet_loss_percent: 0, last_checked_at: NOW.toISOString(), last_success_at: NOW.toISOString(), consecutive_failures: 0, sample_count: 3 }],
    transitions: [],
  };
}
function validSnapshot() {
  return {
    captured_at: NOW.toISOString(),
    summary: { observed_tx_mbps: 1, observed_rx_mbps: 2, packets_observed: 3, packets_per_second: 1.5, active_flows: 0, dominant_protocol: null },
    flows: [], conversations: [], top_talkers: [],
  };
}
function validTelemetryPublish() {
  return {
    action: "publish",
    runner_id: "runner-test",
    device: { target_id: TARGET, status: "connected", observed_hosts_status: "empty", last_polled_at: NOW.toISOString(), last_success_at: NOW.toISOString(), consecutive_poll_failures: 0, uptime_seconds: 42 },
    interfaces: [], transitions: [], observed_hosts: [],
  };
}

test("all recurring routes require the timing-safe runner bearer before validation", async () => {
  const health = new FakeHealth(), traffic = new FakeTraffic(), telemetry = new FakeTelemetry();
  const server = buildServer({ logger: false, networkHealth: { token: TOKEN, repository: health }, traffic: { token: TOKEN, repository: traffic }, managedTelemetry: { token: TOKEN, repository: telemetry } });
  for (const url of ["/api/runner/network-health", "/api/runner/traffic", "/api/runner/managed-telemetry"]) {
    const response = await server.inject({ method: "POST", url, headers: { authorization: "Bearer wrong-token-that-is-long-enough" }, payload: { secret: "not-reflected" } });
    assert.equal(response.statusCode, 401);
    assert.doesNotMatch(response.body, /wrong-token|not-reflected|secret/i);
  }
  assert.deepEqual([...health.calls, ...traffic.calls, ...telemetry.calls], []);
  await server.close();
});

test("valid list and publish contracts dispatch to the matching subsystem only", async () => {
  const health = new FakeHealth(), traffic = new FakeTraffic(), telemetry = new FakeTelemetry();
  const server = buildServer({ logger: false, networkHealth: { token: TOKEN, repository: health, now: () => NOW }, traffic: { token: TOKEN, repository: traffic, now: () => NOW }, managedTelemetry: { token: TOKEN, repository: telemetry, now: () => NOW } });
  const calls = [
    ["/api/runner/network-health", { action: "list_targets", runner_id: "runner-test" }],
    ["/api/runner/network-health", validHealthPublish()],
    ["/api/runner/traffic", { action: "claim_session", runner_id: "runner-test" }],
    ["/api/runner/traffic", { action: "update_snapshot", runner_id: "runner-test", session_id: SESSION, snapshot: validSnapshot() }],
    ["/api/runner/managed-telemetry", { action: "list_targets", runner_id: "runner-test" }],
    ["/api/runner/managed-telemetry", validTelemetryPublish()],
  ] as const;
  for (const [url, payload] of calls) assert.equal((await server.inject({ method: "POST", url, headers: AUTH, payload })).statusCode, 200);
  assert.deepEqual(health.calls, ["list", "publish"]);
  assert.deepEqual(traffic.calls, ["claim", "snapshot"]);
  assert.deepEqual(telemetry.calls, ["list", "publish"]);
  await server.close();
});

test("malformed, unknown, oversized and secret-shaped recurring payloads fail before persistence", async () => {
  const health = new FakeHealth(), traffic = new FakeTraffic(), telemetry = new FakeTelemetry();
  const server = buildServer({ logger: false, networkHealth: { token: TOKEN, repository: health }, traffic: { token: TOKEN, repository: traffic }, managedTelemetry: { token: TOKEN, repository: telemetry, now: () => NOW } });
  const malformed = await server.inject({ method: "POST", url: "/api/runner/network-health", headers: AUTH, payload: { action: "list_targets", runner_id: "runner-test", unknown: true } });
  const secretPayload = validTelemetryPublish();
  Object.assign(secretPayload.device, { community: "must-not-surface" });
  const secret = await server.inject({ method: "POST", url: "/api/runner/managed-telemetry", headers: AUTH, payload: secretPayload });
  const oversized = await server.inject({ method: "POST", url: "/api/runner/traffic", headers: { ...AUTH, "content-type": "application/json" }, payload: JSON.stringify({ action: "persist_flow_batch", padding: "x".repeat(170 * 1024) }) });
  assert.equal(malformed.statusCode, 400);
  assert.equal(secret.statusCode, 400);
  assert.equal(oversized.statusCode, 413);
  assert.doesNotMatch(secret.body, /community|must-not-surface/i);
  assert.deepEqual([...health.calls, ...traffic.calls, ...telemetry.calls], []);
  await server.close();
});

test("bounded persistence deadline and repository failures return sanitized categories", async () => {
  const health: NetworkHealthRepository = {
    async listTargets(_runnerId, signal) {
      await new Promise<void>((resolve, reject) => {
        const keeper = setTimeout(resolve, 100);
        signal.addEventListener("abort", () => { clearTimeout(keeper); reject(signal.reason); }, { once: true });
      });
      return { targets: [] };
    },
    async publish() { return { states: 0, events: 0 }; },
    async claimManualPing() { return null; },
    async completeManualPing() { return null; },
    async failManualPing() { return null; },
  };
  const telemetry: ManagedTelemetryRepository = {
    async listTargets() { throw new Error("authorization=Bearer leaked-token community=private"); },
    async publish() { return { devices: 0, interfaces: 0, observed_hosts: 0, events: 0 }; },
  };
  const server = buildServer({ logger: false, networkHealth: { token: TOKEN, repository: health, timeoutMs: 5 }, managedTelemetry: { token: TOKEN, repository: telemetry } });
  const timeout = await server.inject({ method: "POST", url: "/api/runner/network-health", headers: AUTH, payload: { action: "list_targets", runner_id: "runner-test" } });
  const failure = await server.inject({ method: "POST", url: "/api/runner/managed-telemetry", headers: AUTH, payload: { action: "list_targets", runner_id: "runner-test" } });
  assert.equal(timeout.statusCode, 500);
  assert.equal(failure.statusCode, 500);
  assert.doesNotMatch(`${timeout.body}${failure.body}`, /leaked-token|community|authorization|private/i);
  await server.close();
});

test("Supabase repositories retain the existing tables, RPCs, bulk behavior and no credential payloads", async (t) => {
  const requests: Array<{ url: string; options: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, options?: RequestInit) => {
    const url = String(input), method = options?.method ?? "GET";
    requests.push({ url, options: options ?? {} });
    if (url.includes("network_targets") && method === "GET") return json([{ id: TARGET, critical: false, network_nodes: { name: "Lab", ip_address: "192.168.1.2" } }]);
    if (url.includes("managed_telemetry_targets") && method === "GET") return json([{ id: TARGET }]);
    if (url.includes("traffic_live_sessions") && method === "PATCH") return json([{ status: "running" }]);
    if (url.includes("traffic_live_sessions") && method === "GET") return json([{ id: SESSION }]);
    if (url.includes("managed_observed_hosts_latest") && method === "GET") return json([]);
    if (url.includes("network_nodes") && method === "GET") return json([]);
    if (url.includes("events") && method === "GET") return json([]);
    if (url.includes("traffic_storage_status")) return json([{ status: "healthy", storage_mb: 1 }]);
    return new Response(null, { status: 204 });
  });
  const signal = AbortSignal.timeout(10_000);
  await new SupabaseNetworkHealthRepository("https://project.invalid", "service-role-private").publish("runner-test", validHealthPublish().states, [{ event_id: EVENT, target_id: TARGET, previous_status: "offline", new_status: "online", occurred_at: NOW.toISOString(), latency_ms: 1, packet_loss_percent: 0, consecutive_failures: 0 }], NOW.toISOString(), signal);
  const trafficRepository = new SupabaseTrafficRepository("https://project.invalid", "service-role-private");
  await trafficRepository.updateSnapshot({ action: "update_snapshot", runner_id: "runner-test", session_id: SESSION, snapshot: validSnapshot() }, NOW.toISOString(), signal);
  await trafficRepository.persistFlows({ action: "persist_flow_batch", runner_id: "runner-test", session_id: SESSION, flows: [{ flow_key: "a".repeat(64), src_ip: "192.168.1.2", dst_ip: "192.168.1.3", src_port: 1234, dst_port: 443, protocol: "tcp", first_seen: NOW.toISOString(), last_seen: NOW.toISOString(), total_bytes: 100, packet_count: 1, peak_rate_mbps: 0.1 }] }, signal);
  const telemetry = validTelemetryPublish();
  await new SupabaseManagedTelemetryRepository("https://project.invalid", "service-role-private").publish("runner-test", telemetry.device, [], [], [], NOW.toISOString(), signal);
  const urls = requests.map(({ url }) => url).join("\n");
  for (const name of ["network_health_latest", "network_health_samples", "events", "traffic_live_sessions", "traffic_live_snapshots", "traffic_storage_status", "flows", "managed_device_latest", "managed_interface_latest", "managed_observed_hosts_latest"]) assert.match(urls, new RegExp(name));
  assert.doesNotMatch(JSON.stringify(requests.map(({ options }) => options.body ?? "")), /service-role-private|community|auth_password|priv_password/i);
  const observedMutations = requests.filter(({ url, options }) => url.includes("managed_observed_hosts_latest") && (options.method === "PATCH" || options.method === "POST"));
  assert.ok(observedMutations.length <= 2, "observed hosts stay bounded to one stale update and one current upsert");
});

test("Observed LAN Host normalization preserves bounds, first-seen, resolved names and node correlation", () => {
  const current = normalizeObservedHosts([
    { target_id: TARGET, ip_address: "192.168.1.8", mac_address: "AA:BB:CC:DD:EE:FF", netbios_name: null, observation_source: "ip_net_to_physical", enrichment_status: "unavailable" },
  ], TARGET);
  assert.ok(current);
  const rows = prepareObservedHostRows(current, TARGET, NOW.toISOString(), [{ ip_address: "192.168.1.8", first_seen_at: "2026-09-01T00:00:00.000Z", netbios_name: "KNOWN-HOST", enrichment_status: "resolved" }, { ip_address: "192.168.1.9", first_seen_at: "2026-09-01T00:00:00.000Z", netbios_name: null, enrichment_status: "not_attempted" }], [{ id: "44444444-4444-4444-8444-444444444444", ip_address: "192.168.1.8" }]);
  assert.deepEqual(rows.current[0], {
    target_id: TARGET,
    node_id: "44444444-4444-4444-8444-444444444444",
    ip_address: "192.168.1.8",
    mac_address: "aa:bb:cc:dd:ee:ff",
    netbios_name: "KNOWN-HOST",
    observation_source: "ip_net_to_physical",
    enrichment_status: "resolved",
    first_seen_at: "2026-09-01T00:00:00.000Z",
    last_seen_at: NOW.toISOString(),
    status: "current",
    updated_at: NOW.toISOString(),
  });
  assert.equal(rows.stale[0]?.ip_address, "192.168.1.9");
});

test("local contracts retain the Edge tables, RPCs and event coupling", () => {
  const source = [
    readFileSync(new URL("../../supabase/functions/network-health/index.ts", import.meta.url), "utf8"),
    readFileSync(new URL("../../supabase/functions/traffic-live/index.ts", import.meta.url), "utf8"),
    readFileSync(new URL("../../supabase/functions/managed-telemetry/index.ts", import.meta.url), "utf8"),
  ].join("\n");
  for (const coupling of ["network_health_samples", "expire_stale_traffic_sessions", "traffic_storage_status", "managed_observed_hosts_latest", "raw_context->>kind"]) assert.match(source, new RegExp(coupling));
});

function json(value: unknown) { return new Response(JSON.stringify(value), { status: 200 }); }
