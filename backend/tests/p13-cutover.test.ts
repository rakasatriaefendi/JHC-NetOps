import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { P12AuthReferenceReport } from "../src/data-migration/reporting.js";
import { P12_TABLES } from "../src/data-migration/contract.js";
import type { P12VerificationReport } from "../src/data-migration/verification.js";
import {
  assertPersistenceAuthority,
  parsePersistenceAuthority,
  selectApplicationPersistence,
} from "../src/persistence/authority.js";
import {
  armLocalAuthority,
  createP13CutoverRecord,
  recordFinalCapture,
  recordFinalImport,
  recordFinalVerification,
  recordFreezeReadiness,
  recordPostCutoverVerification,
  recordPostflight,
  recordPreCutoverVerification,
  rollbackCheck,
  safeP13Failure,
} from "../src/cutover/cutover.js";
import { assessP13Rollback, assertP13CheckpointTransition } from "../src/cutover/checkpoint.js";
import {
  evaluateP13Readiness,
  buildP13SqliteBufferEvidence,
  inspectP13RunnerStateBuffer,
  P13_FREEZE_BUFFERS,
  P13_REQUIRED_BUFFERS,
  P13_WORKFLOW_POLICIES,
  type P13ReadinessEvidence,
} from "../src/cutover/readiness.js";
import { acknowledgementFor, loadP13Target, publicP13Target, type P13Action } from "../src/cutover/target.js";
import {
  assertP13VerificationPassed,
  buildP13FinalDataVerification,
  classifyP13CutoverDecision,
  P13_FINAL_DATA_CHECKS,
  P13_NETOPS_PM2_PROCESSES,
  verifyP13PostCutover,
  verifyP13PreCutover,
  type P13PostCutoverEvidence,
  type P13PreCutoverEvidence,
} from "../src/cutover/verification.js";

const SHA = "a".repeat(64);
const SNAPSHOT_SHA = "b".repeat(64);
const NOW = () => new Date("2026-09-15T01:02:03.000Z");

test("authority is explicit, invalid values fail, and selected implementations never fall back", () => {
  assert.throws(() => parsePersistenceAuthority(undefined), /PERSISTENCE_AUTHORITY/);
  assert.equal(parsePersistenceAuthority("local_postgres"), "local_postgres");
  assert.throws(() => parsePersistenceAuthority("auto"), /PERSISTENCE_AUTHORITY/);

  const calls: string[] = [];
  const local = selectApplicationPersistence("local_postgres", {
    supabase: () => { calls.push("supabase"); return "wrong"; },
    localPostgres: () => { calls.push("local"); return "local"; },
  });
  assert.equal(local, "local");
  assert.deepEqual(calls, ["local"]);
  assert.throws(() => assertPersistenceAuthority("local_postgres", "supabase"));
});

test("workflow policy is exhaustive for actual persisted job/session statuses", () => {
  assert.deepEqual(P13_WORKFLOW_POLICIES.diagnostic_jobs, {
    queued: "queued", running: "active", completed: "safe_terminal", failed: "safe_terminal",
  });
  assert.equal(P13_WORKFLOW_POLICIES.traffic_live_sessions.stopping, "transitional");
  assert.equal(P13_WORKFLOW_POLICIES.traffic_live_sessions.expired, "expired");
  assert.equal(P13_WORKFLOW_POLICIES.network_discovery_sessions.idle, "safe_terminal");
  assert.equal(P13_WORKFLOW_POLICIES.device_inspection_sessions.expired, "expired");
  assert.equal(P13_WORKFLOW_POLICIES.network_health_ping_jobs.completed, "safe_terminal");
});

test("terminal workflow rows and drained buffers pass read-only readiness", () => {
  const report = evaluateP13Readiness(readinessFixture(), "post_import_authority");
  assert.equal(report.status, "PASS");
  assert.deepEqual(report.blockers, []);
  assert.match(report.evidence_sha256, /^[0-9a-f]{64}$/);
});

test("pre-migration freeze can pass before migration 008 without post-import observations", () => {
  const report = evaluateP13Readiness(freezeReadinessFixture(), "pre_migration_freeze");
  assert.equal(report.gate, "pre_migration_freeze");
  assert.equal(report.status, "PASS");
  assert.deepEqual(report.blockers, []);
});

test("post-import authority rejects missing migration 008 and projector observations", () => {
  assert.throws(
    () => evaluateP13Readiness(freezeReadinessFixture(), "post_import_authority"),
    /post-import readiness fields are missing or invalid/,
  );
});

test("projection outbox is required only by the post-import authority gate", () => {
  const withoutProjection = readinessFixture({ buffers: freezeBufferFixtures() });
  assert.equal(evaluateP13Readiness(withoutProjection, "pre_migration_freeze").status, "PASS");
  const authority = evaluateP13Readiness(withoutProjection, "post_import_authority");
  assert.equal(authority.status, "BLOCKED");
  assert.ok(authority.blockers.includes("buffer_evidence_missing:projection-outbox"));
});

test("active, queued, transitional, and unknown workflow rows block readiness", () => {
  for (const [table, status] of [
    ["diagnostic_jobs", "running"],
    ["network_health_ping_jobs", "queued"],
    ["traffic_live_sessions", "stopping"],
    ["device_inspection_sessions", "future_state"],
  ] as const) {
    const evidence = readinessFixture({
      workflows: { ...readinessFixture().workflows, [table]: [{ id: "job-1", status }] },
    });
    const report = evaluateP13Readiness(evidence, "post_import_authority");
    assert.equal(report.status, "BLOCKED");
    assert.ok(report.blockers.includes("unsafe_workflow_rows_present"));
  }
});

test("dirty/missing buffer evidence blocks while an immutable local replay checkpoint is accepted", () => {
  for (const state of ["dirty", "missing"] as const) {
    const evidence = readinessFixture({
      buffers: bufferFixtures().map((buffer) => buffer.name === "metrics-sqlite"
        ? { ...buffer, state, pending_count: 3 }
        : buffer),
    });
    assert.ok(evaluateP13Readiness(evidence, "post_import_authority").blockers.includes("buffer_not_safe:metrics-sqlite"));
  }

  const checkpointed = readinessFixture({
    buffers: bufferFixtures().map((buffer) => buffer.name === "metrics-sqlite"
      ? { ...buffer, state: "checkpointed" as const, pending_count: 3, replay_authority: "local_postgres" as const }
      : buffer),
  });
  assert.equal(evaluateP13Readiness(checkpointed, "post_import_authority").status, "PASS");

  const unsupportedHealthDrainClaim = readinessFixture({
    buffers: bufferFixtures().map((buffer) => buffer.name === "network-health-state"
      ? {
        name: buffer.name, state: "drained" as const, pending_count: buffer.pending_count,
        producer_paused: buffer.producer_paused, sha256: buffer.sha256,
      }
      : buffer),
  });
  assert.ok(evaluateP13Readiness(unsupportedHealthDrainClaim, "post_import_authority").blockers.includes("buffer_not_safe:network-health-state"));
});

test("runner and SQLite buffer inspectors preserve state without clearing queued work", () => {
  const health = inspectP13RunnerStateBuffer({
    name: "network-health-state",
    value: { states: { one: { status: "online" } }, pendingTransitions: [{ event_id: "one" }] },
    sha256: "1".repeat(64),
    producer_paused: true,
  });
  assert.deepEqual(health, {
    name: "network-health-state", state: "checkpointed", pending_count: 2,
    producer_paused: true, sha256: "1".repeat(64), replay_authority: "local_postgres",
  });
  const telemetry = inspectP13RunnerStateBuffer({
    name: "snmp-telemetry-state",
    value: { states: { one: { dirty: true }, two: { dirty: false } }, pendingEvents: [{}] },
    sha256: "2".repeat(64),
    producer_paused: true,
  });
  assert.equal(telemetry.state, "dirty");
  assert.equal(telemetry.pending_count, 2);
  assert.equal(buildP13SqliteBufferEvidence({
    name: "metrics-sqlite", pending_count: 0, sha256: "3".repeat(64), producer_paused: true,
  }).state, "drained");
  assert.equal(buildP13SqliteBufferEvidence({
    name: "traffic-sqlite", pending_count: 5, sha256: "4".repeat(64), producer_paused: true,
    checkpoint_for_local_replay: true,
  }).state, "checkpointed");
});

test("runner/heartbeat, legacy guards, projection, and identity disposition are hard readiness gates", () => {
  const report = evaluateP13Readiness(readinessFixture({
    source_writers_frozen: false,
    application_local_adapter_ready: false,
    local_control_plane_ready: false,
    legacy_mutation_guards_ready: false,
    realtime_projection_ready: false,
    unresolved_identity_blockers: 1,
    runner: { process_paused: false, heartbeat_writer_paused: false, active_probe_count: 1 },
  }), "post_import_authority");
  assert.deepEqual(report.blockers, [
    "identity_disposition_incomplete",
    "legacy_mutation_guards_not_ready",
    "local_application_adapter_not_ready",
    "local_control_plane_not_ready",
    "realtime_projection_not_ready",
    "runner_probe_in_flight",
    "runner_writer_not_paused",
    "source_writers_not_frozen",
  ]);
});

test("production target guard requires exact cluster, port, database, role, checkpoint, action, and acknowledgement", () => {
  const target = loadP13Target("preflight", targetEnvironment("preflight"));
  assert.deepEqual(publicP13Target(target), {
    phase: "P13", action: "preflight", cluster: "16/jhcnetops", port: 5433,
    database: "jhc_netops", role: "jhc_netops_owner", source_checkpoint_identity: SHA,
  });
  assert.ok(!("database_url" in publicP13Target(target)));

  for (const override of [
    { P13_EXPECTED_CLUSTER: "16/main" },
    { P13_EXPECTED_PORT: "5432" },
    { P13_EXPECTED_DATABASE: "mercure" },
    { P13_EXPECTED_DATABASE: "jhc_netops_p12_run" },
    { P13_EXPECTED_ROLE: "postgres" },
    { P13_ACTION: "verify-final" },
    { P13_SOURCE_CHECKPOINT_IDENTITY: "short" },
    { P13_OPERATOR_ACK: "yes" },
    { P13_DATABASE_URL: "postgresql://jhc_netops_owner:private-value@127.0.0.1:5432/jhc_netops" },
    { P12_RUN_ID: "old-rehearsal" },
  ]) assert.throws(() => loadP13Target("preflight", { ...targetEnvironment("preflight"), ...override }));
});

test("target errors and public diagnostics never surface database credentials", () => {
  const secret = "never-print-this-password";
  assert.throws(
    () => loadP13Target("preflight", {
      ...targetEnvironment("preflight"),
      P13_DATABASE_URL: `postgresql://wrong:${secret}@127.0.0.1:5433/jhc_netops`,
    }),
    (error: unknown) => error instanceof Error && !error.message.includes(secret) && !JSON.stringify(error).includes(secret),
  );
});

test("cutover failure output is category-only and never reflects arbitrary error content", () => {
  const secret = "arbitrary-private-response-body";
  const failure = safeP13Failure(new Error(secret));
  assert.deepEqual(failure, { code: "P13_TOOL_FAILED", message: "P13 stage failed safely" });
  assert.doesNotMatch(JSON.stringify(failure), new RegExp(secret));
  const guarded = safeP13Failure(Object.assign(new Error(secret), { code: "P13_TARGET_INVALID" }));
  assert.deepEqual(guarded, {
    code: "P13_TARGET_INVALID",
    message: "P13 production target guard rejected the action",
  });
  assert.doesNotMatch(JSON.stringify(guarded), new RegExp(secret));
});

test("P13 journal uses the login app role while import evidence proves NOLOGIN owner execution", () => {
  assert.doesNotThrow(() => loadP13Target("import-final", targetEnvironment("import-final", "jhc_netops_app")));
  assert.throws(() => loadP13Target("import-final", targetEnvironment("import-final")));
  assert.doesNotThrow(() => loadP13Target("verify-final", targetEnvironment("verify-final", "jhc_netops_app")));
  assert.throws(() => loadP13Target("verify-final", targetEnvironment("verify-final")));
  assert.doesNotThrow(() => loadP13Target("pre-cutover-verify", targetEnvironment("pre-cutover-verify", "jhc_netops_app")));
  assert.throws(() => loadP13Target("post-cutover-verify", targetEnvironment("post-cutover-verify")));

  const target = loadP13Target("preflight", targetEnvironment("preflight", "jhc_netops_app"));
  let record = createP13CutoverRecord(target, NOW);
  record = recordFreezeReadiness(
    record,
    evaluateP13Readiness(freezeReadinessFixture(), "pre_migration_freeze"),
    NOW,
  );
  record = recordFinalCapture(record, SNAPSHOT_SHA, NOW);
  const wrongExecutionRole = {
    ...importEvidence(),
    target: { ...importEvidence().target, execution_role: "jhc_netops_app" },
  };
  assert.throws(() => Reflect.apply(recordFinalImport, undefined, [record, wrongExecutionRole, NOW]));
  assert.doesNotThrow(() => recordFinalImport(record, importEvidence(), NOW));
});

test("checkpoint record advances only through reviewed evidence in order", () => {
  const target = loadP13Target("preflight", targetEnvironment("preflight"));
  const freezeReadiness = evaluateP13Readiness(freezeReadinessFixture(), "pre_migration_freeze");
  const authorityReadiness = evaluateP13Readiness(readinessFixture(), "post_import_authority");
  let record = createP13CutoverRecord(target, NOW);
  record = recordFreezeReadiness(record, freezeReadiness, NOW);
  record = recordFinalCapture(record, SNAPSHOT_SHA, NOW);
  const evidence = importEvidence();
  record = recordFinalImport(record, evidence, NOW);
  record = recordFinalVerification(record, evidence, NOW);
  const preCutover = verifyP13PreCutover(preCutoverFixture(record));
  record = recordPreCutoverVerification(record, preCutover, NOW);
  record = armLocalAuthority(record, authorityReadiness, NOW);
  assert.equal(record.checkpoint, "CHECKPOINT_3_LOCAL_ARMED_NO_WRITES");
  assert.equal(record.persistence_authority, "local_postgres");
  assert.equal(record.local_authoritative_write_count, 0);
  record = recordPostflight(record, { status: "PASS", local_authoritative_write_count: 2 }, NOW);
  assert.equal(record.postflight_passed, true);
  assert.equal(rollbackCheck(record, {
    local_writers_frozen: false, all_local_writes_projected: false, shadow_parity_verified: false,
  }).eligible, false);
});

test("pre-cutover verification passes only with complete target, schema, readiness, import, parity, identity, and authority evidence", () => {
  const report = verifyP13PreCutover(preCutoverFixture(checkpointTwoRecord()));
  assert.equal(report.status, "PASS");
  assert.deepEqual(report.blockers, []);
  assert.equal(report.checks.length, 14);
  assert.doesNotThrow(() => assertP13VerificationPassed(report));
});

test("final P13 data evidence reuses all P12 parity dimensions and preserves warnings as UNKNOWN", () => {
  const pass = buildP13FinalDataVerification({ verification: p12VerificationFixture(), auth: p12AuthFixture() });
  assert.equal(pass.status, "PASS");
  assert.deepEqual(Object.keys(pass.checks), [...P13_FINAL_DATA_CHECKS]);

  const warning = buildP13FinalDataVerification({
    verification: { ...p12VerificationFixture(), consistency: [{ name: "latest", status: "WARN", evidence_count: 1 }] },
    auth: p12AuthFixture(),
  });
  assert.equal(warning.status, "UNKNOWN");
  assert.equal(warning.checks.latest_and_history, "UNKNOWN");

  const failure = buildP13FinalDataVerification({
    verification: {
      ...p12VerificationFixture(),
      foreign_key_checks: [{ name: "fk", table: "network_targets", status: "FAIL", violation_count: 1 }],
    },
    auth: p12AuthFixture(),
  });
  assert.equal(failure.status, "FAIL");
  assert.equal(failure.checks.foreign_keys, "FAIL");
});

test("pre-cutover UNKNOWN and FAIL never become PASS", () => {
  const record = checkpointTwoRecord();
  const { schema, ...withoutSchema } = preCutoverFixture(record);
  void schema;
  const unknown = verifyP13PreCutover(withoutSchema);
  assert.equal(unknown.status, "UNKNOWN");
  assert.ok(unknown.blockers.includes("required_schema_objects:UNKNOWN"));
  assert.throws(() => assertP13VerificationPassed(unknown));

  const failed = verifyP13PreCutover({ ...preCutoverFixture(record), persistence_authority: "local_postgres" });
  assert.equal(failed.status, "FAIL");
  assert.ok(failed.blockers.includes("authority_not_switched:FAIL"));
});

test("migration 008 and a clean projection outbox are mandatory pre-cutover", () => {
  const staleMigration = preCutoverFixture(checkpointTwoRecord());
  const stale = verifyP13PreCutover({
    ...staleMigration,
    schema: { ...staleMigration.schema!, expected_migration_version: "007", applied_migration_version: "007" },
  });
  assert.equal(stale.status, "FAIL");
  assert.ok(stale.blockers.includes("migration_version:FAIL"));

  const failedOutbox = evaluateP13Readiness(readinessFixture({ outbox_failed_count: 1 }), "post_import_authority");
  assert.equal(failedOutbox.status, "BLOCKED");
  assert.ok(failedOutbox.blockers.includes("outbox_failed_events_present"));
});

test("final verification mismatch blocks pre-cutover acceptance", () => {
  const evidence = preCutoverFixture(checkpointTwoRecord());
  const report = verifyP13PreCutover({
    ...evidence,
    final_data_verification: {
      ...evidence.final_data_verification!,
      source_snapshot_sha256: "c".repeat(64),
    },
  });
  assert.equal(report.status, "FAIL");
  assert.ok(report.blockers.includes("final_data_verification:FAIL"));
});

test("local authority cannot be armed before a bound passing pre-cutover verification", () => {
  const record = checkpointTwoRecord();
  assert.throws(() => armLocalAuthority(record, evaluateP13Readiness(readinessFixture(), "post_import_authority"), NOW));
  const report = verifyP13PreCutover(preCutoverFixture(record));
  const verified = recordPreCutoverVerification(record, report, NOW);
  assert.doesNotThrow(() => armLocalAuthority(verified, evaluateP13Readiness(readinessFixture(), "post_import_authority"), NOW));
});

test("post-cutover verifier proves local authority while Auth and Realtime remain external", () => {
  const record = postflightRecord();
  const report = verifyP13PostCutover(postCutoverFixture(record));
  assert.equal(report.status, "PASS");
  assert.deepEqual(report.blockers, []);
  const completed = recordPostCutoverVerification(record, report, NOW);
  assert.equal(completed.post_cutover_verification_sha256, report.evidence_sha256);
});

test("post-cutover verifier rejects an active legacy Supabase writer and incomplete runtime evidence", () => {
  const record = postflightRecord();
  const failed = verifyP13PostCutover({
    ...postCutoverFixture(record),
    legacy_supabase_application_writes: { status: "enabled", attempted_mutation_rejected_before_network: false },
  });
  assert.equal(failed.status, "FAIL");
  assert.ok(failed.blockers.includes("legacy_supabase_writes_disabled:FAIL"));

  const { realtime, ...withoutRealtime } = postCutoverFixture(record);
  void realtime;
  const unknown = verifyP13PostCutover(withoutRealtime);
  assert.equal(unknown.status, "UNKNOWN");
  assert.ok(unknown.blockers.includes("supabase_realtime_shadow:UNKNOWN"));
});

test("post-cutover verifier rejects failed outbox rows and persistent projector failure", () => {
  const record = postflightRecord();
  const failedOutbox = verifyP13PostCutover({
    ...postCutoverFixture(record),
    projection_outbox: {
      ...postCutoverFixture(record).projection_outbox!,
      total_count: 2,
      delivered_count: 1,
      failed_count: 1,
    },
  });
  assert.equal(failedOutbox.status, "FAIL");
  assert.ok(failedOutbox.blockers.includes("projection_outbox_healthy:FAIL"));

  const persistentFailure = verifyP13PostCutover({
    ...postCutoverFixture(record),
    projection_outbox: {
      ...postCutoverFixture(record).projection_outbox!,
      projector_status: "degraded",
      consecutive_batch_failures: 3,
      persistent_batch_failure: true,
      last_failure_at: "2026-09-15T02:59:59.000Z",
      last_failure_code: "OUTBOX_FETCH_FAILED",
    },
  });
  assert.equal(persistentFailure.status, "FAIL");
  assert.ok(persistentFailure.blockers.includes("projection_outbox_healthy:FAIL"));
});

test("post-cutover verifier binds local authority, dedicated database identity, and runtime role", () => {
  const record = postflightRecord();
  const wrongAuthority = verifyP13PostCutover({ ...postCutoverFixture(record), persistence_authority: "supabase" });
  assert.ok(wrongAuthority.blockers.includes("local_authority:FAIL"));
  for (const databaseIdentity of [
    { cluster: "16/main", port: 5433, database: "jhc_netops", endpoint: "127.0.0.1", runtime_role: "jhc_netops_app" },
    { cluster: "16/jhcnetops", port: 5433, database: "other", endpoint: "127.0.0.1", runtime_role: "jhc_netops_app" },
    { cluster: "16/jhcnetops", port: 5433, database: "jhc_netops", endpoint: "127.0.0.1", runtime_role: "postgres" },
  ]) {
    const report = verifyP13PostCutover({ ...postCutoverFixture(record), database_identity: databaseIdentity });
    assert.equal(report.status, "FAIL");
    assert.ok(report.blockers.includes("dedicated_database_identity:FAIL"));
  }
});

test("post-cutover verifier requires a fresh local runner and no active foreground work", () => {
  const record = postflightRecord();
  const staleRunner = verifyP13PostCutover({
    ...postCutoverFixture(record),
    runner: { persistence_authority: "local_postgres", health_status: "online", last_seen_at: "2026-09-15T02:59:00.000Z" },
  });
  assert.ok(staleRunner.blockers.includes("runner_local_authority_and_fresh_heartbeat:FAIL"));
  const activeWork = verifyP13PostCutover({
    ...postCutoverFixture(record),
    foreground_work: {
      active_count: 1,
      workflows: {
        diagnostic_jobs: 0, traffic_live_sessions: 0, network_health_ping_jobs: 1,
        network_discovery_sessions: 0, device_inspection_sessions: 0,
      },
    },
  });
  assert.ok(activeWork.blockers.includes("no_active_foreground_work:FAIL"));
});

test("rollback triggers distinguish simple rollback from reconciliation after unprojected local writes", () => {
  const simple = classifyP13CutoverDecision({
    triggers: ["application_read_failure"], checkpoint: "CHECKPOINT_3_LOCAL_ARMED_NO_WRITES",
    local_authoritative_write_count: 0, local_writers_frozen: true,
    all_local_writes_projected: false, shadow_parity_verified: false,
  });
  assert.equal(simple.action, "ROLLBACK_REQUIRED");
  assert.equal(simple.rollback?.disposition, "SIMPLE_PRE_AUTHORITY_ROLLBACK");

  const reconcile = classifyP13CutoverDecision({
    triggers: ["wrong_write_authority", "split_brain"], checkpoint: "CHECKPOINT_3_LOCAL_ARMED_NO_WRITES",
    local_authoritative_write_count: 2, local_writers_frozen: false,
    all_local_writes_projected: false, shadow_parity_verified: false,
  });
  assert.equal(reconcile.action, "RECONCILIATION_REQUIRED");
  assert.equal(reconcile.rollback?.disposition, "RECONCILIATION_REQUIRED");
});

test("out-of-order checkpoints and mismatched source evidence fail closed", () => {
  const target = loadP13Target("preflight", targetEnvironment("preflight"));
  const record = createP13CutoverRecord(target, NOW);
  assert.throws(() => recordFinalCapture(record, SHA, NOW));
  assert.throws(() => recordFinalImport(record, importEvidence(), NOW));
  assert.throws(() => assertP13CheckpointTransition("CHECKPOINT_0_PRE_FREEZE", "CHECKPOINT_2_LOCAL_IMPORTED_VERIFIED"));
  const ready = recordFreezeReadiness(record, evaluateP13Readiness(freezeReadinessFixture(), "pre_migration_freeze"), NOW);
  assert.throws(() => recordFinalCapture(ready, "not-a-hash", NOW));
});

test("rollback is simple before local writes and requires reconciliation after unprojected local writes", () => {
  assert.equal(assessP13Rollback({
    checkpoint: "CHECKPOINT_2_LOCAL_IMPORTED_VERIFIED", local_authoritative_write_count: 0,
    local_writers_frozen: false, all_local_writes_projected: false, shadow_parity_verified: false,
  }).disposition, "SIMPLE_PRE_AUTHORITY_ROLLBACK");
  assert.equal(assessP13Rollback({
    checkpoint: "CHECKPOINT_3_LOCAL_ARMED_NO_WRITES", local_authoritative_write_count: 1,
    local_writers_frozen: false, all_local_writes_projected: false, shadow_parity_verified: false,
  }).disposition, "RECONCILIATION_REQUIRED");
  assert.equal(assessP13Rollback({
    checkpoint: "CHECKPOINT_3_LOCAL_ARMED_NO_WRITES", local_authoritative_write_count: 1,
    local_writers_frozen: true, all_local_writes_projected: true, shadow_parity_verified: true,
  }).disposition, "COORDINATED_REVERSE_SWITCH");
});

test("P13 tooling is staged, source-only, and has no production-destructive command", () => {
  const source = readFileSync(new URL("../scripts/p13-cutover.ts", import.meta.url), "utf8");
  for (const stage of ["preflight", "freeze-check", "capture-final", "import-final", "verify-final", "pre-cutover-verify", "arm-local-authority", "postflight", "post-cutover-verify", "rollback-check"]) {
    assert.match(source, new RegExp(stage));
  }
  assert.doesNotMatch(source, /\b(?:DROP\s+DATABASE|DELETE\s+FROM|pm2\s+(?:stop|start)|supabase\s+functions\s+deploy|pg_ctlcluster)\b/i);
  assert.doesNotMatch(source, /console\.(?:log|error).*database_url/i);
});

test("operator runbook separates freeze, copy, verify, authority, smoke, and rollback without claiming execution", () => {
  const runbook = readFileSync(new URL("../../deploy/postgresql/p13/README.md", import.meta.url), "utf8");
  for (const section of ["Source preparation", "Pre-cutover", "Freeze", "Final copy", "Import final", "Verify", "Authority switch", "Smoke / postflight", "Rollback window"]) {
    assert.match(runbook, new RegExp(`## ${section}`));
  }
  assert.match(runbook, /PERSISTENCE_AUTHORITY=local_postgres/);
  assert.match(runbook, /16\/jhcnetops/);
  assert.match(runbook, /port `5433`/);
  assert.match(runbook, /never clears or deletes buffer content/i);
  assert.match(runbook, /never merge ambiguous\s+identities automatically/i);
  assert.match(runbook, /Supabase Auth and\s+Realtime remain in place/);
  assert.match(runbook, /jhc_netops_owner.*NOLOGIN/is);
  assert.match(runbook, /target\.execution_role = jhc_netops_owner/);
  assert.match(runbook, /pre-migration freeze evidence/is);
  assert.match(runbook, /post-import authority evidence/is);
  assert.doesNotMatch(runbook, /^\s*(?:psql\s|pg_restore\s|supabase\s+functions\s+deploy)/im);
});

test("operator runbook defines exact sequence, NetOps-only restart policy, acceptance states, and forbidden boundaries", () => {
  const runbook = readFileSync(new URL("../../deploy/postgresql/p13/README.md", import.meta.url), "utf8");
  for (const step of [
    "0. Preconditions", "1. Candidate immutable release", "2. Backup/checkpoint", "3. Preflight",
    "4. Resolve identity gate", "5. Drain/check active work", "6. Freeze writers", "7. Final copy/delta",
    "8. Final verification", "9. Arm local authority", "10. Deploy/switch current",
    "11. Restart only exact NetOps PM2 processes", "12. Technical smoke", "13. Browser smoke",
    "14. Observe rollback window", "15. Close cutover",
  ]) assert.match(runbook, new RegExp(`### ${escapeRegex(step)}`));
  for (const process of P13_NETOPS_PM2_PROCESSES) assert.match(runbook, new RegExp(`^pm2 restart ${process}$`, "m"));
  assert.doesNotMatch(runbook, /^\s*(?:pm2 (?:restart|stop|delete) all|pm2 kill|pkill\b|pg_ctlcluster\s+16\s+main)/m);
  for (const boundary of ["16/main", "port `5432`", "cf-tunnel", "diva-voice", "kiosk JHC new", "ollama-server"]) {
    assert.match(runbook, new RegExp(escapeRegex(boundary)));
  }
  for (const acceptance of ["P13 SOURCE READY", "P13 RUNTIME READY", "P13 CUTOVER PASS", "P13 ROLLBACK REQUIRED", "P13 DONE LIVE"]) {
    assert.match(runbook, new RegExp(acceptance));
  }
  assert.match(runbook, /### Final post-deploy closure procedure/);
  assert.match(runbook, /\(\s*\n\s*set -euo pipefail/);
  assert.match(runbook, /api\/application\/outbox\/health/);
  assert.match(runbook, /P13 POST-CUTOVER PASS/);
  assert.match(runbook, /P13 POST-CUTOVER FAIL/);
  assert.match(runbook, /P13_INTENDED_RELEASE_SHA/);
  assert.match(runbook, /full 40-character Git commit/i);
});

function readinessFixture(overrides: Partial<P13ReadinessEvidence> = {}): P13ReadinessEvidence {
  return {
    version: 1,
    source_checkpoint_identity: SHA,
    captured_at: "2026-09-15T01:00:00.000Z",
    source_writers_frozen: true,
    registration_frozen: true,
    cleanup_schedules_paused: true,
    asset_evidence_sync_enabled: false,
    application_local_adapter_ready: true,
    local_control_plane_ready: true,
    legacy_mutation_guards_ready: true,
    realtime_projection_ready: true,
    outbox_schema_ready: true,
    outbox_pending_count: 0,
    outbox_failed_count: 0,
    outbox_oldest_pending_age_ms: null,
    projector_allowlist_valid: true,
    projector_configured: true,
    unresolved_identity_blockers: 0,
    runner: { process_paused: true, heartbeat_writer_paused: true, active_probe_count: 0 },
    workflows: {
      diagnostic_jobs: [{ id: "diagnostic-1", status: "completed" }],
      traffic_live_sessions: [{ id: "traffic-1", status: "expired" }],
      network_health_ping_jobs: [{ id: "ping-1", status: "failed" }],
      network_discovery_sessions: [{ id: "discovery-1", status: "idle" }],
      device_inspection_sessions: [{ id: "inspection-1", status: "completed" }],
    },
    buffers: bufferFixtures(),
    ...overrides,
  };
}

function freezeReadinessFixture(overrides: Partial<P13ReadinessEvidence> = {}): P13ReadinessEvidence {
  return {
    version: 1,
    source_checkpoint_identity: SHA,
    captured_at: "2026-09-15T01:00:00.000Z",
    source_writers_frozen: true,
    registration_frozen: true,
    cleanup_schedules_paused: true,
    asset_evidence_sync_enabled: false,
    unresolved_identity_blockers: 0,
    runner: { process_paused: true, heartbeat_writer_paused: true, active_probe_count: 0 },
    workflows: readinessFixture().workflows,
    buffers: freezeBufferFixtures(),
    ...overrides,
  };
}

function bufferFixtures(): P13ReadinessEvidence["buffers"] {
  return P13_REQUIRED_BUFFERS.map((name, index) => ({
    name, state: name === "network-health-state" ? "checkpointed" as const : "drained" as const,
    pending_count: 0, producer_paused: true,
    sha256: String(index + 1).repeat(64),
    ...(name === "network-health-state" ? { replay_authority: "local_postgres" as const } : {}),
  }));
}

function freezeBufferFixtures(): P13ReadinessEvidence["buffers"] {
  return P13_FREEZE_BUFFERS.map((name, index) => ({
    name, state: name === "network-health-state" ? "checkpointed" as const : "drained" as const,
    pending_count: 0, producer_paused: true,
    sha256: String(index + 1).repeat(64),
    ...(name === "network-health-state" ? { replay_authority: "local_postgres" as const } : {}),
  }));
}

function targetEnvironment(action: P13Action, role: "jhc_netops_owner" | "jhc_netops_app" = "jhc_netops_owner"): Record<string, string> {
  return {
    P13_PHASE: "P13",
    P13_ACTION: action,
    P13_EXPECTED_CLUSTER: "16/jhcnetops",
    P13_EXPECTED_PORT: "5433",
    P13_EXPECTED_DATABASE: "jhc_netops",
    P13_EXPECTED_ROLE: role,
    P13_SOURCE_CHECKPOINT_IDENTITY: SHA,
    P13_OPERATOR_ACK: acknowledgementFor(action, SHA),
    P13_DATABASE_URL: `postgresql://${role}:fixture-password@127.0.0.1:5433/jhc_netops`,
  };
}

function importEvidence() {
  return {
    version: 1 as const,
    status: "PASS" as const,
    mode: "delta" as const,
    target_state_before: "accepted_s0_baseline" as const,
    source_checkpoint_identity: SHA,
    final_snapshot_sha256: SNAPSHOT_SHA,
    target: {
      cluster: "16/jhcnetops", port: 5433, database: "jhc_netops",
      execution_role: "jhc_netops_owner" as const,
    },
    tables: P12_TABLES.map(({ table }, index) => ({
      table,
      row_count: 0,
      artifact_sha256: String((index % 9) + 1).repeat(64),
      keyset_sha256: String(((index + 1) % 9) + 1).repeat(64),
      content_sha256: String(((index + 2) % 9) + 1).repeat(64),
    })),
    s1_parity: "PASS" as const,
    migration_versions: [7, 8] as const,
    outbox: {
      total_count: 0,
      pending_count: 0,
      failed_count: 0,
      watermark_count: 0,
      canary_count: 0,
      shadow_trigger_count: 16,
    },
    asset: {
      before_sha256: "e".repeat(64),
      after_sha256: "e".repeat(64),
      unchanged: true as const,
    },
  };
}

function checkpointTwoRecord() {
  const target = loadP13Target("preflight", targetEnvironment("preflight"));
  const readiness = evaluateP13Readiness(freezeReadinessFixture(), "pre_migration_freeze");
  let record = createP13CutoverRecord(target, NOW);
  record = recordFreezeReadiness(record, readiness, NOW);
  record = recordFinalCapture(record, SNAPSHOT_SHA, NOW);
  record = recordFinalImport(record, importEvidence(), NOW);
  return recordFinalVerification(record, importEvidence(), NOW);
}

function preCutoverFixture(record = checkpointTwoRecord()): P13PreCutoverEvidence {
  return {
    version: 1,
    captured_at: "2026-09-15T02:00:00.000Z",
    source_checkpoint_identity: SHA,
    cutover_record: record,
    database_identity: {
      cluster: "16/jhcnetops", port: 5433, database: "jhc_netops",
      endpoint: "127.0.0.1", runtime_role: "jhc_netops_app",
    },
    schema: {
      application_schema_objects: "PASS", asset_schema_objects: "PASS",
      projection_outbox_object: "PASS", cutover_canary_object: "PASS",
      expected_migration_version: "008", applied_migration_version: "008",
    },
    readiness: evaluateP13Readiness(readinessFixture(), "post_import_authority"),
    final_source_manifest: {
      status: "PASS", source_checkpoint_identity: SHA,
      snapshot_sha256: SNAPSHOT_SHA, manifest_sha256: "c".repeat(64),
    },
    final_import: importEvidence(),
    final_data_verification: {
      version: 1, status: "PASS", source_snapshot_sha256: SNAPSHOT_SHA,
      checks: Object.freeze(Object.fromEntries(P13_FINAL_DATA_CHECKS.map((name) => [name, "PASS"])) as
        Record<(typeof P13_FINAL_DATA_CHECKS)[number], "PASS">),
    },
    identity: { unresolved_blockers: 0, disposition_manifest_sha256: "d".repeat(64) },
    persistence_authority: "supabase",
    outbox_health: "PASS",
    projector_allowlist_valid: "PASS",
    projector_configured: "PASS",
    local_control_plane_adapters: "PASS",
  };
}

function postflightRecord() {
  const readiness = evaluateP13Readiness(readinessFixture(), "post_import_authority");
  let record = checkpointTwoRecord();
  record = recordPreCutoverVerification(record, verifyP13PreCutover(preCutoverFixture(record)), NOW);
  record = armLocalAuthority(record, readiness, NOW);
  return recordPostflight(record, { status: "PASS", local_authoritative_write_count: 1 }, NOW);
}

function postCutoverFixture(record = postflightRecord()): P13PostCutoverEvidence {
  return {
    version: 1,
    captured_at: "2026-09-15T03:00:00.000Z",
    source_checkpoint_identity: SHA,
    cutover_record: record,
    persistence_authority: "local_postgres",
    database_identity: {
      cluster: "16/jhcnetops", port: 5433, database: "jhc_netops",
      endpoint: "127.0.0.1", runtime_role: "jhc_netops_app",
    },
    local_backend_health: "PASS",
    local_control_plane_health: "PASS",
    runner: {
      persistence_authority: "local_postgres", health_status: "online",
      last_seen_at: "2026-09-15T02:59:55.000Z",
    },
    foreground_work: {
      active_count: 0,
      workflows: {
        diagnostic_jobs: 0, traffic_live_sessions: 0, network_health_ping_jobs: 0,
        network_discovery_sessions: 0, device_inspection_sessions: 0,
      },
    },
    write_canary: {
      status: "PASS", kind: "internal_cutover_canary", approved_application_path: true,
      local_commit_observed: true, cleanup_completed: true, application_domain_rows_created: 0,
    },
    legacy_supabase_application_writes: { status: "disabled", attempted_mutation_rejected_before_network: true },
    auth: { status: "PASS", authority: "supabase" },
    realtime: { status: "PASS", authority: "supabase_shadow" },
    split_brain: { status: "PASS", indication_count: 0 },
    release: { status: "PASS", expected_sha: "e".repeat(40), current_sha: "e".repeat(40) },
    pm2: {
      processes: P13_NETOPS_PM2_PROCESSES.map((name) => ({ name, status: "online" as const, stable: true })),
    },
    projection_outbox: {
      total_count: 1, delivered_count: 1, pending_count: 0, failed_count: 0,
      oldest_pending_age_ms: null, projector_status: "healthy", consecutive_batch_failures: 0,
      persistent_batch_failure: false, last_success_at: "2026-09-15T02:59:58.000Z",
      last_failure_at: null, last_failure_code: null,
    },
  };
}

function p12VerificationFixture(): P12VerificationReport {
  return {
    version: 1,
    run_id: "p13-final",
    generated_at: "2026-09-15T02:00:00.000Z",
    source_snapshot_sha256: SNAPSHOT_SHA,
    local_baseline_snapshot_id: "asset-baseline.dump",
    local_baseline_sha256: "f".repeat(64),
    overall_status: "PASS",
    tables: P12_TABLES.map(({ table }) => ({
      table, source_row_count: 1, target_row_count: 1,
      count_status: "PASS", pk_status: "PASS", duplicate_pk_count: 0,
      required_null_status: "PASS", required_null_count: 0,
      native_type_status: "PASS", native_type_mismatches: [],
      fingerprint_status: "PASS", source_sha256: "1".repeat(64), target_sha256: "1".repeat(64),
      source_chunks: [], target_chunks: [],
      timestamp_range: { source_min: null, source_max: null, target_min: null, target_max: null },
      representative_status: "PASS",
    })),
    unique_checks: [{ name: "profiles_pk", table: "profiles", status: "PASS", violation_count: 0 }],
    foreign_key_checks: [{ name: "profiles_auth", table: "profiles", status: "PASS", violation_count: 0 }],
    sequence: {
      status: "PASS", source_max_id: null, target_max_id: null,
      sequence_last_value: "1", sequence_is_called: false,
    },
    consistency: [{ name: "latest", status: "PASS", evidence_count: 0 }],
  };
}

function p12AuthFixture(): P12AuthReferenceReport {
  return {
    version: 1,
    run_id: "p13-final",
    generated_at: "2026-09-15T02:00:00.000Z",
    status: "PASS",
    reference_count: 0,
    unresolved_logical_reference_count: 0,
    validates_supabase_auth: false,
    references: [],
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
