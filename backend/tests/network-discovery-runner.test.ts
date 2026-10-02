import assert from "node:assert/strict";
import test from "node:test";

import type { DiscoveryContext, DiscoveryHost } from "../src/network-discovery/contract.js";
import type { NetworkDiscoveryRepository } from "../src/persistence/network-discovery.js";
import { buildServer } from "../src/server.js";

const TOKEN = "local-runner-token-for-tests-only";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const NOW = new Date("2026-09-22T01:02:03.000Z");
const SESSION = "30000000-0000-4000-8000-000000000003";
const CONTEXT = {
  connection_type: "wifi",
  interface_alias: "Wi-Fi",
  local_ipv4: "192.168.1.67",
  subnet_cidr: "192.168.1.0/24",
  scan_start_ipv4: "192.168.1.1",
  scan_end_ipv4: "192.168.1.254",
} as const;

class FakeDiscovery implements NetworkDiscoveryRepository {
  calls: string[] = [];
  active = true;
  session: Record<string, unknown> = { runner_id: "it-lt8", session_id: SESSION, status: "running", phase: "prepare" };
  async get() { return this.session; }
  async create() { return this.session; }
  async start() { return this.session; }
  async expireStale() {}
  async claim(runnerId: string) { this.calls.push(`claim:${runnerId}`); return this.session; }
  async contextReady(runnerId: string, sessionId: string, context: DiscoveryContext) {
    this.calls.push(`context:${runnerId}:${sessionId}:${context.subnet_cidr}`); return this.active ? { ...this.session, status: "idle" } : null;
  }
  async progress(runnerId: string, sessionId: string, _context: DiscoveryContext, scannedHosts: number, results: readonly DiscoveryHost[]) {
    this.calls.push(`progress:${runnerId}:${sessionId}:${scannedHosts}:${results.length}`); return { ...this.session, phase: "scan" };
  }
  async complete(runnerId: string, sessionId: string, scannedHosts: number) {
    this.calls.push(`complete:${runnerId}:${sessionId}:${scannedHosts}`); return { ...this.session, status: "completed", phase: "scan" };
  }
  async fail(runnerId: string, sessionId: string, errorCode: string) {
    this.calls.push(`fail:${runnerId}:${sessionId}:${errorCode}`); return { ...this.session, status: "failed" };
  }
}

test("local Discovery runner route requires bearer authentication", async () => {
  const repository = new FakeDiscovery();
  const server = buildServer({ logger: false, networkDiscovery: { token: TOKEN, repository } });
  const response = await server.inject({ method: "POST", url: "/api/runner/network-discovery",
    headers: { authorization: "Bearer wrong-token-that-is-long-enough" }, payload: { action: "claim_session", runner_id: "it-lt8" } });
  assert.equal(response.statusCode, 401);
  assert.deepEqual(repository.calls, []);
  await server.close();
});

test("local queued prepare can be claimed and prepared context is persisted", async () => {
  const repository = new FakeDiscovery();
  const server = buildServer({ logger: false, networkDiscovery: { token: TOKEN, repository, now: () => NOW } });
  const claim = await server.inject({ method: "POST", url: "/api/runner/network-discovery", headers: AUTH,
    payload: { action: "claim_session", runner_id: "it-lt8" } });
  const prepared = await server.inject({ method: "POST", url: "/api/runner/network-discovery", headers: AUTH,
    payload: { action: "context_ready", runner_id: "it-lt8", session_id: SESSION, context: CONTEXT } });
  assert.equal(claim.statusCode, 200);
  assert.equal(prepared.statusCode, 200);
  assert.deepEqual(repository.calls, [`claim:it-lt8`, `context:it-lt8:${SESSION}:192.168.1.0/24`]);
  await server.close();
});

test("local queued scan can publish bounded progress and complete", async () => {
  const repository = new FakeDiscovery();
  const server = buildServer({ logger: false, networkDiscovery: { token: TOKEN, repository, now: () => NOW } });
  const host = { ip_address: "192.168.1.1", evidence: ["icmp"], latency_ms: 1.2,
    is_this_device: false, is_gateway: true, reachability_evidence: "icmp_verified" };
  const progress = await server.inject({ method: "POST", url: "/api/runner/network-discovery", headers: AUTH,
    payload: { action: "update_progress", runner_id: "it-lt8", session_id: SESSION, context: CONTEXT, scanned_hosts: 1, results: [host] } });
  const completed = await server.inject({ method: "POST", url: "/api/runner/network-discovery", headers: AUTH,
    payload: { action: "complete_session", runner_id: "it-lt8", session_id: SESSION, scanned_hosts: 254 } });
  assert.equal(progress.statusCode, 200);
  assert.equal(completed.statusCode, 200);
  assert.deepEqual(repository.calls, [`progress:it-lt8:${SESSION}:1:1`, `complete:it-lt8:${SESSION}:254`]);
  await server.close();
});

test("Discovery runner contract rejects browser scope fields and malformed sessions before persistence", async () => {
  const repository = new FakeDiscovery();
  const server = buildServer({ logger: false, networkDiscovery: { token: TOKEN, repository } });
  const scope = await server.inject({ method: "POST", url: "/api/runner/network-discovery", headers: AUTH,
    payload: { action: "claim_session", runner_id: "it-lt8", subnet_cidr: "192.168.1.0/24" } });
  const session = await server.inject({ method: "POST", url: "/api/runner/network-discovery", headers: AUTH,
    payload: { action: "complete_session", runner_id: "it-lt8", session_id: "wrong", scanned_hosts: 1 } });
  assert.equal(scope.statusCode, 400);
  assert.equal(session.statusCode, 400);
  assert.deepEqual(repository.calls, []);
  await server.close();
});

test("wrong runner or session cannot mutate an inactive Discovery session", async () => {
  const repository = new FakeDiscovery();
  repository.active = false;
  const server = buildServer({ logger: false, networkDiscovery: { token: TOKEN, repository } });
  const response = await server.inject({ method: "POST", url: "/api/runner/network-discovery", headers: AUTH,
    payload: { action: "context_ready", runner_id: "other-runner", session_id: SESSION, context: CONTEXT } });
  assert.equal(response.statusCode, 409);
  assert.match(response.body, /DISCOVERY_SESSION_NOT_ACTIVE/);
  await server.close();
});
