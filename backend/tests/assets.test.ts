import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { AssetListQuery, AssetListResponse, AssetRecord } from "../src/assets/contract.js";
import { validateAssetListQuery } from "../src/assets/contract.js";
import { diffAssetSnapshots, normalizeAssetChangeSnapshot } from "../src/assets/change.js";
import { buildAssetObservations, classifyAsset, PostgresAssetEvidenceSource, type AssetEvidenceSnapshot, type AssetObservation } from "../src/assets/evidence.js";
import { mergeAssetEvidence } from "../src/assets/evidence-merge.js";
import { BoundedAssetSynchronizer } from "../src/assets/ingestion.js";
import type { AssetRepository } from "../src/assets/repository.js";
import { buildServer } from "../src/server.js";

const TOKEN = "a".repeat(32);
const ITEM: AssetRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Core Switch",
  hostname: "core-switch",
  device_type: "network_device",
  status: "online",
  ip_address: "192.168.1.8",
  mac_address: null,
  vendor: "Ruijie",
  platform: null,
  first_seen_at: null,
  last_seen_at: "2026-09-08T00:00:00.000Z",
  source: "managed_telemetry",
  classification_confidence: "high",
  os_confidence: "high",
  classification_evidence: [{ source: "managed_telemetry", label: "System name", value: "core-switch" }],
  open_ports: [22, 443],
  detected_services: [{ protocol: "tcp", port: 22, name: "ssh" }],
  latency_ms: 1.25,
  evidence_updated_at: "2026-09-08T00:00:00.000Z",
  network_node_ref: "22222222-2222-4222-8222-222222222222",
  health_target_ref: null,
  managed_telemetry_target_ref: "33333333-3333-4333-8333-333333333333",
  observed_host_target_ref: null,
};

class FakeAssets implements AssetRepository {
  listQueries: AssetListQuery[] = [];
  ingestCalls: AssetObservation[][] = [];
  async list(query: AssetListQuery): Promise<AssetListResponse> {
    this.listQueries.push(query);
    return { items: [ITEM], summary: { total: 1, online: 1, offline: 0, changed: 0 }, device_types: ["network_device"], insights: { platforms: [], vendors: [{ value: "Ruijie", count: 1 }], vendor_device_types: [{ vendor: "Ruijie", device_type: "network_device", count: 1 }] }, pagination: { page: 1, page_size: 10, total: 1, pages: 1 } };
  }
  async detail(id: string): Promise<AssetRecord | null> { return id === ITEM.id ? ITEM : null; }
  async ingest(observations: readonly AssetObservation[], signal: AbortSignal): Promise<number> {
    signal.throwIfAborted();
    this.ingestCalls.push([...observations]);
    return observations.length;
  }
}

test("asset query contract is allowlisted and bounded", () => {
  assert.deepEqual(validateAssetListQuery({}), {
    ok: true,
    value: { search: "", deviceType: null, vendor: null, platform: null, status: null, sort: "name_asc", page: 1, pageSize: 10 },
  });
  for (const query of [
    { extra: "field" }, { q: "x".repeat(101) }, { status: "deleted" },
    { sort: "last_seen" }, { page_size: "1000" }, { device_type: "bad type" },
  ]) assert.equal(validateAssetListQuery(query).ok, false);
});

test("asset routes require the frontend server token and return bounded list/detail contracts", async () => {
  const repository = new FakeAssets();
  const server = buildServer({ logger: false, assets: { token: TOKEN, repository, now: () => new Date("2026-09-08T09:10:11.000Z") } });
  assert.equal((await server.inject({ method: "GET", url: "/api/assets" })).statusCode, 401);
  const list = await server.inject({ method: "GET", url: "/api/assets?q=core&status=online&sort=name_desc&page=1&page_size=10", headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().data.items[0].name, "Core Switch");
  assert.equal(list.json().data.server_time, "2026-09-08T09:10:11.000Z");
  assert.equal(repository.listQueries[0]?.sort, "name_desc");
  const detail = await server.inject({ method: "GET", url: `/api/assets/${ITEM.id}`, headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(detail.statusCode, 200);
  assert.deepEqual(detail.json().data.open_ports, [22, 443]);
  assert.equal((await server.inject({ method: "GET", url: "/api/assets/not-a-uuid", headers: { authorization: `Bearer ${TOKEN}` } })).statusCode, 400);
  await server.close();
});

test("asset route failures are normalized without database or secret details", async () => {
  const repository: AssetRepository = {
    async list() { throw new Error("postgresql://user:secret@127.0.0.1/private"); },
    async detail() { throw new Error("secret table detail"); },
    async ingest() { throw new Error("secret ingestion detail"); },
  };
  const server = buildServer({ logger: false, assets: { token: TOKEN, repository } });
  const response = await server.inject({ method: "GET", url: "/api/assets", headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), { error: { code: "ASSET_QUERY_FAILED", message: "Asset inventory is temporarily unavailable" } });
  assert.doesNotMatch(response.body, /secret|postgres|table/i);
  await server.close();
});

test("evidence refresh failure serves retained inventory without leaking source details", async () => {
  const repository = new FakeAssets();
  const server = buildServer({
    logger: false,
    assets: {
      token: TOKEN,
      repository,
      synchronizer: { async synchronize() { throw new Error("Supabase secret payload"); } },
    },
  });
  const response = await server.inject({ method: "GET", url: "/api/assets", headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.items[0].id, ITEM.id);
  assert.doesNotMatch(response.body, /secret|supabase/i);
  await server.close();
});

test("asset migration is non-destructive and contains the intended local schema and indexes", () => {
  const sql = readFileSync(new URL("../migrations/001_asset_inventory_foundation.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE SCHEMA IF NOT EXISTS asset/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS asset\.assets/);
  assert.match(sql, /timestamptz/);
  assert.match(sql, /jsonb/);
  assert.match(sql, /octet_length\(classification_evidence::text\) <= 32768/);
  assert.match(sql, /network_node_ref uuid/);
  assert.doesNotMatch(sql, /DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE|REFERENCES\s+(?:public|auth)\./i);
});

test("P10D migration adds bounded evidence fields and an idempotent stable key", () => {
  const sql = readFileSync(new URL("../migrations/002_asset_intelligence.sql", import.meta.url), "utf8");
  const repository = readFileSync(new URL("../src/assets/repository.ts", import.meta.url), "utf8");
  assert.match(sql, /stable_source_key varchar\(300\)/);
  assert.match(sql, /UNIQUE \(stable_source_key\)/);
  assert.match(sql, /jsonb_array_length\(open_ports\) <= 32/);
  assert.match(sql, /jsonb_array_length\(detected_services\) <= 32/);
  assert.match(repository, /jsonb_to_recordset\(\$1::jsonb\)/);
  assert.match(repository, /ON CONFLICT \(stable_source_key\) DO UPDATE/);
  assert.match(repository, /lower\(btrim\(asset\.assets\.vendor\)\) ~ '\^0x/);
  assert.doesNotMatch(repository, /for \(const observation of observations\)/);
  assert.doesNotMatch(sql, /DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE|REFERENCES\s+(?:public|auth)\./i);
});

test("existing evidence becomes one conservative idempotent asset without raw payloads", () => {
  const nodeId = "22222222-2222-4222-8222-222222222222";
  const targetId = "33333333-3333-4333-8333-333333333333";
  const snapshot: AssetEvidenceSnapshot = {
    nodes: [{ id: nodeId, ip_address: "192.168.1.8", name: "Core Ruijie", device_type: "layer3_switch", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-08T00:00:00Z", last_inspected_at: "2026-09-07T00:00:00Z", detected_fingerprint: { confidence: "high", likely_device_type: "network_device", network_identity: { mac: "02:11:22:33:44:55", mac_kind: "locally_administered", mac_vendor: "Untrusted Vendor" }, detected_identity: { likely_label: "ruijie-core", manufacturer: "Ruijie", os_family: "Network OS" }, observed_services: [{ protocol: "tcp", port: 443, name: "https" }], evidence: [{ source: "tls", label: "Subject", value: "bounded identity" }] } }],
    healthTargets: [{ id: "44444444-4444-4444-8444-444444444444", node_id: nodeId, network_health_latest: { status: "online", latency_ms: 1.2, last_checked_at: "2026-09-08T00:00:00Z", last_success_at: "2026-09-08T00:00:00Z" } }],
    managedTargets: [{ id: targetId, node_id: nodeId, managed_device_latest: { status: "connected", sys_name: "ruijie-core", sys_descr: "Ruijie Network OS", manufacturer: "Ruijie", last_polled_at: "2026-09-08T00:00:00Z", last_success_at: "2026-09-08T00:00:00Z" } }],
    observedHosts: [{ target_id: targetId, node_id: nodeId, ip_address: "192.168.1.8", mac_address: "02:11:22:33:44:55", netbios_name: null, observation_source: "ip_net_to_physical", first_seen_at: "2026-09-01T00:00:00Z", last_seen_at: "2026-09-08T00:00:00Z", status: "current", updated_at: "2026-09-08T00:00:00Z" }],
  };
  const first = buildAssetObservations(snapshot);
  const second = buildAssetObservations(snapshot);
  assert.deepEqual(first, second);
  assert.equal(first.length, 1);
  assert.equal(first[0]?.stable_source_key, `node:${nodeId}`);
  assert.equal(first[0]?.device_type, "switch_network");
  assert.equal(first[0]?.classification_confidence, "high");
  assert.equal(first[0]?.os_confidence, "medium");
  assert.equal(first[0]?.vendor, "Ruijie");
  assert.deepEqual(first[0]?.open_ports, [443]);
  assert.doesNotMatch(JSON.stringify(first), /credential|community|raw_payload/i);
});

test("observed-host refresh preserves richer name, classification and Deep service evidence", () => {
  const deep = assetObservation({
    name: "staging-jhc",
    hostname: "staging-jhc",
    device_type: "switch_network",
    source: "active_scan",
    classification_confidence: "high",
    open_ports: [22, 80, 443],
    detected_services: [
      { protocol: "tcp", port: 22, name: "ssh" },
      { protocol: "tcp", port: 80, name: "http" },
      { protocol: "tcp", port: 443, name: "https" },
    ],
  });
  const observedHost = assetObservation({
    name: "192.168.1.130",
    hostname: null,
    device_type: "unknown",
    source: "observed_host",
    classification_confidence: "low",
    open_ports: [],
    detected_services: [],
    last_seen_at: "2026-09-10T01:00:00.000Z",
    evidence_updated_at: "2026-09-10T01:00:00.000Z",
    field_evidence: { name: "fallback", device_type: "unobserved", services: "unobserved" },
  });

  const merged = mergeAssetEvidence(deep, observedHost);
  assert.equal(merged.name, "staging-jhc");
  assert.equal(merged.device_type, "switch_network");
  assert.deepEqual(merged.open_ports, [22, 80, 443]);
  assert.deepEqual(merged.detected_services, deep.detected_services);
  assert.deepEqual(diffAssetSnapshots(normalizeAssetChangeSnapshot(deep), normalizeAssetChangeSnapshot(merged)), []);
});

test("repeated lower-information refresh is stable and creates no asset history churn", () => {
  const deep = assetObservation({ name: "lab-switch", hostname: "lab-switch", device_type: "switch_network", source: "active_scan",
    classification_confidence: "high", open_ports: [22, 443], detected_services: [{ protocol: "tcp", port: 22, name: "ssh" }, { protocol: "tcp", port: 443, name: "https" }] });
  const observedHost = assetObservation({ name: "192.168.1.130", source: "observed_host", last_seen_at: "2026-09-10T01:00:00.000Z",
    evidence_updated_at: "2026-09-10T01:00:00.000Z", field_evidence: { name: "fallback", device_type: "unobserved", services: "unobserved" } });
  const once = mergeAssetEvidence(deep, observedHost);
  const twice = mergeAssetEvidence(once, observedHost);
  assert.deepEqual(normalizeAssetChangeSnapshot(once), normalizeAssetChangeSnapshot(twice));
  assert.deepEqual(diffAssetSnapshots(normalizeAssetChangeSnapshot(once), normalizeAssetChangeSnapshot(twice)), []);
});

test("Device Inspector is additive while explicit manual identity remains authoritative", () => {
  const existing = assetObservation({ name: "Operator Switch", device_type: "switch_network", source: "manual",
    network_node_ref: "22222222-2222-4222-8222-222222222222", classification_confidence: "high",
    open_ports: [22, 443], detected_services: [{ protocol: "tcp", port: 22, name: "ssh" }, { protocol: "tcp", port: 443, name: "https" }] });
  const inspector = assetObservation({ name: "192.168.1.130", device_type: "unknown", source: "device_inspector",
    open_ports: [80], detected_services: [{ protocol: "tcp", port: 80, name: "http" }],
    field_evidence: { name: "fallback", device_type: "unobserved", services: "partial" } });
  const inspected = mergeAssetEvidence(existing, inspector);
  assert.equal(inspected.name, "Operator Switch");
  assert.equal(inspected.device_type, "switch_network");
  assert.deepEqual(inspected.open_ports, [22, 80, 443]);

  const manualClear = assetObservation({ ...inspected, source: "manual", device_type: "unknown",
    field_evidence: { name: "authoritative", device_type: "authoritative", services: "unobserved" } });
  assert.equal(mergeAssetEvidence(inspected, manualClear).device_type, "unknown");
});

test("classification does not call a print-port-only host a printer and private MAC lowers inferred confidence", () => {
  const input = { nodeType: null, fingerprintType: null, vendor: null, hostname: "host", platform: null, services: [{ protocol: "tcp" as const, port: 9100, name: "unknown" }], macKind: "locally_administered" as const, sourceConfidence: "high" as const };
  assert.equal(classifyAsset(input).deviceType, "unknown");
  assert.equal(classifyAsset(input).confidence, "low");
  const printer = classifyAsset({ ...input, vendor: "Epson", macKind: "global" });
  assert.equal(printer.deviceType, "printer");
});

test("bounded synchronizer coalesces concurrent evidence loads and throttles repeats", async () => {
  let loads = 0;
  const repository = new FakeAssets();
  const source = { async load(): Promise<AssetEvidenceSnapshot> { loads += 1; await Promise.resolve(); return { nodes: [], healthTargets: [], managedTargets: [], observedHosts: [{ target_id: "33333333-3333-4333-8333-333333333333", node_id: null, ip_address: "192.168.1.10", status: "current" }] }; } };
  let now = 100_000;
  const synchronizer = new BoundedAssetSynchronizer(source, repository, 1_000, 30_000, () => now);
  await Promise.all([synchronizer.synchronize(), synchronizer.synchronize()]);
  await synchronizer.synchronize();
  assert.equal(loads, 1);
  assert.equal(repository.ingestCalls.length, 1);
  assert.equal(repository.ingestCalls[0]?.length, 1);
  now += 30_001;
  await synchronizer.synchronize();
  assert.equal(loads, 2);
  assert.equal(repository.ingestCalls.length, 2);
});

test("local asset evidence source reuses bounded authoritative PostgreSQL inventory without Supabase REST", async () => {
  const nodeId = "22222222-2222-4222-8222-222222222222";
  const healthId = "33333333-3333-4333-8333-333333333333";
  const managedId = "44444444-4444-4444-8444-444444444444";
  const repository = {
    async listNodes() { return [{ id: nodeId, ip_address: "192.168.1.8", name: "Core" }]; },
    async listHealthTargets() {
      return [{ id: healthId, node_id: nodeId, latest: { status: "online", latency_ms: 1 } }];
    },
    async listManagedTargets() {
      return [{ id: managedId, node_id: nodeId, latest: { status: "connected", sys_name: "core" } }];
    },
    async listManagedObservedHosts(targetId: string | undefined) {
      assert.equal(targetId, undefined);
      return [{ target_id: managedId, node_id: nodeId, ip_address: "192.168.1.8", status: "current" }];
    },
  };
  const snapshot = await new PostgresAssetEvidenceSource(repository).load(new AbortController().signal);
  assert.equal(snapshot.nodes.length, 1);
  assert.deepEqual(snapshot.healthTargets[0]?.network_health_latest, { status: "online", latency_ms: 1 });
  assert.deepEqual(snapshot.managedTargets[0]?.managed_device_latest, { status: "connected", sys_name: "core" });
  assert.equal(snapshot.observedHosts.length, 1);
});

test("asset evidence remains bounded and cannot start a network operation", () => {
  const evidenceSource = readFileSync(new URL("../src/assets/evidence.ts", import.meta.url), "utf8");
  assert.match(evidenceSource, /ASSET_EVIDENCE_ROW_LIMIT = 1_000/);
  assert.match(evidenceSource, /ASSET_EVIDENCE_LIMIT = 32/);
  assert.match(evidenceSource, /ASSET_SERVICE_LIMIT = 32/);
  assert.doesNotMatch(evidenceSource, /child_process|spawn\(|exec\(|nmap|snmpget|snmpwalk|ping\.exe|device-inspect/);

  const target = "33333333-3333-4333-8333-333333333333";
  const observations = buildAssetObservations({
    nodes: [], healthTargets: [], managedTargets: [],
    observedHosts: Array.from({ length: 1_050 }, (_, index) => ({
      target_id: target,
      node_id: null,
      ip_address: `10.${Math.floor(index / 65_536)}.${Math.floor(index / 256) % 256}.${index % 256}`,
      mac_address: null,
      netbios_name: null,
      observation_source: "ip_net_to_physical",
      first_seen_at: "2026-09-01T00:00:00Z",
      last_seen_at: "2026-09-08T00:00:00Z",
      status: "current",
      updated_at: "2026-09-08T00:00:00Z",
    })),
  });
  assert.equal(observations.length, 1_000);
  assert.ok(observations.every((item) => item.classification_evidence.length <= 32 && item.open_ports.length <= 32));
});

test("asset persistence merges field evidence before bulk upsert while active scans remain premerged", () => {
  const repository = readFileSync(new URL("../src/assets/repository.ts", import.meta.url), "utf8");
  const scanRepository = readFileSync(new URL("../src/assets/scan-repository.ts", import.meta.url), "utf8");
  assert.match(repository, /mergeAssetEvidence\(existingObservation\(before\), observation\)/);
  assert.match(repository, /JSON\.stringify\(effectiveObservations\)/);
  assert.match(scanRepository, /observationsPremerged: true/);
});

test("PostgreSQL provisioning handles an existing dedicated cluster without touching 16/main", () => {
  const cluster = readFileSync(new URL("../../deploy/postgresql/provision-jhcnetops-cluster.sh", import.meta.url), "utf8");
  const application = readFileSync(new URL("../../deploy/postgresql/provision-jhcnetops-application.sh", import.meta.url), "utf8");
  const grants = readFileSync(new URL("../../deploy/postgresql/apply-asset-migration.sql", import.meta.url), "utf8");
  const rollback = readFileSync(new URL("../../deploy/postgresql/rollback-p10c-before-use.sql", import.meta.url), "utf8");
  assert.match(cluster, /existing dedicated cluster[\s\S]*no cluster\/config change made/);
  assert.match(application, /--cluster "\$\{PG_VERSION\}\/\$\{CLUSTER\}"/);
  assert.match(application, /listen only on 127\.0\.0\.1/);
  assert.match(application, /NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION/);
  assert.match(application, /OWNER_ROLE="jhc_netops_owner"/);
  assert.match(application, /APP_ROLE="jhc_netops_app"/);
  assert.match(grants, /GRANT USAGE ON SCHEMA asset TO jhc_netops_app/);
  assert.match(grants, /002_asset_intelligence\.sql/);
  assert.match(rollback, /current_database\(\) <> 'jhc_netops'/);
  assert.match(rollback, /IF EXISTS \(SELECT 1 FROM asset\.assets\)/);
  assert.doesNotMatch(cluster + application + grants + rollback, /pg_ctlcluster\s+(?:"?16"?\s+"?main"?|16\/main)|--cluster\s+16\/main/);
});

function assetObservation(overrides: Partial<AssetObservation> = {}): AssetObservation {
  return {
    stable_source_key: "observed:33333333-3333-4333-8333-333333333333:192.168.1.130",
    name: "192.168.1.130",
    hostname: null,
    device_type: "unknown",
    status: "online",
    ip_address: "192.168.1.130",
    mac_address: "00:11:22:33:44:55",
    vendor: null,
    platform: null,
    first_seen_at: "2026-09-01T00:00:00.000Z",
    last_seen_at: "2026-09-09T00:00:00.000Z",
    source: "observed_host",
    classification_confidence: "low",
    os_confidence: null,
    classification_evidence: [],
    open_ports: [],
    detected_services: [],
    latency_ms: null,
    evidence_updated_at: "2026-09-09T00:00:00.000Z",
    network_node_ref: null,
    health_target_ref: null,
    managed_telemetry_target_ref: null,
    observed_host_target_ref: "33333333-3333-4333-8333-333333333333",
    ...overrides,
  };
}
