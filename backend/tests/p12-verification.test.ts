import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJsonLines, P12JsonNumber, sha256 } from "../src/data-migration/canonical.js";
import { P12_AUTH_COUPLED_COLUMNS, P12_TABLES } from "../src/data-migration/contract.js";
import { reconcileP12Identities, P12ReconciliationError, type P12LocalAsset } from "../src/data-migration/reconciliation.js";
import { buildP12ActiveStateReport, buildP12AuthReferenceReport, buildP12RunSummary } from "../src/data-migration/reporting.js";
import { compareP12Runs, type P12RunOutcome } from "../src/data-migration/repeatability.js";
import { P12_NON_ATOMIC_WARNING, type P12SnapshotBundle, type P12SnapshotManifest } from "../src/data-migration/snapshot.js";
import { P12_NATIVE_TYPE_EXPECTATIONS } from "../src/data-migration/verification-contract.js";
import { tableFingerprint, verifyP12Rehearsal, type P12RehearsalData, type P12VerificationReport } from "../src/data-migration/verification.js";

const RUN_ID = "run01";
const NOW = () => new Date("2026-09-14T02:00:00.000Z");
const BASELINE_HASH = "c".repeat(64);
const NODE_A = "11111111-1111-4111-8111-111111111111";
const NODE_B = "22222222-2222-4222-8222-222222222222";
const TARGET_A = "33333333-3333-4333-8333-333333333333";
const RUNNER_A = "runner-a";
const ASSET_A = "44444444-4444-4444-8444-444444444444";
const ASSET_B = "55555555-5555-4555-8555-555555555555";

test("matching counts, fingerprints, PKs, types and empty sequence pass verification", () => {
  const bundle = bundleWith();
  const report = verifyP12Rehearsal({ bundle, target: rehearsalData(), localBaselineSha256: BASELINE_HASH, now: NOW });
  assert.equal(report.overall_status, "PASS");
  assert.ok(report.tables.every(({ count_status, fingerprint_status, pk_status }) =>
    count_status === "PASS" && fingerprint_status === "PASS" && pk_status === "PASS"));
  assert.equal(report.sequence.status, "PASS");
});

test("row-count and fingerprint differences fail closed", () => {
  const profile = row("profiles", { id: NODE_A, email: "admin@example.invalid", role: "admin", status: "approved", created_at: "2026-09-14T00:00:00Z" });
  const countReport = verifyP12Rehearsal({
    bundle: bundleWith(),
    target: rehearsalData({ profiles: [profile] }),
    localBaselineSha256: BASELINE_HASH,
  });
  assert.equal(table(countReport, "profiles").count_status, "FAIL");
  assert.equal(table(countReport, "profiles").fingerprint_status, "FAIL");

  const source = bundleWith({ profiles: [profile] });
  const changed = { ...profile, email: "changed@example.invalid" };
  const fingerprintReport = verifyP12Rehearsal({
    bundle: source,
    target: rehearsalData({ profiles: [changed] }),
    localBaselineSha256: BASELINE_HASH,
  });
  assert.equal(table(fingerprintReport, "profiles").count_status, "PASS");
  assert.equal(table(fingerprintReport, "profiles").fingerprint_status, "FAIL");
});

test("duplicate PK, unexpected unique collision, required null and FK orphan are reported", () => {
  const nodeOne = row("network_nodes", { id: NODE_A, ip_address: "192.168.1.10", name: "A", created_at: "2026-09-14T00:00:00Z", updated_at: "2026-09-14T00:00:00Z" });
  const nodeTwo = row("network_nodes", { id: NODE_B, ip_address: "192.168.1.10", name: null, created_at: "2026-09-14T00:00:00Z", updated_at: "2026-09-14T00:00:00Z" });
  const duplicateNode = { ...nodeTwo, id: NODE_A };
  const latest = row("network_health_latest", {
    target_id: TARGET_A, status: "online", packet_loss_percent: 0, last_checked_at: "2026-09-14T00:00:00Z",
    consecutive_failures: 0, sample_count: 1, updated_at: "2026-09-14T00:00:00Z",
  });
  const source = bundleWith({ network_nodes: [nodeOne, nodeTwo], network_health_latest: [latest] });
  const report = verifyP12Rehearsal({
    bundle: source,
    target: rehearsalData({ network_nodes: [nodeOne, duplicateNode], network_health_latest: [latest] }),
    localBaselineSha256: BASELINE_HASH,
  });
  assert.equal(table(report, "network_nodes").pk_status, "FAIL");
  assert.equal(table(report, "network_nodes").required_null_status, "FAIL");
  assert.equal(report.unique_checks.find(({ name }) => name === "network_nodes_ip")?.status, "FAIL");
  assert.equal(report.foreign_key_checks.find(({ name }) => name.startsWith("network_health_latest.target_id"))?.status, "FAIL");
});

test("Auth logical references are warnings rather than fabricated rehearsal FK failures", () => {
  const job = row("diagnostic_jobs", {
    id: NODE_B, runner_id: RUNNER_A, requested_by: NODE_A, status: "completed", type: "bandwidth_and_path",
    source_label: "source", target_id: "target", target_label: "target", target_host: "192.168.1.2", iperf_port: 5201,
    connection_type: "ethernet", duration_seconds: 5, environment: "lan", stage: "complete", progress: {},
    created_at: "2026-09-14T00:00:00Z", updated_at: "2026-09-14T00:00:00Z",
  });
  const runner = row("diagnostic_runners", {
    id: RUNNER_A, display_name: "Runner", last_seen_at: "2026-09-14T00:00:00Z", health_status: "online",
    capabilities: {}, created_at: "2026-09-14T00:00:00Z", updated_at: "2026-09-14T00:00:00Z",
  });
  const bundle = bundleWith({ diagnostic_runners: [runner], diagnostic_jobs: [job] });
  const report = verifyP12Rehearsal({ bundle, target: rehearsalData({ diagnostic_runners: [runner], diagnostic_jobs: [job] }), localBaselineSha256: BASELINE_HASH });
  assert.ok(!report.foreign_key_checks.some(({ name }) => name.includes("requested_by")));
  const auth = buildP12AuthReferenceReport(bundle, NOW);
  assert.equal(auth.status, "WARN");
  assert.equal(auth.unresolved_logical_reference_count, 1);
  assert.equal(auth.validates_supabase_auth, false);
});

test("fingerprints are deterministic, chunked, and preserve lossless bigint semantics", () => {
  const rows = [
    { id: new P12JsonNumber("900719925474099312346"), payload: { exact: new P12JsonNumber("123456789012345678901") } },
    { id: new P12JsonNumber("900719925474099312345"), payload: null },
  ];
  const first = tableFingerprint(rows, ["id"], 1);
  const second = tableFingerprint([...rows].reverse(), ["id"], 1);
  assert.equal(first.sha256, second.sha256);
  assert.deepEqual(first.chunks, second.chunks);
  assert.equal(first.chunks.length, 2);
});

test("sensitive legacy bytea contributes only hashes, never raw human report content", () => {
  const secret = "\\x736563726574";
  const managed = row("managed_telemetry_targets", {
    id: TARGET_A, node_id: NODE_A, runner_id: RUNNER_A, enabled: false, credential_profile_ref: "ref", snmp_version: "2c",
    snmp_port: 161, poll_interval_seconds: 60, oper_error_threshold: 5, discard_threshold: 10, util_warning_percent: 80,
    util_critical_percent: 95, util_sustained_seconds: 300, created_at: "2026-09-14T00:00:00Z", updated_at: "2026-09-14T00:00:00Z",
    snmp2c_community_encrypted: secret,
  });
  const bundle = bundleWith({ managed_telemetry_targets: [managed] });
  const report = verifyP12Rehearsal({ bundle, target: rehearsalData({ managed_telemetry_targets: [managed] }), localBaselineSha256: BASELINE_HASH });
  assert.doesNotMatch(JSON.stringify(report), /736563726574/);
});

test("sequence verification passes at imported maximum and fails when behind", () => {
  const sample = row("network_health_samples", {
    id: new P12JsonNumber("900719925474099312345"), target_id: TARGET_A, sampled_at: "2026-09-14T00:00:00Z",
    status: "online", packet_loss_percent: 0, sample_count: 1,
  });
  const bundle = bundleWith({ network_health_samples: [sample] });
  const pass = verifyP12Rehearsal({
    bundle,
    target: rehearsalData({ network_health_samples: [sample] }, "900719925474099312345", true),
    localBaselineSha256: BASELINE_HASH,
  });
  const fail = verifyP12Rehearsal({
    bundle,
    target: rehearsalData({ network_health_samples: [sample] }, "900719925474099312344", true),
    localBaselineSha256: BASELINE_HASH,
  });
  assert.equal(pass.sequence.status, "PASS");
  assert.equal(fail.sequence.status, "FAIL");
});

test("reconciliation classifies exact, source-only, local-only and conflict deterministically", () => {
  const nodeOne = sourceNode(NODE_A, "192.168.1.10", "Core");
  const nodeTwo = sourceNode(NODE_B, "192.168.1.20", "Source only");
  const exact = localAsset({ id: ASSET_A, stable_source_key: `node:${NODE_A}`, network_node_ref: NODE_A, ip_address: "192.168.1.10", name: "Core" });
  const localOnly = localAsset({ id: ASSET_B, stable_source_key: `manual:${ASSET_B}`, ip_address: "192.168.1.30", name: "Local" });
  const result = reconcileP12Identities({ bundle: bundleWith({ network_nodes: [nodeOne, nodeTwo] }), localAssets: [exact, localOnly], now: NOW });
  assert.deepEqual(result.category_counts, { EXACT_MATCH: 1, SOURCE_ONLY: 1, LOCAL_ONLY: 1, CONFLICT: 0, AMBIGUOUS: 0 });

  const conflict = reconcileP12Identities({
    bundle: bundleWith({ network_nodes: [nodeOne] }),
    localAssets: [{ ...exact, ip_address: "192.168.1.99" }],
  });
  assert.equal(conflict.category_counts.CONFLICT, 1);
  assert.deepEqual(conflict.findings[0]?.differing_fields, ["ip_address"]);
});

test("reconciliation marks multiple durable candidates ambiguous and gives stable node UUID priority", () => {
  const source = sourceNode(NODE_A, "192.168.1.10", "Core");
  const first = localAsset({ id: ASSET_A, stable_source_key: `node:${NODE_A}`, network_node_ref: NODE_A, ip_address: "192.168.1.10" });
  const second = localAsset({ id: ASSET_B, stable_source_key: `manual:${ASSET_B}`, network_node_ref: NODE_A, ip_address: "192.168.1.10" });
  const ambiguous = reconcileP12Identities({ bundle: bundleWith({ network_nodes: [source] }), localAssets: [first, second] });
  assert.equal(ambiguous.category_counts.AMBIGUOUS, 1);

  const ipOnly = localAsset({ id: ASSET_B, stable_source_key: `manual:${ASSET_B}`, ip_address: "192.168.1.10" });
  const priority = reconcileP12Identities({ bundle: bundleWith({ network_nodes: [source] }), localAssets: [first, ipOnly] });
  assert.equal(priority.category_counts.AMBIGUOUS, 0);
  assert.equal(priority.category_counts.CONFLICT, 1);
  assert.equal(priority.findings.find(({ source_stable_identifier }) => source_stable_identifier === `node:${NODE_A}`)?.local_asset_identifier, ASSET_A);
  assert.equal(priority.category_counts.LOCAL_ONLY, 1);
});

test("IP-only evidence cannot become an exact durable identity", () => {
  const source = sourceNode(NODE_A, "192.168.1.10", "Core");
  const local = localAsset({ id: ASSET_A, stable_source_key: `manual:${ASSET_A}`, ip_address: "192.168.1.10" });
  const report = reconcileP12Identities({ bundle: bundleWith({ network_nodes: [source] }), localAssets: [local] });
  assert.equal(report.category_counts.EXACT_MATCH, 0);
  assert.equal(report.category_counts.SOURCE_ONLY, 1);
  assert.equal(report.category_counts.LOCAL_ONLY, 1);
});

test("malformed reconciliation input fails rather than leaving an unclassified record", () => {
  const malformed = row("network_nodes", { id: "bad", ip_address: "192.168.1.10", name: "Bad" });
  assert.throws(() => reconcileP12Identities({ bundle: bundleWith({ network_nodes: [malformed] }), localAssets: [] }), P12ReconciliationError);
});

test("active lifecycle report includes active jobs and excludes completed jobs", () => {
  const active = row("diagnostic_jobs", { id: NODE_A, status: "running" });
  const complete = row("diagnostic_jobs", { id: NODE_B, status: "completed" });
  const report = buildP12ActiveStateReport(bundleWith({ diagnostic_jobs: [active, complete] }), NOW);
  assert.equal(report.active_count, 1);
  assert.equal(report.items[0]?.id, NODE_A);
  assert.equal(report.status, "WARN");
});

test("repeatability ignores execution metadata but detects row, fingerprint and reconciliation changes", () => {
  const runA = outcome("a");
  const runB = outcome("b", "2026-09-15T03:00:00Z");
  assert.equal(runA.summary.local_baseline_sha256, runB.summary.local_baseline_sha256);
  assert.equal(compareP12Runs(runA, runB, NOW).status, "PASS");
  const replacedArtifact = compareP12Runs(runA, runB, NOW, {
    sourceSnapshotSha256: "e".repeat(64),
    localBaselineSha256: BASELINE_HASH,
  });
  assert.equal(replacedArtifact.status, "FAIL");
  assert.ok(replacedArtifact.differences.includes("current_snapshot_artifact"));
  const replacedBaselineArtifact = compareP12Runs(runA, runB, NOW, {
    sourceSnapshotSha256: runA.summary.source_snapshot_sha256,
    localBaselineSha256: "e".repeat(64),
  });
  assert.equal(replacedBaselineArtifact.status, "FAIL");
  assert.ok(replacedBaselineArtifact.differences.includes("current_local_baseline_artifact"));

  const changedBaseline: P12RunOutcome = {
    ...runB,
    summary: { ...runB.summary, local_baseline_sha256: "d".repeat(64) },
    verification: { ...runB.verification, local_baseline_sha256: "d".repeat(64) },
  };
  const changedBaselineReport = compareP12Runs(runA, changedBaseline, NOW);
  assert.equal(changedBaselineReport.status, "FAIL");
  assert.ok(changedBaselineReport.differences.includes("local_baseline_sha256"));

  const changedTable = { ...runB.verification.tables[0]!, target_row_count: 1, target_sha256: "d".repeat(64) };
  const changedVerification = { ...runB.verification, tables: [changedTable, ...runB.verification.tables.slice(1)] };
  const changedSummary = { ...runB.summary, imported_rows: { ...runB.summary.imported_rows, profiles: 1 } };
  const changedReconciliation = {
    ...runB.reconciliation,
    category_counts: { ...runB.reconciliation.category_counts, SOURCE_ONLY: 1 },
  };
  const changed: P12RunOutcome = { ...runB, verification: changedVerification, summary: changedSummary, reconciliation: changedReconciliation };
  const report = compareP12Runs(runA, changed, NOW);
  assert.equal(report.status, "FAIL");
  assert.ok(report.differences.includes("imported_row_counts"));
  assert.ok(report.differences.includes("table_fingerprints"));
  assert.ok(report.differences.includes("reconciliation_counts"));
});

function outcome(label: "a" | "b", generatedAt = "2026-09-14T02:00:00Z"): P12RunOutcome {
  const bundle = bundleWith();
  const verification = verifyP12Rehearsal({ bundle, target: rehearsalData(), localBaselineSha256: BASELINE_HASH, now: () => new Date(generatedAt) });
  const reconciliation = reconcileP12Identities({ bundle, localAssets: [], now: () => new Date(generatedAt) });
  const active = buildP12ActiveStateReport(bundle, () => new Date(generatedAt));
  const auth = buildP12AuthReferenceReport(bundle, () => new Date(generatedAt));
  const summary = buildP12RunSummary({ label, bundle, verification, reconciliation, active, auth, now: () => new Date(generatedAt) });
  return { summary, verification, reconciliation, active, auth };
}

function rehearsalData(
  overrides: Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>> = {},
  lastValue = "1",
  isCalled = false,
): P12RehearsalData {
  const rows = new Map(P12_TABLES.map(({ table }) => [table, overrides[table] ?? []]));
  const nativeTypes = new Map(P12_TABLES.map(({ table }) => [
    table,
    new Map(Object.entries({
      ...((P12_NATIVE_TYPE_EXPECTATIONS as Readonly<Record<string, Readonly<Record<string, string>>>>)[table] ?? {}),
      ...Object.fromEntries((P12_TABLES.find((definition) => definition.table === table)?.columns ?? [])
        .filter((column) => column.endsWith("_at") || column === "first_seen" || column === "last_seen")
        .map((column) => [column, "timestamptz"])),
    })),
  ]));
  return { rows, nativeTypes, sequence: { lastValue, isCalled } };
}

function bundleWith(overrides: Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>> = {}): P12SnapshotBundle {
  const artifacts: Record<string, string> = {};
  const tables = P12_TABLES.map((definition) => {
    const content = canonicalJsonLines(overrides[definition.table] ?? []);
    artifacts[definition.table] = content;
    return {
      source_table: definition.table,
      row_count: overrides[definition.table]?.length ?? 0,
      ordering_key: definition.orderingKey,
      chunks: [{ page: 0, offset: 0, row_count: overrides[definition.table]?.length ?? 0 }],
      output_sha256: sha256(content),
      artifact: `${definition.table}.jsonl`,
    };
  });
  const manifest: P12SnapshotManifest = {
    version: 1, run_id: RUN_ID, source_commit: "a".repeat(40), source_schema_version: "fixture",
    source_schema_sha256: "b".repeat(64), capture_started_at: "2026-09-14T00:00:00Z",
    capture_completed_at: "2026-09-14T00:00:01Z", atomic: false, warning: P12_NON_ATOMIC_WARNING,
    auth_coupled_columns: P12_AUTH_COUPLED_COLUMNS, tables,
  };
  return { manifest, artifacts };
}

function row(tableName: string, values: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const definition = P12_TABLES.find(({ table }) => table === tableName);
  assert.ok(definition);
  return Object.freeze({ ...Object.fromEntries(definition.columns.map((column) => [column, null])), ...values });
}

function table(report: P12VerificationReport, name: string) {
  const value = report.tables.find(({ table: tableName }) => tableName === name);
  assert.ok(value);
  return value;
}

function sourceNode(id: string, ip: string, name: string) {
  return row("network_nodes", { id, ip_address: ip, name, device_type: "network_device" });
}

function localAsset(overrides: Partial<P12LocalAsset>): P12LocalAsset {
  return {
    id: ASSET_A,
    stable_source_key: `manual:${ASSET_A}`,
    name: "Core",
    device_type: "network_device",
    ip_address: null,
    mac_address: null,
    source: "discovery",
    network_node_ref: null,
    health_target_ref: null,
    managed_telemetry_target_ref: null,
    observed_host_target_ref: null,
    ...overrides,
  };
}
