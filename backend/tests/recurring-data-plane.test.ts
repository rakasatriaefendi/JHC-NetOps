import assert from "node:assert/strict";
import test from "node:test";

import type { ManagedTelemetryRepository } from "../src/managed-telemetry/repository.js";
import { normalizeObservedHosts, prepareObservedHostRows } from "../src/managed-telemetry/observed-hosts.js";
import type { NetworkHealthRepository } from "../src/network-health/repository.js";
import { buildServer } from "../src/server.js";
import type { TrafficRepository } from "../src/traffic/repository.js";

const TOKEN = "local-runner-token-for-tests-only";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const NOW = new Date("2026-09-07T03:04:05.000Z");
const TARGET = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";

class FakeHealth implements NetworkHealthRepository {
  calls: string[] = [];
  manualResult: Record<string, unknown> | null = null;
  claimResult: Record<string, unknown> | null = null;
  async listTargets() { this.calls.push("list"); return { targets: [{ id: TARGET }] }; }
  async publish() { this.calls.push("publish"); return { states: 1, events: 0 }; }
  async claimManualPing() { this.calls.push("claim_manual_ping"); return this.claimResult; }
  async completeManualPing() { this.calls.push("complete_manual_ping"); return this.manualResult; }
  async failManualPing() { this.calls.push("fail_manual_ping"); return this.manualResult; }
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

test("Manual Ping claim accepts the runner payload and no queued job is a successful empty response", async () => {
  const health = new FakeHealth();
  const server = buildServer({ logger: false, networkHealth: { token: TOKEN, repository: health, now: () => NOW } });
  const response = await server.inject({ method: "POST", url: "/api/runner/network-health", headers: AUTH,
    payload: { action: "claim_manual_ping", runner_id: "it-lt8" } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { data: null });
  assert.deepEqual(health.calls, ["claim_manual_ping"]);
  await server.close();
});

test("Manual Ping claim returns a valid queued job claimed by the local repository", async () => {
  const health = new FakeHealth();
  health.claimResult = { id: SESSION, runner_id: "it-lt8", status: "running" };
  const server = buildServer({ logger: false, networkHealth: { token: TOKEN, repository: health, now: () => NOW } });
  const response = await server.inject({ method: "POST", url: "/api/runner/network-health", headers: AUTH,
    payload: { action: "claim_manual_ping", runner_id: "it-lt8" } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { data: health.claimResult });
  assert.deepEqual(health.calls, ["claim_manual_ping"]);
  await server.close();
});

test("Manual Ping complete and fail contracts bind a bounded job id and result", async () => {
  const health = new FakeHealth();
  health.manualResult = { id: SESSION };
  const server = buildServer({ logger: false, networkHealth: { token: TOKEN, repository: health, now: () => NOW } });
  const complete = await server.inject({ method: "POST", url: "/api/runner/network-health", headers: AUTH,
    payload: { action: "complete_manual_ping", runner_id: "it-lt8", ping_id: SESSION,
      result: { ok: true, latency_ms: 4.2 } } });
  const fail = await server.inject({ method: "POST", url: "/api/runner/network-health", headers: AUTH,
    payload: { action: "fail_manual_ping", runner_id: "it-lt8", ping_id: SESSION,
      error_code: "MANUAL_PING_FAILED" } });
  const unbounded = await server.inject({ method: "POST", url: "/api/runner/network-health", headers: AUTH,
    payload: { action: "complete_manual_ping", runner_id: "it-lt8", ping_id: SESSION,
      result: { ok: true, latency_ms: 4.2, raw: "forbidden" } } });
  assert.equal(complete.statusCode, 200);
  assert.equal(fail.statusCode, 200);
  assert.equal(unbounded.statusCode, 400);
  assert.deepEqual(health.calls, ["complete_manual_ping", "fail_manual_ping"]);
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
