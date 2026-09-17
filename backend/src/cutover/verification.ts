import { canonicalJson, sha256 } from "../data-migration/canonical.js";
import { P12_TABLES } from "../data-migration/contract.js";
import type { P12AuthReferenceReport } from "../data-migration/reporting.js";
import type { P12CheckStatus, P12VerificationReport } from "../data-migration/verification.js";
import { validP13ImportEvidenceDetails, type P13CutoverRecord, type P13ImportEvidence } from "./cutover.js";
import { assessP13Rollback, type P13RollbackAssessment } from "./checkpoint.js";
import type { P13ReadinessReport } from "./readiness.js";

export const P13_FINAL_DATA_CHECKS = Object.freeze([
  "table_counts",
  "fingerprints",
  "primary_and_unique_keys",
  "foreign_keys",
  "sequence_state",
  "latest_and_history",
  "representative_records",
  "auth_logical_references",
] as const);

export const P13_NETOPS_PM2_PROCESSES = Object.freeze([
  "jhc-netops-backend",
  "jhc-netops-frontend",
  "jhc-netops-runner",
] as const);

export type P13VerificationStatus = "PASS" | "FAIL" | "UNKNOWN";
export type P13FinalDataCheck = (typeof P13_FINAL_DATA_CHECKS)[number];

export type P13VerificationReport = Readonly<{
  version: 1;
  phase: "pre_cutover" | "post_cutover";
  status: P13VerificationStatus;
  source_checkpoint_identity: string;
  evidence_sha256: string;
  checks: readonly Readonly<{ name: string; status: P13VerificationStatus }>[];
  blockers: readonly string[];
}>;

export type P13FinalDataVerificationEvidence = Readonly<{
  version: 1;
  status: P13VerificationStatus;
  source_snapshot_sha256: string;
  checks: Readonly<Record<P13FinalDataCheck, P13VerificationStatus>>;
}>;

export type P13PreCutoverEvidence = Readonly<{
  version: 1;
  captured_at: string;
  source_checkpoint_identity: string;
  cutover_record: P13CutoverRecord;
  database_identity?: Readonly<{
    cluster?: string;
    port?: number;
    database?: string;
    endpoint?: string;
    runtime_role?: string;
  }>;
  schema?: Readonly<{
    application_schema_objects?: P13VerificationStatus;
    asset_schema_objects?: P13VerificationStatus;
    projection_outbox_object?: P13VerificationStatus;
    cutover_canary_object?: P13VerificationStatus;
    expected_migration_version?: string;
    applied_migration_version?: string;
  }>;
  readiness?: P13ReadinessReport;
  final_source_manifest?: Readonly<{
    status?: P13VerificationStatus;
    source_checkpoint_identity?: string;
    snapshot_sha256?: string;
    manifest_sha256?: string;
  }>;
  final_import?: P13ImportEvidence;
  final_data_verification?: P13FinalDataVerificationEvidence;
  identity?: Readonly<{
    unresolved_blockers?: number;
    disposition_manifest_sha256?: string;
  }>;
  persistence_authority?: "supabase" | "local_postgres";
  outbox_health?: P13VerificationStatus;
  projector_allowlist_valid?: P13VerificationStatus;
  projector_configured?: P13VerificationStatus;
  local_control_plane_adapters?: P13VerificationStatus;
}>;

export type P13PostCutoverEvidence = Readonly<{
  version: 1;
  captured_at: string;
  source_checkpoint_identity: string;
  cutover_record: P13CutoverRecord;
  persistence_authority?: "supabase" | "local_postgres";
  local_backend_health?: P13VerificationStatus;
  local_control_plane_health?: P13VerificationStatus;
  write_canary?: Readonly<{
    status?: P13VerificationStatus;
    kind?: "internal_cutover_canary";
    approved_application_path?: boolean;
    local_commit_observed?: boolean;
    cleanup_completed?: boolean;
    application_domain_rows_created?: number;
  }>;
  legacy_supabase_application_writes?: Readonly<{
    status?: "disabled" | "enabled" | "unknown";
    attempted_mutation_rejected_before_network?: boolean;
  }>;
  auth?: Readonly<{ status?: P13VerificationStatus; authority?: "supabase" }>;
  realtime?: Readonly<{ status?: P13VerificationStatus; authority?: "supabase_shadow" }>;
  split_brain?: Readonly<{ status?: P13VerificationStatus; indication_count?: number }>;
  release?: Readonly<{ status?: P13VerificationStatus; expected_sha?: string; current_sha?: string }>;
  pm2?: Readonly<{
    processes?: readonly Readonly<{ name?: string; status?: "online" | "stopped" | "errored"; stable?: boolean }>[];
  }>;
  projection_outbox?: Readonly<{
    status?: P13VerificationStatus;
    failed_count?: number;
  }>;
}>;

export type P13RollbackTrigger =
  | "local_verification_mismatch"
  | "application_read_failure"
  | "wrong_write_authority"
  | "legacy_supabase_writer_active"
  | "runtime_instability"
  | "auth_failure"
  | "realtime_failure"
  | "split_brain";

export type P13CutoverDecision = Readonly<{
  action: "CONTINUE" | "ROLLBACK_REQUIRED" | "RECONCILIATION_REQUIRED";
  triggers: readonly P13RollbackTrigger[];
  rollback: P13RollbackAssessment | null;
}>;

export class P13VerificationError extends Error {
  readonly code = "P13_VERIFICATION_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "P13VerificationError";
  }
}

export function buildP13FinalDataVerification(options: Readonly<{
  verification: P12VerificationReport;
  auth: P12AuthReferenceReport;
}>): P13FinalDataVerificationEvidence {
  const verification = options.verification;
  const auth = options.auth;
  const actualTables = verification.tables.map(({ table }) => table);
  const tableSetComplete = actualTables.length === P12_TABLES.length && new Set(actualTables).size === actualTables.length &&
    P12_TABLES.every(({ table }) => actualTables.includes(table));
  const checks: Record<P13FinalDataCheck, P13VerificationStatus> = {
    table_counts: aggregate([tableSetComplete ? "PASS" : "FAIL", ...verification.tables.map(({ count_status }) => count_status)]),
    fingerprints: aggregate(verification.tables.map(({ fingerprint_status }) => fingerprint_status)),
    primary_and_unique_keys: aggregate([
      ...verification.tables.map(({ pk_status }) => pk_status),
      ...verification.unique_checks.map(({ status }) => status),
    ]),
    foreign_keys: aggregate(verification.foreign_key_checks.map(({ status }) => status)),
    sequence_state: fromP12Status(verification.sequence.status),
    latest_and_history: aggregate(verification.consistency.map(({ status }) => status)),
    representative_records: aggregate(verification.tables.map(({ representative_status }) => representative_status)),
    auth_logical_references: auth.run_id !== verification.run_id ? "FAIL" :
      auth.status === "PASS" && auth.unresolved_logical_reference_count === 0 ? "PASS" :
      auth.status === "FAIL" ? "FAIL" : "UNKNOWN",
  };
  const status = aggregate([verification.overall_status, ...Object.values(checks)]);
  return Object.freeze({
    version: 1,
    status,
    source_snapshot_sha256: verification.source_snapshot_sha256,
    checks: Object.freeze(checks),
  });
}

export function verifyP13PreCutover(evidence: P13PreCutoverEvidence): P13VerificationReport {
  validateHeader(evidence);
  const record = evidence.cutover_record;
  const snapshotSha = evidence.final_source_manifest?.snapshot_sha256;
  const checks = [
    check("dedicated_database_identity", databaseIdentityStatus(evidence.database_identity)),
    check("required_schema_objects", schemaObjectsStatus(evidence.schema)),
    check("migration_version", migrationStatus(evidence.schema)),
    check("active_job_and_buffer_readiness", readinessStatus(evidence.readiness, evidence.source_checkpoint_identity)),
    check("final_source_manifest", finalManifestStatus(evidence.final_source_manifest, evidence.source_checkpoint_identity)),
    check("final_import", importStatus(evidence.final_import, evidence.source_checkpoint_identity, snapshotSha)),
    check("final_data_verification", finalDataStatus(evidence.final_data_verification, snapshotSha)),
    check("identity_dispositions", identityStatus(evidence.identity)),
    check("authority_not_switched", evidence.persistence_authority === undefined ? "UNKNOWN" :
      evidence.persistence_authority === "supabase" ? "PASS" : "FAIL"),
    check("checkpoint_2_verified", preCutoverRecordStatus(record, evidence.source_checkpoint_identity, snapshotSha)),
    check("outbox_schema_ready", statusValue(evidence.outbox_health)),
    check("projector_allowlist_valid", statusValue(evidence.projector_allowlist_valid)),
    check("projector_configured", statusValue(evidence.projector_configured)),
    check("local_control_plane_adapters", statusValue(evidence.local_control_plane_adapters)),
  ];
  return report("pre_cutover", evidence.source_checkpoint_identity, evidence, checks);
}

export function verifyP13PostCutover(evidence: P13PostCutoverEvidence): P13VerificationReport {
  validateHeader(evidence);
  const checks = [
    check("local_authority", evidence.persistence_authority === undefined ? "UNKNOWN" :
      evidence.persistence_authority === "local_postgres" ? "PASS" : "FAIL"),
    check("checkpoint_3_armed", postCutoverRecordStatus(evidence.cutover_record, evidence.source_checkpoint_identity)),
    check("local_backend_health", statusValue(evidence.local_backend_health)),
    check("local_control_plane_health", statusValue(evidence.local_control_plane_health)),
    check("approved_path_write_canary", writeCanaryStatus(evidence.write_canary)),
    check("legacy_supabase_writes_disabled", legacyWriterStatus(evidence.legacy_supabase_application_writes)),
    check("supabase_auth_external", externalStatus(evidence.auth, "supabase")),
    check("supabase_realtime_shadow", externalStatus(evidence.realtime, "supabase_shadow")),
    check("no_split_brain", splitBrainStatus(evidence.split_brain)),
    check("intended_release", releaseStatus(evidence.release)),
    check("netops_pm2_stable", pm2Status(evidence.pm2)),
    check("projection_outbox_healthy", outboxStatus(evidence.projection_outbox)),
  ];
  return report("post_cutover", evidence.source_checkpoint_identity, evidence, checks);
}

export function classifyP13CutoverDecision(options: Readonly<{
  triggers: readonly P13RollbackTrigger[];
  checkpoint: P13CutoverRecord["checkpoint"];
  local_authoritative_write_count: number;
  local_writers_frozen: boolean;
  all_local_writes_projected: boolean;
  shadow_parity_verified: boolean;
}>): P13CutoverDecision {
  const triggers = Object.freeze([...new Set(options.triggers)].sort()) as readonly P13RollbackTrigger[];
  if (!triggers.length) return Object.freeze({ action: "CONTINUE", triggers, rollback: null });
  const rollback = assessP13Rollback(options);
  return Object.freeze({
    action: rollback.eligible ? "ROLLBACK_REQUIRED" : "RECONCILIATION_REQUIRED",
    triggers,
    rollback,
  });
}

export function assertP13VerificationPassed(reportValue: P13VerificationReport): void {
  if (reportValue.status !== "PASS") {
    throw new P13VerificationError("P13 verification contains failed or unknown checks");
  }
}

function databaseIdentityStatus(value: P13PreCutoverEvidence["database_identity"]): P13VerificationStatus {
  if (!value || value.cluster === undefined || value.port === undefined || value.database === undefined ||
      value.endpoint === undefined || value.runtime_role === undefined) return "UNKNOWN";
  return value.cluster === "16/jhcnetops" && value.port === 5433 && value.database === "jhc_netops" &&
    ["127.0.0.1", "localhost", "::1"].includes(value.endpoint) && value.runtime_role === "jhc_netops_app" ? "PASS" : "FAIL";
}

function schemaObjectsStatus(value: P13PreCutoverEvidence["schema"]): P13VerificationStatus {
  if (!value) return "UNKNOWN";
  return aggregate([
    statusValue(value.application_schema_objects),
    statusValue(value.asset_schema_objects),
    statusValue(value.projection_outbox_object),
    statusValue(value.cutover_canary_object),
  ]);
}

function migrationStatus(value: P13PreCutoverEvidence["schema"]): P13VerificationStatus {
  if (!value?.expected_migration_version || !value.applied_migration_version) return "UNKNOWN";
  if (!boundedText(value.expected_migration_version, 128) || !boundedText(value.applied_migration_version, 128)) return "FAIL";
  return value.expected_migration_version === "008" && value.applied_migration_version === "008" ? "PASS" : "FAIL";
}

function readinessStatus(value: P13ReadinessReport | undefined, identity: string): P13VerificationStatus {
  if (!value) return "UNKNOWN";
  return value.gate === "post_import_authority" && value.status === "PASS" &&
    value.source_checkpoint_identity === identity && hash(value.evidence_sha256) ? "PASS" : "FAIL";
}

function finalManifestStatus(
  value: P13PreCutoverEvidence["final_source_manifest"],
  identity: string,
): P13VerificationStatus {
  if (!value || value.status === undefined || value.source_checkpoint_identity === undefined ||
      value.snapshot_sha256 === undefined || value.manifest_sha256 === undefined) return "UNKNOWN";
  return value.status === "PASS" && value.source_checkpoint_identity === identity && hash(value.snapshot_sha256) &&
    hash(value.manifest_sha256) ? "PASS" : "FAIL";
}

function importStatus(
  value: P13ImportEvidence | undefined,
  identity: string,
  snapshotSha: string | undefined,
): P13VerificationStatus {
  if (!value || !snapshotSha) return "UNKNOWN";
  return value.status === "PASS" && value.source_checkpoint_identity === identity && value.final_snapshot_sha256 === snapshotSha &&
    value.target.cluster === "16/jhcnetops" && value.target.port === 5433 && value.target.database === "jhc_netops" &&
    value.target.execution_role === "jhc_netops_owner" && validP13ImportEvidenceDetails(value) ? "PASS" : "FAIL";
}

function finalDataStatus(value: P13FinalDataVerificationEvidence | undefined, snapshotSha: string | undefined): P13VerificationStatus {
  if (!value || !snapshotSha) return "UNKNOWN";
  if (value.version !== 1 || value.source_snapshot_sha256 !== snapshotSha ||
      P13_FINAL_DATA_CHECKS.some((name) => !["PASS", "FAIL", "UNKNOWN"].includes(value.checks?.[name]))) return "FAIL";
  return value.status === "PASS" && P13_FINAL_DATA_CHECKS.every((name) => value.checks[name] === "PASS") ? "PASS" :
    value.status === "FAIL" || P13_FINAL_DATA_CHECKS.some((name) => value.checks[name] === "FAIL") ? "FAIL" : "UNKNOWN";
}

function identityStatus(value: P13PreCutoverEvidence["identity"]): P13VerificationStatus {
  if (!value || value.unresolved_blockers === undefined || value.disposition_manifest_sha256 === undefined) return "UNKNOWN";
  if (!Number.isSafeInteger(value.unresolved_blockers) || value.unresolved_blockers < 0 || !hash(value.disposition_manifest_sha256)) return "FAIL";
  return value.unresolved_blockers === 0 ? "PASS" : "FAIL";
}

function preCutoverRecordStatus(
  record: P13CutoverRecord,
  identity: string,
  snapshotSha: string | undefined,
): P13VerificationStatus {
  return record?.checkpoint === "CHECKPOINT_2_LOCAL_IMPORTED_VERIFIED" && record.persistence_authority === "supabase" &&
    record.source_checkpoint_identity === identity && record.final_import_verified && record.final_parity_verified &&
    record.final_snapshot_sha256 === snapshotSha ? "PASS" : "FAIL";
}

function postCutoverRecordStatus(record: P13CutoverRecord, identity: string): P13VerificationStatus {
  return record?.checkpoint === "CHECKPOINT_3_LOCAL_ARMED_NO_WRITES" && record.persistence_authority === "local_postgres" &&
    record.source_checkpoint_identity === identity && record.postflight_passed &&
    record.target.cluster === "16/jhcnetops" && record.target.port === 5433 && record.target.database === "jhc_netops" ? "PASS" : "FAIL";
}

function writeCanaryStatus(value: P13PostCutoverEvidence["write_canary"]): P13VerificationStatus {
  if (!value || value.status === undefined || value.kind === undefined || value.approved_application_path === undefined ||
      value.local_commit_observed === undefined || value.cleanup_completed === undefined ||
      value.application_domain_rows_created === undefined) return "UNKNOWN";
  return value.status === "PASS" && value.kind === "internal_cutover_canary" && value.approved_application_path &&
    value.local_commit_observed && value.cleanup_completed && value.application_domain_rows_created === 0 ? "PASS" : "FAIL";
}

function legacyWriterStatus(value: P13PostCutoverEvidence["legacy_supabase_application_writes"]): P13VerificationStatus {
  if (!value || value.status === undefined || value.attempted_mutation_rejected_before_network === undefined) return "UNKNOWN";
  return value.status === "disabled" && value.attempted_mutation_rejected_before_network ? "PASS" : "FAIL";
}

function externalStatus<T extends "supabase" | "supabase_shadow">(
  value: Readonly<{ status?: P13VerificationStatus; authority?: T }> | undefined,
  expected: T,
): P13VerificationStatus {
  if (!value || value.status === undefined || value.authority === undefined) return "UNKNOWN";
  return value.status === "PASS" && value.authority === expected ? "PASS" : value.status === "UNKNOWN" ? "UNKNOWN" : "FAIL";
}

function splitBrainStatus(value: P13PostCutoverEvidence["split_brain"]): P13VerificationStatus {
  if (!value || value.status === undefined || value.indication_count === undefined) return "UNKNOWN";
  if (!Number.isSafeInteger(value.indication_count) || value.indication_count < 0) return "FAIL";
  return value.status === "PASS" && value.indication_count === 0 ? "PASS" : "FAIL";
}

function releaseStatus(value: P13PostCutoverEvidence["release"]): P13VerificationStatus {
  if (!value || value.status === undefined || !value.expected_sha || !value.current_sha) return "UNKNOWN";
  if (!hash(value.expected_sha) || !hash(value.current_sha)) return "FAIL";
  return value.status === "PASS" && value.expected_sha === value.current_sha ? "PASS" : "FAIL";
}

function pm2Status(value: P13PostCutoverEvidence["pm2"]): P13VerificationStatus {
  if (!value?.processes) return "UNKNOWN";
  const names = value.processes.map(({ name }) => name);
  if (value.processes.length !== P13_NETOPS_PM2_PROCESSES.length || new Set(names).size !== names.length ||
      !P13_NETOPS_PM2_PROCESSES.every((name) => names.includes(name))) return "FAIL";
  return value.processes.every(({ status, stable }) => status === "online" && stable === true) ? "PASS" : "FAIL";
}

function outboxStatus(value: P13PostCutoverEvidence["projection_outbox"]): P13VerificationStatus {
  if (!value || value.status === undefined || value.failed_count === undefined) return "UNKNOWN";
  if (!Number.isSafeInteger(value.failed_count) || value.failed_count < 0) return "FAIL";
  return value.status === "PASS" && value.failed_count === 0 ? "PASS" : "FAIL";
}

function report(
  phase: P13VerificationReport["phase"],
  identity: string,
  evidence: P13PreCutoverEvidence | P13PostCutoverEvidence,
  checks: readonly P13VerificationReport["checks"][number][],
): P13VerificationReport {
  const status = aggregate(checks.map(({ status: checkStatus }) => checkStatus));
  return Object.freeze({
    version: 1,
    phase,
    status,
    source_checkpoint_identity: identity,
    evidence_sha256: sha256(canonicalJson(withoutUndefined(evidence))),
    checks: Object.freeze([...checks]),
    blockers: Object.freeze(checks.filter(({ status: checkStatus }) => checkStatus !== "PASS").map(({ name, status: checkStatus }) => `${name}:${checkStatus}`)),
  });
}

function check(name: string, status: P13VerificationStatus): P13VerificationReport["checks"][number] {
  return Object.freeze({ name, status });
}

function aggregate(statuses: readonly (P12CheckStatus | P13VerificationStatus)[]): P13VerificationStatus {
  const normalized = statuses.map(fromP12Status);
  if (normalized.includes("FAIL")) return "FAIL";
  return normalized.length > 0 && normalized.every((status) => status === "PASS") ? "PASS" : "UNKNOWN";
}

function fromP12Status(value: P12CheckStatus | P13VerificationStatus): P13VerificationStatus {
  return value === "WARN" ? "UNKNOWN" : value;
}

function statusValue(value: unknown): P13VerificationStatus {
  return value === "PASS" || value === "FAIL" || value === "UNKNOWN" ? value : "UNKNOWN";
}

function validateHeader(value: { version: number; captured_at: string; source_checkpoint_identity: string }): void {
  if (value.version !== 1 || !Number.isFinite(Date.parse(value.captured_at)) || !hash(value.source_checkpoint_identity)) {
    throw new P13VerificationError("P13 verification evidence header is invalid");
  }
}

function hash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function boundedText(value: string, maximum: number): boolean {
  return value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
}

function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Readonly<Record<string, unknown>>)
      .filter(([, nested]) => nested !== undefined)
      .map(([key, nested]) => [key, withoutUndefined(nested)]));
  }
  return value;
}
