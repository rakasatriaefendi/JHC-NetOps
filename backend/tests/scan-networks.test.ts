import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { LinuxIpRouteAdapter, parseIpAddressJson, parseIpRouteJson } from "../src/assets/scan-network-adapter.js";
import {
  ASSET_SCAN_MAX_NETWORKS,
  type ConfiguredScanNetwork,
  type CreateScanNetworkInput,
  type ScanNetworkRoute,
  type UpdateScanNetworkInput,
  validateCreateScanNetwork,
  validateScanNetworkTest,
  validateUpdateScanNetwork,
} from "../src/assets/scan-network-contract.js";
import { ScanNetworkManager, ScanNetworkManagerError } from "../src/assets/scan-network-manager.js";
import type { ScanNetworkRepository } from "../src/assets/scan-network-repository.js";
import { ScanNetworkRepositoryError } from "../src/assets/scan-network-repository.js";
import { AssetScanController, AssetScanError } from "../src/assets/scan-controller.js";
import type { NmapExecutionMode, NmapExecutor } from "../src/assets/scan-executor.js";
import type { AssetScanRepository } from "../src/assets/scan-repository.js";
import type { AssetObservation } from "../src/assets/evidence.js";
import type { AssetScanMode, AssetScanRecord } from "../src/assets/scan-contract.js";
import { buildServer } from "../src/server.js";

const TOKEN = "n".repeat(32);
const ID = "11111111-1111-4111-8111-111111111111";
const NETWORK = "192.168.1.0/24";
const NOW = "2026-09-09T00:00:00.000Z";

test("P10D3 CIDR and mutation contracts canonicalize safely and reject unsafe input", () => {
  assert.deepEqual(validateCreateScanNetwork({ name: " Main LAN ", cidr: "192.168.1.17/24" }), {
    ok: true, value: { name: "Main LAN", cidr: NETWORK, origin: "manual" }, canonicalized: true,
  });
  assert.equal(validateCreateScanNetwork({ cidr: "10.20.0.0/22" }).ok, true);
  for (const cidr of ["192.168.0.0/21", "8.8.8.0/24", "0.0.0.0/0", "127.0.0.0/24", "169.254.1.0/24", "not-cidr", "fd00::/64"]) {
    assert.equal(validateCreateScanNetwork({ cidr }).ok, false, cidr);
  }
  assert.equal(validateCreateScanNetwork({ cidr: NETWORK, name: "x".repeat(101) }).ok, false);
  assert.deepEqual(validateUpdateScanNetwork({ enabled: false }), { ok: true, value: { enabled: false } });
  assert.deepEqual(validateUpdateScanNetwork({ name: " VLAN 20 " }), { ok: true, value: { name: "VLAN 20" } });
  assert.equal(validateUpdateScanNetwork({ cidr: "10.0.0.0/24" }).ok, false);
  assert.deepEqual(validateScanNetworkTest({ cidr: "172.16.5.4/24" }), { ok: true, value: { cidr: "172.16.5.0/24" }, canonicalized: true });
});

test("Linux address parser detects only bounded directly connected private IPv4 networks", () => {
  const detected = parseIpAddressJson(JSON.stringify([
    { ifname: "lo", operstate: "UNKNOWN", addr_info: [{ family: "inet", local: "127.0.0.1", prefixlen: 8, scope: "host" }] },
    { ifname: "enp3s0", operstate: "UP", addr_info: [
      { family: "inet", local: "192.168.1.67", prefixlen: 24, scope: "global" },
      { family: "inet6", local: "fd00::1", prefixlen: 64, scope: "global" },
    ] },
    { ifname: "eth1", operstate: "UP", addr_info: [{ family: "inet", local: "10.2.3.4", prefixlen: 16, scope: "global" }] },
    { ifname: "eth2", operstate: "UP", addr_info: [{ family: "inet", local: "203.0.113.8", prefixlen: 24, scope: "global" }] },
    { ifname: "veth0", operstate: "DOWN", addr_info: [{ family: "inet", local: "172.16.4.2", prefixlen: 24, scope: "global" }] },
  ]));
  assert.deepEqual(detected, [{ cidr: NETWORK, interface_name: "enp3s0", source_ip: "192.168.1.67", route_kind: "direct" }]);
  assert.throws(() => parseIpAddressJson("not-json"));
});

test("route parser distinguishes direct, routed, unreachable and malformed results", () => {
  assert.equal(parseIpRouteJson(NETWORK, JSON.stringify([{ dst: "192.168.1.1", dev: "enp3s0", prefsrc: "192.168.1.67" }])).route_kind, "direct");
  const routed = parseIpRouteJson("192.168.20.0/24", JSON.stringify([{ dst: "192.168.20.1", gateway: "192.168.1.1", dev: "enp3s0", prefsrc: "192.168.1.67" }]));
  assert.deepEqual(routed, { cidr: "192.168.20.0/24", route_kind: "routed", interface_name: "enp3s0", source_ip: "192.168.1.67", gateway: "192.168.1.1", reason_code: "ROUTE_AVAILABLE" });
  assert.equal(parseIpRouteJson(NETWORK, JSON.stringify([{ type: "unreachable" }])).route_kind, "unreachable");
  assert.equal(parseIpRouteJson(NETWORK, "[]").route_kind, "unknown");
});

test("Linux adapter uses fixed iproute2 arguments and fails closed without blocking manual configuration", async () => {
  const calls: readonly string[][] = [];
  const recorded: string[][] = calls as string[][];
  const adapter = new LinuxIpRouteAdapter(async (args) => {
    recorded.push([...args]);
    if (args[1] === "addr") return "[]";
    return JSON.stringify([{ dev: "enp3s0", gateway: "192.168.1.1", prefsrc: "192.168.1.67" }]);
  });
  assert.equal((await adapter.detect(AbortSignal.timeout(100))).available, true);
  assert.equal((await adapter.inspect("192.168.20.0/24", AbortSignal.timeout(100))).route_kind, "routed");
  assert.deepEqual(calls, [["-j", "addr", "show"], ["-j", "route", "get", "192.168.20.1"]]);
  const unavailable = new LinuxIpRouteAdapter(async () => { throw new Error("raw secret stderr"); });
  assert.deepEqual(await unavailable.detect(AbortSignal.timeout(100)), { available: false, networks: [], reason_code: "DETECTOR_UNAVAILABLE" });
  assert.equal((await unavailable.inspect(NETWORK, AbortSignal.timeout(100))).route_kind, "unknown");
});

test("manager saves unreachable networks disabled and requires a current route before enabling", async () => {
  const repository = new MemoryNetworks();
  const adapter = new FakeAdapter("unreachable");
  const manager = new ScanNetworkManager(repository, adapter, 1_000);
  await manager.initialize([NETWORK]);
  await manager.initialize(["10.0.0.0/24"]);
  assert.deepEqual(repository.bootstraps, [[NETWORK], ["10.0.0.0/24"]]);
  const saved = await manager.create({ name: "Future VLAN", cidr: "192.168.20.0/24", origin: "manual" });
  assert.equal(saved.network.enabled, false);
  assert.equal(saved.warning, true);
  await assert.rejects(() => manager.update(saved.network.id, { enabled: true }), (error: unknown) => error instanceof ScanNetworkManagerError);
  adapter.kind = "routed";
  assert.equal((await manager.update(saved.network.id, { enabled: true }))?.enabled, true);
  assert.equal(await manager.remove(saved.network.id), true);
  assert.equal((await manager.list()).length, 0);
});

test("repository contract blocks duplicates and configured-network overflow", async () => {
  const repository = new MemoryNetworks();
  await repository.create({ name: null, cidr: NETWORK, origin: "manual" }, true, AbortSignal.timeout(100));
  await assert.rejects(() => repository.create({ name: null, cidr: NETWORK, origin: "manual" }, true, AbortSignal.timeout(100)), (error: unknown) => error instanceof ScanNetworkRepositoryError && error.code === "SCAN_NETWORK_DUPLICATE");
  for (let index = 1; index < ASSET_SCAN_MAX_NETWORKS; index += 1) {
    await repository.create({ name: null, cidr: `10.0.${index}.0/24`, origin: "manual" }, true, AbortSignal.timeout(100));
  }
  await assert.rejects(() => repository.create({ name: null, cidr: "10.0.99.0/24", origin: "manual" }, true, AbortSignal.timeout(100)), (error: unknown) => error instanceof ScanNetworkRepositoryError && error.code === "SCAN_NETWORK_LIMIT_REACHED");
});

test("scan-network APIs authenticate and preserve safe direct/routed configuration behavior", async () => {
  const repository = new MemoryNetworks();
  const manager = new ScanNetworkManager(repository, new FakeAdapter("direct"), 1_000);
  const server = buildServer({ logger: false, scanNetworks: { token: TOKEN, manager } });
  assert.equal((await server.inject({ method: "GET", url: "/api/assets/scan-networks" })).statusCode, 401);
  assert.equal((await server.inject({ method: "POST", url: "/api/assets/scan-networks/test", headers: auth(), payload: { cidr: "8.8.8.0/24" } })).statusCode, 400);
  const created = await server.inject({ method: "POST", url: "/api/assets/scan-networks", headers: auth(), payload: { name: "Main", cidr: "192.168.1.17/24" } });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().data.network.cidr, NETWORK);
  assert.equal(created.json().data.canonicalized, true);
  assert.equal((await server.inject({ method: "POST", url: "/api/assets/scan-networks", headers: auth(), payload: { cidr: NETWORK } })).statusCode, 409);
  assert.equal((await server.inject({ method: "PATCH", url: `/api/assets/scan-networks/${ID}`, headers: auth(), payload: { name: "Renamed" } })).statusCode, 200);
  assert.equal((await server.inject({ method: "DELETE", url: "/api/assets/scan-networks/not-a-uuid", headers: auth() })).statusCode, 400);
  assert.equal((await server.inject({ method: "DELETE", url: `/api/assets/scan-networks/${ID}`, headers: auth() })).statusCode, 204);
  await server.close();
});

test("controller rejects arbitrary/disabled networks and selects the routed fixed helper strategy", async () => {
  const calls: NmapExecutionMode[] = [];
  const executor: NmapExecutor = {
    async available() { return true; },
    async run(mode) { calls.push(mode); return "<?xml version=\"1.0\"?><nmaprun></nmaprun>"; },
  };
  const repository = new FakeScanRuns();
  const source = { async enabled() { return [{ ...row(NETWORK, true), route_kind: "routed" as const, interface_name: "eth0", source_ip: "192.168.1.67", gateway: "192.168.1.1", reason_code: "ROUTE_AVAILABLE" as const }]; } };
  const controller = new AssetScanController(repository, executor, source, 1, 1_000, 1_000, () => new Date(NOW));
  await assert.rejects(() => controller.start("quick", "10.0.0.0/24"), (error: unknown) => error instanceof AssetScanError && error.code === "SCAN_NETWORK_NOT_ALLOWED");
  await controller.start("quick", NETWORK);
  await controller.shutdown();
  assert.equal(calls[0], "discovery-routed");
});

test("migration 005 is additive, private, bounded, soft-delete capable and wired into reviewed deployment", () => {
  const migration = readFileSync(new URL("../migrations/005_scan_network_settings.sql", import.meta.url), "utf8");
  const repository = readFileSync(new URL("../src/assets/scan-network-repository.ts", import.meta.url), "utf8");
  const wrapper = readFileSync(new URL("../../deploy/postgresql/apply-asset-migration.sql", import.meta.url), "utf8");
  assert.match(migration, /asset\.scan_networks/);
  assert.match(migration, /asset\.scan_network_bootstrap/);
  assert.match(migration, /masklen\(network\) BETWEEN 22 AND 32/);
  assert.match(migration, /deleted_at/);
  assert.match(migration, /origin IN \('manual', 'detected', 'bootstrap'\)/);
  assert.doesNotMatch(migration, /DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE|REFERENCES\s+(?:public|auth)\./i);
  assert.match(wrapper, /005_scan_network_settings\.sql/);
  assert.match(wrapper, /GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA asset TO jhc_netops_app/);
  assert.match(repository, /SELECT singleton FROM asset\.scan_network_bootstrap/);
  assert.match(repository, /if \(!initialized\.rowCount\)/);
  assert.match(repository, /INSERT INTO asset\.scan_network_bootstrap/);
  assert.match(repository, /WHERE deleted_at IS NULL/);
  assert.match(repository, /deleted_at = NULL/);
});

class FakeAdapter {
  constructor(public kind: ScanNetworkRoute["route_kind"]) {}
  async detect() { return { available: true as const, networks: [], reason_code: null }; }
  async inspect(cidr: string): Promise<ScanNetworkRoute> {
    return { cidr, route_kind: this.kind, interface_name: this.kind === "unknown" || this.kind === "unreachable" ? null : "eth0", source_ip: "192.168.1.67", gateway: this.kind === "routed" ? "192.168.1.1" : null, reason_code: this.kind === "direct" || this.kind === "routed" ? "ROUTE_AVAILABLE" : this.kind === "unreachable" ? "ROUTE_UNAVAILABLE" : "ROUTE_UNKNOWN" };
  }
}

class MemoryNetworks implements ScanNetworkRepository {
  rows: ConfiguredScanNetwork[] = [];
  bootstraps: string[][] = [];
  async bootstrap(networks: readonly string[], signal: AbortSignal) { signal.throwIfAborted(); this.bootstraps.push([...networks]); }
  async list(signal: AbortSignal) { signal.throwIfAborted(); return [...this.rows]; }
  async create(input: CreateScanNetworkInput, enabled: boolean, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.rows.length >= ASSET_SCAN_MAX_NETWORKS) throw new ScanNetworkRepositoryError("SCAN_NETWORK_LIMIT_REACHED");
    if (this.rows.some((item) => item.cidr === input.cidr)) throw new ScanNetworkRepositoryError("SCAN_NETWORK_DUPLICATE");
    const value = row(input.cidr, enabled, input.name, input.origin, this.rows.length === 0 ? ID : crypto.randomUUID());
    this.rows.push(value); return value;
  }
  async update(id: string, input: UpdateScanNetworkInput, signal: AbortSignal) {
    signal.throwIfAborted();
    const index = this.rows.findIndex((item) => item.id === id);
    if (index < 0) return null;
    const previous = this.rows[index]!;
    const value = { ...previous, ...(input.name !== undefined ? { name: input.name } : {}), ...(input.enabled !== undefined ? { enabled: input.enabled } : {}) };
    this.rows[index] = value; return value;
  }
  async remove(id: string, signal: AbortSignal) { signal.throwIfAborted(); const before = this.rows.length; this.rows = this.rows.filter((item) => item.id !== id); return this.rows.length !== before; }
}

class FakeScanRuns implements AssetScanRepository {
  record: AssetScanRecord | null = null;
  async recoverInterrupted() {}
  async create(mode: AssetScanMode, network: string, startedAt: string) { this.record = { id: ID, mode, network, status: "running", discovered_count: 0, fingerprinted_count: 0, failed_count: 0, current_target: null, started_at: startedAt, completed_at: null, cancelled_at: null, error_code: null }; return this.record; }
  async update(record: AssetScanRecord) { this.record = record; }
  async last() { return this.record?.status === "running" ? null : this.record; }
  async ingest(observations: readonly AssetObservation[], _scanRunId: string, signal: AbortSignal) { signal.throwIfAborted(); return observations.length; }
}

function row(cidr: string, enabled: boolean, name: string | null = null, origin: ConfiguredScanNetwork["origin"] = "manual", id = ID): ConfiguredScanNetwork {
  return { id, name, cidr, enabled, origin, created_at: NOW, updated_at: NOW };
}
function auth() { return { authorization: `Bearer ${TOKEN}` }; }
