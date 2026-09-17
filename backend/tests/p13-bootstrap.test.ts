import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assertP13ImportMode,
  bootstrapP13S1,
  classifyP13TargetState,
  migrationBody,
  parseP13S1Bundle,
  P13_ADMIN_TARGET_IDENTITY_SQL,
  P13_APPLICATION_TABLES,
  P13_ASSET_SCHEMA_IDENTITY_SQL,
  P13_MIGRATION_TABLE,
  P13_MIGRATION_VERSIONS_SQL,
  P13_OUTBOX_STATE_SQL,
  P13_OUTBOX_TABLES,
  P13_SHADOW_TRIGGERS,
  P13_SHADOW_TRIGGER_SQL,
  P13_TARGET_INVENTORY_SQL,
  type P13BootstrapQuery,
  type P13TargetInventory,
} from "../src/cutover/bootstrap.js";
import type { P13CutoverRecord } from "../src/cutover/cutover.js";
import { canonicalJson, sha256 } from "../src/data-migration/canonical.js";
import { P12_TABLES } from "../src/data-migration/contract.js";

const CHECKPOINT = "70cd9dd18bd2f48e29573cef77bb9bf05e8b1d1e58d5b76aec1122a295d108d9";
const MIGRATION_007 = readFileSync(new URL("../migrations/007_application_persistence.sql", import.meta.url), "utf8");
const MIGRATION_008 = readFileSync(new URL("../migrations/008_application_persistence_outbox.sql", import.meta.url), "utf8");
const EXACT_APPLICATION_TABLES = Object.freeze([
  "profiles", "traffic_metrics", "flows", "events", "bandwidth_measurements", "hop_measurements",
  "diagnostic_runners", "diagnostic_jobs", "traffic_live_sessions", "traffic_live_snapshots",
  "network_nodes", "network_targets", "network_health_latest", "network_health_samples",
  "network_health_ping_jobs", "network_discovery_sessions", "device_inspection_sessions",
  "managed_telemetry_targets", "managed_device_latest", "managed_interface_latest",
  "managed_observed_hosts_latest",
] as const);
const PROFILE = Object.freeze({
  id: "10000000-0000-4000-8000-000000000001",
  email: "operator@example.invalid",
  full_name: "Operator",
  role: "admin",
  status: "approved",
  created_at: "2026-09-17T00:00:00.000Z",
  approved_at: "2026-09-17T00:00:00.000Z",
  approved_by: null,
});

test("P13 uses the exact reviewed 21-table allowlist", () => {
  assert.deepEqual(P13_APPLICATION_TABLES, EXACT_APPLICATION_TABLES);
  assert.deepEqual(new Set(P13_APPLICATION_TABLES), new Set(P12_TABLES.map(({ table }) => table)));
});

test("S1 parity uses the reviewed non-generic and composite canonical keys", () => {
  const keys = Object.fromEntries(P12_TABLES.map(({ table, orderingKey }) => [table, orderingKey]));
  assert.deepEqual(keys.network_discovery_sessions, ["runner_id"]);
  assert.deepEqual(keys.device_inspection_sessions, ["runner_id"]);
  assert.deepEqual(keys.traffic_live_snapshots, ["runner_id"]);
  assert.deepEqual(keys.managed_interface_latest, ["target_id", "if_index"]);
  assert.deepEqual(keys.managed_observed_hosts_latest, ["target_id", "ip_address"]);
});

test("empty target bootstrap is atomic, ordered 007/full S1/sequence/008, and leaves asset unchanged", async () => {
  const fixture = s1Fixture();
  const fake = fakeBootstrapDatabase(fixture);
  const evidence = await bootstrapP13S1(bootstrapOptions(fixture, fake.query));

  assert.equal(evidence.mode, "bootstrap");
  assert.equal(evidence.target_state_before, "empty_application_target");
  assert.equal(evidence.target.execution_role, "jhc_netops_owner");
  assert.equal(evidence.s1_parity, "PASS");
  assert.equal(evidence.tables.length, 21);
  assert.equal(evidence.tables.find(({ table }) => table === "profiles")?.row_count, 1);
  assert.deepEqual(evidence.migration_versions, [7, 8]);
  assert.deepEqual(evidence.outbox, {
    total_count: 0,
    pending_count: 0,
    failed_count: 0,
    watermark_count: 0,
    canary_count: 0,
    shadow_trigger_count: 16,
  });
  assert.equal(evidence.asset.before_sha256, evidence.asset.after_sha256);
  assert.equal(evidence.asset.unchanged, true);

  const migration007 = fake.calls.findIndex((sql) => sql.includes("VALUES (7);"));
  const fullS1Insert = fake.calls.findIndex((sql) => sql.includes('INSERT INTO public."profiles"'));
  const sequenceReset = fake.calls.findIndex((sql) => sql.includes("pg_get_serial_sequence('public.network_health_samples'"));
  const migration008 = fake.calls.findIndex((sql) => sql.includes("VALUES (8);"));
  const finalParity = fake.calls.findIndex((sql) => sql.includes('count(*)::text AS row_count FROM public."profiles"'));
  assert.ok(migration007 >= 0 && migration007 < fullS1Insert);
  assert.ok(fullS1Insert < sequenceReset && sequenceReset < migration008 && migration008 < finalParity);
  assert.equal(fake.calls.filter((sql) => /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\s+asset\./i.test(sql)).length, 0);
  assert.equal(fake.calls[0], "BEGIN");
  assert.equal(fake.calls.at(-1), "COMMIT");
});

test("target state and explicit mode selection reject partial, populated, and mismatched targets", () => {
  const empty = inventory([], []);
  const baseline = inventory([...P13_APPLICATION_TABLES, P13_MIGRATION_TABLE], [7], true);
  const populated = inventory([...P13_APPLICATION_TABLES, P13_MIGRATION_TABLE, ...P13_OUTBOX_TABLES], [7, 8]);
  const partial = inventory([P13_APPLICATION_TABLES[0]], []);
  const unrelated = inventory(["unreviewed_public_table"], []);

  assert.equal(classifyP13TargetState(empty), "empty_application_target");
  assert.equal(assertP13ImportMode("bootstrap", empty), "empty_application_target");
  assert.equal(assertP13ImportMode("delta", baseline), "accepted_s0_baseline");
  for (const rejected of [baseline, populated, partial, unrelated]) {
    assert.throws(() => assertP13ImportMode("bootstrap", rejected), /empty application target/);
  }
  for (const rejected of [empty, populated, partial, unrelated]) {
    assert.throws(() => assertP13ImportMode("delta", rejected), /accepted S0 baseline/);
  }
});

test("wrong checkpoint, source identity, and immutable S1 manifest hash fail before database access", async () => {
  const fixture = s1Fixture();
  const noQuery: P13BootstrapQuery = async () => { throw new Error("database access must not occur"); };
  await assert.rejects(() => bootstrapP13S1({
    ...bootstrapOptions(fixture, noQuery),
    record: { ...fixture.record, checkpoint: "CHECKPOINT_0_PRE_FREEZE" },
  }), /checkpoint or immutable S1 manifest identity/);
  await assert.rejects(() => bootstrapP13S1({
    ...bootstrapOptions(fixture, noQuery),
    source_checkpoint_identity: "e".repeat(64),
  }), /checkpoint or immutable S1 manifest identity/);
  await assert.rejects(() => bootstrapP13S1({
    ...bootstrapOptions(fixture, noQuery),
    expected_s1_manifest_sha256: "f".repeat(64),
  }), /checkpoint or immutable S1 manifest identity/);

  const wrongSource = withManifest(fixture, { ...fixture.manifest, source_checkpoint_identity: "d".repeat(64) });
  await assert.rejects(() => bootstrapP13S1(bootstrapOptions(wrongSource, noQuery)), /source checkpoint identity/);
});

test("S1 manifest rejects missing, duplicate, extra, traversal, and extra physical table artifacts", () => {
  const fixture = s1Fixture();
  const first = fixture.manifest.tables[0]!;
  const cases = [
    { ...fixture.manifest, tables: fixture.manifest.tables.slice(1), table_count: 20 },
    { ...fixture.manifest, tables: [...fixture.manifest.tables.slice(0, -1), first] },
    { ...fixture.manifest, tables: [...fixture.manifest.tables, { ...first, table: "unexpected", file: "tables/unexpected.json" }], table_count: 22 },
    { ...fixture.manifest, tables: fixture.manifest.tables.map((entry) => entry.table === first.table ? { ...entry, file: "../profiles.json" } : entry) },
  ];
  for (const manifest of cases) {
    assert.throws(() => parseP13S1Bundle(JSON.stringify(manifest), fixture.artifacts));
  }
  assert.throws(() => parseP13S1Bundle(fixture.manifestText, { ...fixture.artifacts, unexpected: "[]" }), /allowlist is not exact/);
});

test("CLI resolves only fixed JSON artifacts beneath the immutable S1 root", () => {
  const source = readFileSync(new URL("../scripts/p13-import-s1.ts", import.meta.url), "utf8");
  assert.match(source, /resolve\(tablesRoot, `\$\{table\}\.json`\)/);
  assert.match(source, /realpath\(path\)/);
  assert.match(source, /relative\(resolvedRoot, resolvedPath\)/);
  assert.doesNotMatch(source, /resolve\([^\n]*value\.file/);
  assert.match(source, /host: "\/var\/run\/postgresql"/);
  assert.match(source, /port: 5433/);
  assert.match(source, /database: "jhc_netops"/);
  assert.match(source, /user: "postgres"/);
  assert.doesNotMatch(source, /password:/);
  assert.match(source, /for await \(const chunk of process\.stdin\)/);
  assert.doesNotMatch(source, /P13_CUTOVER_RECORD_PATH/);
  assert.doesNotMatch(source, /P13_IMPORT_EVIDENCE_PATH/);
});

test("S1 artifacts reject SHA mismatch, row-count mismatch, malformed arrays, schema drift, and duplicate keys", () => {
  const fixture = s1Fixture();
  assert.throws(() => parseP13S1Bundle(fixture.manifestText, { ...fixture.artifacts, profiles: "[]" }), /integrity failed/);

  const wrongCount = withManifest(fixture, {
    ...fixture.manifest,
    tables: fixture.manifest.tables.map((entry) => entry.table === "profiles" ? { ...entry, row_count: 2 } : entry),
  });
  assert.throws(() => parseP13S1Bundle(wrongCount.manifestText, wrongCount.artifacts), /row count failed/);

  for (const content of ["{}", JSON.stringify([{ ...PROFILE, unknown: true }]), JSON.stringify([PROFILE, PROFILE])]) {
    const changed = withArtifact(fixture, "profiles", content);
    assert.throws(() => parseP13S1Bundle(changed.manifestText, changed.artifacts));
  }
});

test("migration body loader accepts only reviewed hashes and strips exactly the outer transaction wrapper", () => {
  for (const [version, source] of [[7, MIGRATION_007], [8, MIGRATION_008]] as const) {
    const body = migrationBody(source, version);
    assert.doesNotMatch(body, /^\s*BEGIN;/);
    assert.doesNotMatch(body, /COMMIT;\s*$/);
    assert.doesNotMatch(body, /^\s*\\set/m);
    assert.match(body, /SET ROLE jhc_netops_owner;/);
    assert.match(body, new RegExp(`application_schema_migrations\\(version\\) VALUES \\(${version}\\);`));
    assert.throws(() => migrationBody(`${source}\n-- changed`, version), /reviewed hash/);
    assert.throws(() => migrationBody(source.replace("BEGIN;", ""), version), /reviewed hash/);
    assert.throws(() => migrationBody(source.replace(/COMMIT;\s*$/, ""), version), /reviewed hash/);
  }
});

test("production migration guards accept the reviewed Unix socket and reject other target identities", () => {
  for (const source of [MIGRATION_007, MIGRATION_008]) {
    assert.match(source, /current_database\(\) <> 'jhc_netops'/);
    assert.match(source, /current_setting\('port'\)::integer <> 5433/);
    assert.match(
      source,
      /inet_server_addr\(\) IS NOT NULL\s+AND host\(inet_server_addr\(\)\) NOT IN \('127\.0\.0\.1', '::1'\)/,
    );
    assert.doesNotMatch(source, /host\(inet_server_addr\(\)\) IS NULL/);
    assert.match(source, /current_setting\('server_version_num'\)::integer NOT BETWEEN 160000 AND 169999/);
    assert.match(source, /current_setting\('data_directory'\) <> '\/var\/lib\/postgresql\/16\/jhcnetops'/);
    assert.match(source, /session_user <> 'postgres'/);
    assert.match(source, /to_regclass\('asset\.assets'\) IS NULL/);
  }
});

test("production migrations contain no asset schema mutation", () => {
  for (const source of [MIGRATION_007, MIGRATION_008]) {
    assert.doesNotMatch(
      source,
      /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE|ALTER\s+TABLE|CREATE\s+TABLE|DROP\s+TABLE)\s+asset\./i,
    );
  }
});

test("asset schema and complete data fingerprint changes abort and roll back", async () => {
  const fixture = s1Fixture();
  const fake = fakeBootstrapDatabase(fixture, { mutateAssetAfterImport: true });
  await assert.rejects(() => bootstrapP13S1(bootstrapOptions(fixture, fake.query)), /asset schema or data changed/);
  assert.equal(fake.calls.at(-1), "ROLLBACK");
});

test("final full-row mismatch is detected even when counts and keysets match", async () => {
  const fixture = s1Fixture();
  const fake = fakeBootstrapDatabase(fixture, {
    finalRows: { profiles: [{ ...PROFILE, full_name: "Changed without count or key change" }] },
  });
  await assert.rejects(() => bootstrapP13S1(bootstrapOptions(fixture, fake.query)), /Final S1 parity failed for profiles/);
  assert.equal(fake.calls.at(-1), "ROLLBACK");
});

test("composite-key parity is enforced for managed interfaces and observed hosts", async () => {
  const interfaceRow = completeRow("managed_interface_latest", {
    target_id: "20000000-0000-4000-8000-000000000001",
    if_index: 7,
  });
  const observedRow = completeRow("managed_observed_hosts_latest", {
    target_id: "20000000-0000-4000-8000-000000000001",
    ip_address: "192.168.1.10",
  });
  const fixture = s1Fixture({
    managed_interface_latest: [interfaceRow],
    managed_observed_hosts_latest: [observedRow],
  });
  const fake = fakeBootstrapDatabase(fixture, {
    finalRows: {
      managed_interface_latest: [{ ...interfaceRow, if_index: 8 }],
      managed_observed_hosts_latest: [{ ...observedRow, ip_address: "192.168.1.11" }],
    },
  });
  await assert.rejects(() => bootstrapP13S1(bootstrapOptions(fixture, fake.query)), /Final S1 parity failed for managed_interface_latest/);
});

test("migration 008 readiness and clean outbox are accepted only after the full import", async () => {
  const fixture = s1Fixture();
  const fake = fakeBootstrapDatabase(fixture, { pendingOutbox: 1 });
  await assert.rejects(() => bootstrapP13S1(bootstrapOptions(fixture, fake.query)), /bootstrap outbox is not clean/);
  const migration008 = fake.calls.findIndex((sql) => sql.includes("VALUES (8);"));
  const sequenceReset = fake.calls.findIndex((sql) => sql.includes("pg_get_serial_sequence('public.network_health_samples'"));
  const outboxRead = fake.calls.findIndex((sql) => sql === P13_OUTBOX_STATE_SQL);
  assert.ok(sequenceReset >= 0 && sequenceReset < migration008 && migration008 < outboxRead);
  assert.equal(fake.calls.at(-1), "ROLLBACK");
});

type Manifest = Readonly<{
  version: 1;
  kind: "p13_s1_source_snapshot_manifest";
  source_checkpoint_identity: string;
  table_count: number;
  tables: readonly Readonly<{
    table: string;
    row_count: number;
    file: string;
    sha256: string;
    pagination: Readonly<{ pages: number }>;
  }>[];
}>;

type S1Fixture = Readonly<{
  manifest: Manifest;
  manifestText: string;
  manifestSha256: string;
  artifacts: Readonly<Record<string, string>>;
  rows: Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>>;
  record: P13CutoverRecord;
}>;

function s1Fixture(overrides: Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>> = {}): S1Fixture {
  const rows = Object.fromEntries(P13_APPLICATION_TABLES.map((table) => [
    table,
    overrides[table] ?? (table === "profiles" ? [PROFILE] : []),
  ]));
  const artifacts = Object.fromEntries(P13_APPLICATION_TABLES.map((table) => [table, JSON.stringify(rows[table])]));
  const manifest: Manifest = {
    version: 1,
    kind: "p13_s1_source_snapshot_manifest",
    source_checkpoint_identity: CHECKPOINT,
    table_count: P13_APPLICATION_TABLES.length,
    tables: P13_APPLICATION_TABLES.map((table) => ({
      table,
      row_count: rows[table]!.length,
      file: `tables/${table}.json`,
      sha256: sha256(artifacts[table]!),
      pagination: { pages: rows[table]!.length ? 1 : 0 },
    })),
  };
  return fixtureFrom(manifest, artifacts, rows);
}

function withManifest(fixture: S1Fixture, manifest: Manifest): S1Fixture {
  return fixtureFrom(manifest, fixture.artifacts, fixture.rows);
}

function withArtifact(fixture: S1Fixture, table: string, content: string): S1Fixture {
  const artifacts = { ...fixture.artifacts, [table]: content };
  const manifest: Manifest = {
    ...fixture.manifest,
    tables: fixture.manifest.tables.map((entry) => entry.table === table ? { ...entry, sha256: sha256(content) } : entry),
  };
  return fixtureFrom(manifest, artifacts, fixture.rows);
}

function fixtureFrom(
  manifest: Manifest,
  artifacts: Readonly<Record<string, string>>,
  rows: Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>>,
): S1Fixture {
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestSha256 = sha256(manifestText);
  return Object.freeze({ manifest, manifestText, manifestSha256, artifacts, rows, record: cutoverRecord(manifestSha256) });
}

function bootstrapOptions(fixture: S1Fixture, query: P13BootstrapQuery) {
  return {
    mode: "bootstrap" as const,
    record: fixture.record,
    source_checkpoint_identity: CHECKPOINT,
    expected_s1_manifest_sha256: fixture.manifestSha256,
    manifest_text: fixture.manifestText,
    artifacts: fixture.artifacts,
    migration_007: MIGRATION_007,
    migration_008: MIGRATION_008,
    query,
  };
}

function fakeBootstrapDatabase(
  fixture: S1Fixture,
  options: Readonly<{
    mutateAssetAfterImport?: boolean;
    pendingOutbox?: number;
    finalRows?: Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>>;
  }> = {},
): Readonly<{ query: P13BootstrapQuery; calls: string[] }> {
  const calls: string[] = [];
  let phase: 0 | 7 | 8 = 0;
  let assetRead = 0;
  const query: P13BootstrapQuery = async (sql) => {
    calls.push(sql);
    if (sql === P13_ADMIN_TARGET_IDENTITY_SQL) return result([{
      database_name: "jhc_netops", server_port: 5433, server_address: "127.0.0.1", login_role: "postgres",
      data_directory: "/var/lib/postgresql/16/jhcnetops",
    }]);
    if (sql === P13_TARGET_INVENTORY_SQL) return result(inventoryRows(phase));
    if (sql === P13_MIGRATION_VERSIONS_SQL) return result((phase === 8 ? [7, 8] : [7]).map((version) => ({ version })));
    if (sql === P13_ASSET_SCHEMA_IDENTITY_SQL) return result([{
      kind: "column", table_name: "assets", identity: "1", definition: "id|uuid|true|",
    }]);
    if (sql.includes("FROM (SELECT * FROM asset.")) {
      assetRead += 1;
      return result([{ row_json: JSON.stringify({ id: options.mutateAssetAfterImport && assetRead > 1 ? "asset-2" : "asset-1" }) }]);
    }
    if (sql.includes("VALUES (7);")) { phase = 7; return result([]); }
    if (sql.includes("VALUES (8);")) { phase = 8; return result([]); }
    if (sql === P13_OUTBOX_STATE_SQL) return result([{
      total_count: String(options.pendingOutbox ?? 0), pending_count: String(options.pendingOutbox ?? 0),
      failed_count: "0", watermark_count: "0", canary_count: "0",
    }]);
    if (sql === P13_SHADOW_TRIGGER_SQL) return result(P13_SHADOW_TRIGGERS.map((trigger_name) => ({ trigger_name })));
    const countTable = /count\(\*\)::text AS row_count FROM public\."([a-z0-9_]+)"/.exec(sql)?.[1];
    if (countTable) return result([{ row_count: String(targetRows(fixture, options, countTable).length) }]);
    const rowsTable = /FROM public\."([a-z0-9_]+)" ORDER BY/.exec(sql)?.[1];
    if (rowsTable) return result(targetRows(fixture, options, rowsTable).map((row) => ({ row_json: canonicalJson(row) })));
    return result([]);
  };
  return Object.freeze({ query, calls });
}

function targetRows(
  fixture: S1Fixture,
  options: Readonly<{ finalRows?: Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>> }>,
  table: string,
): readonly Readonly<Record<string, unknown>>[] {
  return options.finalRows?.[table] ?? fixture.rows[table] ?? [];
}

function completeRow(table: string, values: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const definition = P12_TABLES.find((entry) => entry.table === table);
  assert.ok(definition);
  return Object.freeze(Object.fromEntries(definition.columns.map((column) => [column, values[column] ?? null])));
}

function cutoverRecord(snapshotSha256: string): P13CutoverRecord {
  return Object.freeze({
    version: 1,
    checkpoint: "CHECKPOINT_1_FINAL_SOURCE_CAPTURED",
    persistence_authority: "supabase",
    source_checkpoint_identity: CHECKPOINT,
    target: Object.freeze({ cluster: "16/jhcnetops", port: 5433, database: "jhc_netops" }),
    created_at: "2026-09-17T00:00:00.000Z",
    updated_at: "2026-09-17T00:01:00.000Z",
    freeze_readiness_evidence_sha256: "c".repeat(64),
    authority_readiness_evidence_sha256: null,
    final_snapshot_sha256: snapshotSha256,
    final_import_verified: false,
    final_parity_verified: false,
    pre_cutover_verification_sha256: null,
    post_cutover_verification_sha256: null,
    local_authoritative_write_count: 0,
    postflight_passed: false,
    canary_cutover_identity: null,
    canary_id: null,
  });
}

function inventory(
  publicRelations: readonly string[],
  versions: readonly number[],
  s0BaselineVerified = false,
): P13TargetInventory {
  return Object.freeze({
    public_relations: Object.freeze([...publicRelations]),
    asset_relations: Object.freeze(["assets"]),
    migration_versions: Object.freeze([...versions]),
    s0_baseline_verified: s0BaselineVerified,
  });
}

function inventoryRows(phase: 0 | 7 | 8): readonly Readonly<Record<string, unknown>>[] {
  const publicRelations = phase === 0 ? [] : [
    ...P13_APPLICATION_TABLES,
    P13_MIGRATION_TABLE,
    ...(phase === 8 ? P13_OUTBOX_TABLES : []),
  ];
  return [
    { schema_name: "asset", relation_name: "assets" },
    ...publicRelations.map((relation_name) => ({ schema_name: "public", relation_name })),
  ];
}

function result(rows: readonly Readonly<Record<string, unknown>>[]) {
  return Object.freeze({ rows: Object.freeze(rows) });
}
