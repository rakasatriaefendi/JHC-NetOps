import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ASSET_CHANGE_FIELDS,
  assetChangeEventKey,
  diffAssetSnapshots,
  normalizeAssetChangeSnapshot,
  prepareAssetChangeEvent,
} from "../src/assets/change.js";
import { validateAssetChangeQuery, type AssetChangeEvent, type AssetChangeListResponse, type AssetChangeQuery } from "../src/assets/change-contract.js";
import type { AssetChangeRepository } from "../src/assets/change-repository.js";
import { buildServer } from "../src/server.js";

const TOKEN = "a".repeat(32);

const BASE = {
  name: "  Core Switch  ", hostname: "core-switch", ip_address: "192.168.1.8",
  mac_address: "00-11-22-33-44-55", vendor: "RaspberryPiF", platform: "Network OS",
  device_type: "switch_network", status: "online", open_ports: [443, 22, 22],
  detected_services: [
    { protocol: "tcp", port: 443, name: "https", product: "  nginx  " },
    { protocol: "tcp", port: 22, name: "ssh", product: "OpenSSH" },
  ],
  last_seen_at: "2026-09-09T10:00:00Z", evidence_updated_at: "2026-09-09T10:00:00Z",
  latency_ms: 1.2, classification_confidence: "high", os_confidence: "medium",
  raw_nmap_xml: "must never survive",
} as const;

test("normalized asset change snapshot is bounded, allowlisted and deterministic", () => {
  const snapshot = normalizeAssetChangeSnapshot(BASE);
  assert.deepEqual(Object.keys(snapshot), ASSET_CHANGE_FIELDS);
  assert.equal(snapshot.name, "Core Switch");
  assert.equal(snapshot.mac_address, "00:11:22:33:44:55");
  assert.equal(snapshot.vendor, "Raspberry Pi Foundation");
  assert.deepEqual(snapshot.open_ports, [22, 443]);
  assert.deepEqual(snapshot.detected_services.map((item) => item.port), [22, 443]);
  assert.doesNotMatch(JSON.stringify(snapshot), /last_seen|evidence_updated|latency|confidence|raw_nmap/i);

  const oversizedServices = Array.from({ length: 80 }, (_, index) => ({ protocol: "tcp", port: index + 1, name: "x".repeat(100) }));
  const bounded = normalizeAssetChangeSnapshot({ ...BASE, detected_services: oversizedServices, open_ports: Array.from({ length: 80 }, (_, index) => index + 1) });
  assert.equal(bounded.detected_services.length, 32);
  assert.equal(bounded.open_ports.length, 32);
  assert.ok(JSON.stringify(bounded).length < 32_768);
});

test("asset snapshot diff ignores ordering and reports only meaningful changed fields", () => {
  const before = normalizeAssetChangeSnapshot(BASE);
  const reordered = normalizeAssetChangeSnapshot({
    ...BASE,
    open_ports: [22, 443],
    detected_services: [...BASE.detected_services].reverse(),
    last_seen_at: "2026-09-09T11:00:00Z",
    latency_ms: 99,
    classification_confidence: "low",
    os_confidence: "high",
  });
  assert.deepEqual(diffAssetSnapshots(before, reordered), []);

  const cases = [
    ["hostname", { hostname: "edge-switch" }],
    ["vendor", { vendor: "Ruijie" }],
    ["device_type", { device_type: "server" }],
    ["open_ports", { open_ports: [22, 80, 443] }],
    ["detected_services", { detected_services: [{ protocol: "tcp", port: 22, name: "ssh", product: "Dropbear" }] }],
  ] as const;
  for (const [field, change] of cases) {
    assert.deepEqual(diffAssetSnapshots(before, normalizeAssetChangeSnapshot({ ...BASE, ...change })), [field]);
  }
  const multiple = normalizeAssetChangeSnapshot({ ...BASE, hostname: "new-name", vendor: "Ruijie", device_type: "server" });
  assert.deepEqual(diffAssetSnapshots(before, multiple), ["hostname", "vendor", "device_type"]);
});

test("volatile status-only transitions do not produce asset change history", () => {
  const transitions = [
    ["online", "unknown"],
    ["unknown", "online"],
    ["online", "changed"],
  ] as const;

  for (const [beforeStatus, afterStatus] of transitions) {
    const before = normalizeAssetChangeSnapshot({ ...BASE, status: beforeStatus });
    const after = normalizeAssetChangeSnapshot({ ...BASE, status: afterStatus });
    assert.deepEqual(diffAssetSnapshots(before, after), []);
    assert.equal(prepareAssetChangeEvent({
      assetId: "11111111-1111-4111-8111-111111111111",
      stableKey: "node:one",
      source: "observed_host",
      scanRunId: null,
      observedAt: "2026-09-09T10:30:00Z",
      before,
      after,
    }), null);
  }
});

test("status changes do not contaminate meaningful asset change fields", () => {
  const before = normalizeAssetChangeSnapshot(BASE);
  const macAndStatus = normalizeAssetChangeSnapshot({ ...BASE, mac_address: "AA:BB:CC:DD:EE:FF", status: "unknown" });
  assert.deepEqual(diffAssetSnapshots(before, macAndStatus), ["mac_address"]);
  assert.deepEqual(prepareAssetChangeEvent({
    assetId: "11111111-1111-4111-8111-111111111111",
    stableKey: "node:one",
    source: "observed_host",
    scanRunId: null,
    observedAt: "2026-09-09T10:30:00Z",
    before,
    after: macAndStatus,
  })?.changed_fields, ["mac_address"]);

  const multipleAndStatus = normalizeAssetChangeSnapshot({
    ...BASE,
    name: "Distribution Switch",
    platform: "Updated Network OS",
    open_ports: [22, 80, 443],
    status: "changed",
  });
  assert.deepEqual(diffAssetSnapshots(before, multipleAndStatus), ["name", "platform", "open_ports"]);
});

test("event keys are deterministic and change with normalized event facts", () => {
  const after = normalizeAssetChangeSnapshot(BASE);
  const input = { stableKey: "active_scan:mac:00:11:22:33:44:55", eventType: "created" as const, source: "active_scan", scanRunId: "11111111-1111-4111-8111-111111111111", observedAt: "2026-09-09T10:00:00Z", changedFields: [], before: null, after };
  assert.equal(assetChangeEventKey(input), assetChangeEventKey(input));
  assert.notEqual(assetChangeEventKey(input), assetChangeEventKey({ ...input, observedAt: "2026-09-09T10:01:00Z" }));
  assert.match(assetChangeEventKey(input), /^[0-9a-f]{64}$/);
});

test("created and grouped changed events are deterministic while identical retries emit nothing", () => {
  const original = normalizeAssetChangeSnapshot(BASE);
  const created = prepareAssetChangeEvent({ assetId: "11111111-1111-4111-8111-111111111111", stableKey: "node:one", source: "active_scan", scanRunId: "22222222-2222-4222-8222-222222222222", observedAt: "2026-09-09T10:00:00Z", before: null, after: original });
  assert.ok(created);
  assert.equal(created.event_type, "created");
  assert.deepEqual(created.changed_fields, []);
  assert.equal(created.after_state.status, "online");
  assert.equal(created.scan_run_id, "22222222-2222-4222-8222-222222222222");
  assert.equal(prepareAssetChangeEvent({ assetId: created.asset_id, stableKey: created.asset_stable_key, source: created.source, scanRunId: created.scan_run_id, observedAt: created.observed_at, before: original, after: original }), null);

  const changedSnapshot = normalizeAssetChangeSnapshot({ ...BASE, hostname: "new-host", device_type: "server", open_ports: [22, 80, 443] });
  const changed = prepareAssetChangeEvent({ assetId: created.asset_id, stableKey: created.asset_stable_key, source: "manual", scanRunId: null, observedAt: "2026-09-09T11:00:00Z", before: original, after: changedSnapshot });
  assert.ok(changed);
  assert.equal(changed.event_type, "changed");
  assert.deepEqual(changed.changed_fields, ["hostname", "device_type", "open_ports"]);
  assert.equal(changed.scan_run_id, null);
  assert.equal(changed.event_key, prepareAssetChangeEvent({ assetId: created.asset_id, stableKey: created.asset_stable_key, source: "manual", scanRunId: null, observedAt: "2026-09-09T11:00:00Z", before: original, after: changedSnapshot })?.event_key);
});

test("noisy metadata-only updates and absent scan hosts cannot create change events", () => {
  const before = normalizeAssetChangeSnapshot(BASE);
  const after = normalizeAssetChangeSnapshot({ ...BASE, last_seen_at: "2026-09-10T10:00:00Z", evidence_updated_at: "2026-09-10T10:00:00Z", latency_ms: 500, classification_confidence: "low", os_confidence: "high" });
  assert.equal(prepareAssetChangeEvent({ assetId: "11111111-1111-4111-8111-111111111111", stableKey: "node:one", source: "active_scan", scanRunId: "22222222-2222-4222-8222-222222222222", observedAt: "2026-09-10T10:00:00Z", before, after }), null);
  assert.equal(typeof prepareAssetChangeEvent, "function");
});

test("migration 004 is additive, bounded, indexed and performs no historical backfill", () => {
  const migration = readFileSync(new URL("../migrations/004_asset_change_history.sql", import.meta.url), "utf8");
  const wrapper = readFileSync(new URL("../../deploy/postgresql/apply-asset-migration.sql", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS asset\.change_events/);
  assert.match(migration, /event_key char\(64\).*UNIQUE/);
  assert.match(migration, /event_type IN \('created', 'changed'\)/);
  assert.match(migration, /changed_fields <@ ARRAY/);
  assert.match(migration, /octet_length\(after_state::text\) <= 32768/);
  assert.match(migration, /after_state - ARRAY/);
  assert.match(migration, /ON DELETE SET NULL/);
  assert.match(migration, /change_events_recorded_at_idx/);
  assert.match(migration, /change_events_asset_idx/);
  assert.doesNotMatch(migration, /INSERT\s+INTO|UPDATE\s+asset\.assets|DELETE\s+FROM|DROP\s+(?:TABLE|SCHEMA|DATABASE)|TRUNCATE/i);
  assert.match(wrapper, /004_asset_change_history\.sql/);
  assert.match(wrapper, /REVOKE UPDATE, DELETE, TRUNCATE ON asset\.change_events FROM jhc_netops_app/);
  assert.match(wrapper, /GRANT SELECT, INSERT ON asset\.change_events TO jhc_netops_app/);
});

test("repository writes assets and deduplicated events inside one rollback-safe transaction", () => {
  const repository = readFileSync(new URL("../src/assets/repository.ts", import.meta.url), "utf8");
  const scanRepository = readFileSync(new URL("../src/assets/scan-repository.ts", import.meta.url), "utf8");
  assert.match(repository, /client\.query\("BEGIN"\)/);
  assert.match(repository, /pg_advisory_xact_lock/);
  assert.match(repository, /FOR UPDATE/);
  assert.match(repository, /insertAssetChangeEvents\(client, events\)/);
  assert.match(repository, /client\.query\("COMMIT"\)/);
  assert.match(repository, /client\.query\("ROLLBACK"\)/);
  assert.match(repository, /ON CONFLICT \(event_key\) DO NOTHING/);
  assert.match(repository, /source: context\.eventSource \?\? observation\.source/);
  assert.match(scanRepository, /eventSource: "active_scan"/);
  assert.doesNotMatch(repository, /raw_nmap|raw_payload|credential|community|auth_password|priv_password/i);
});

test("asset change query contract allowlists filters and bounds pagination", () => {
  assert.deepEqual(validateAssetChangeQuery({}), { ok: true, value: { search: "", eventType: null, source: null, changedField: null, page: 1, pageSize: 25 } });
  assert.equal(validateAssetChangeQuery({ event_type: "created", source: "active_scan", changed_field: "hostname", page: "2", page_size: "10" }).ok, true);
  for (const value of [
    { extra: "x" }, { q: "x".repeat(101) }, { event_type: "deleted" }, { source: "raw_scan" },
    { changed_field: "latency_ms" }, { page: "0" }, { page_size: "1000" },
  ]) assert.equal(validateAssetChangeQuery(value).ok, false);
});

test("legacy status change events remain readable through the existing contract", async () => {
  assert.equal(ASSET_CHANGE_FIELDS.includes("status"), true);
  assert.equal(validateAssetChangeQuery({ changed_field: "status" }).ok, true);
  const legacyEvent: AssetChangeEvent = {
    ...EVENT,
    event_type: "changed",
    changed_fields: ["status"],
    before_state: normalizeAssetChangeSnapshot({ ...BASE, status: "online" }),
    after_state: normalizeAssetChangeSnapshot({ ...BASE, status: "unknown" }),
  };
  const server = buildServer({ logger: false, assetChanges: { token: TOKEN, repository: new FakeAssetChanges([legacyEvent]) } });
  const response = await server.inject({ method: "GET", url: "/api/assets/events?changed_field=status", headers: auth() });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().data.events[0].changed_fields, ["status"]);
  assert.equal(response.json().data.events[0].before_state.status, "online");
  assert.equal(response.json().data.events[0].after_state.status, "unknown");
  await server.close();
});

test("asset change endpoints require auth, validate filters and return deterministic bounded history", async () => {
  const repository = new FakeAssetChanges();
  const server = buildServer({ logger: false, assetChanges: { token: TOKEN, repository, now: () => new Date("2026-09-09T12:00:00Z") } });
  assert.equal((await server.inject({ method: "GET", url: "/api/assets/events" })).statusCode, 401);
  assert.equal((await server.inject({ method: "GET", url: "/api/assets/events?event_type=deleted", headers: auth() })).statusCode, 400);
  const global = await server.inject({ method: "GET", url: "/api/assets/events?event_type=created&source=active_scan&changed_field=hostname&page=2&page_size=10", headers: auth() });
  assert.equal(global.statusCode, 200);
  assert.equal(global.json().data.events[0].id, EVENT.id);
  assert.equal(global.json().data.server_time, "2026-09-09T12:00:00.000Z");
  assert.deepEqual(repository.queries[0], { search: "", eventType: "created", source: "active_scan", changedField: "hostname", assetId: null, page: 2, pageSize: 10 });
  assert.equal((await server.inject({ method: "GET", url: "/api/assets/not-a-uuid/events", headers: auth() })).statusCode, 400);
  const byAsset = await server.inject({ method: "GET", url: `/api/assets/${EVENT.asset_id}/events`, headers: auth() });
  assert.equal(byAsset.statusCode, 200);
  assert.equal(repository.queries[1]?.assetId, EVENT.asset_id);
  await server.close();
});

test("asset change endpoints return safe empty state and hide repository failures", async () => {
  const empty = new FakeAssetChanges([]);
  const emptyServer = buildServer({ logger: false, assetChanges: { token: TOKEN, repository: empty } });
  const emptyResponse = await emptyServer.inject({ method: "GET", url: "/api/assets/events", headers: auth() });
  assert.deepEqual(emptyResponse.json().data.events, []);
  await emptyServer.close();

  const repository: AssetChangeRepository = { async list() { throw new Error("postgresql://secret raw_nmap credential"); } };
  const failedServer = buildServer({ logger: false, assetChanges: { token: TOKEN, repository } });
  const failed = await failedServer.inject({ method: "GET", url: "/api/assets/events", headers: auth() });
  assert.equal(failed.statusCode, 503);
  assert.deepEqual(failed.json(), { error: { code: "ASSET_CHANGE_QUERY_FAILED", message: "Asset change history is temporarily unavailable" } });
  assert.doesNotMatch(failed.body, /secret|postgres|raw_nmap|credential/i);
  await failedServer.close();
});

const SNAPSHOT = normalizeAssetChangeSnapshot(BASE);
const EVENT: AssetChangeEvent = {
  id: "33333333-3333-4333-8333-333333333333",
  asset_id: "11111111-1111-4111-8111-111111111111",
  scan_run_id: "22222222-2222-4222-8222-222222222222",
  asset_stable_key: "node:one",
  event_type: "created",
  source: "active_scan",
  observed_at: "2026-09-09T10:00:00Z",
  recorded_at: "2026-09-09T10:00:01Z",
  changed_fields: [],
  before_state: null,
  after_state: SNAPSHOT,
};

class FakeAssetChanges implements AssetChangeRepository {
  queries: AssetChangeQuery[] = [];
  constructor(private readonly events: readonly AssetChangeEvent[] = [EVENT]) {}
  async list(query: AssetChangeQuery, signal: AbortSignal): Promise<AssetChangeListResponse> {
    signal.throwIfAborted();
    this.queries.push(query);
    return { events: this.events, pagination: { page: query.page, page_size: query.pageSize, total: this.events.length, pages: 1 } };
  }
}

function auth() { return { authorization: `Bearer ${TOKEN}` }; }
