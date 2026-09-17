import type { PersistenceAuthority } from "../persistence/authority.js";
import {
  assertP13CheckpointTransition,
  P13_CHECKPOINTS,
  type P13Checkpoint,
  type P13RollbackAssessment,
  assessP13Rollback,
} from "./checkpoint.js";
import type { P13ReadinessReport } from "./readiness.js";
import type { P13Target } from "./target.js";
import type { P13VerificationReport } from "./verification.js";

export type P13CutoverRecord = Readonly<{
  version: 1;
  checkpoint: P13Checkpoint;
  persistence_authority: PersistenceAuthority;
  source_checkpoint_identity: string;
  target: Readonly<{
    cluster: "16/jhcnetops";
    port: 5433;
    database: "jhc_netops";
  }>;
  created_at: string;
  updated_at: string;
  freeze_readiness_evidence_sha256: string | null;
  authority_readiness_evidence_sha256: string | null;
  final_snapshot_sha256: string | null;
  final_import_verified: boolean;
  final_parity_verified: boolean;
  pre_cutover_verification_sha256: string | null;
  post_cutover_verification_sha256: string | null;
  local_authoritative_write_count: number;
  postflight_passed: boolean;
  canary_cutover_identity: string | null;
  canary_id: string | null;
}>;

export type P13ImportEvidence = Readonly<{
  version: 1;
  status: "PASS" | "FAIL";
  source_checkpoint_identity: string;
  final_snapshot_sha256: string;
  target: Readonly<{ cluster: string; port: number; database: string }>;
}>;

export type P13VerificationEvidence = P13ImportEvidence;

export class P13CutoverError extends Error {
  readonly code = "P13_CUTOVER_BLOCKED";

  constructor(message: string) {
    super(message);
    this.name = "P13CutoverError";
  }
}

const SAFE_FAILURE_MESSAGES = Object.freeze({
  P13_CUTOVER_BLOCKED: "P13 cutover stage is blocked by its evidence contract",
  P13_READINESS_INVALID: "P13 readiness evidence is invalid",
  P13_CHECKPOINT_INVALID: "P13 checkpoint transition is invalid",
  P13_TARGET_INVALID: "P13 production target guard rejected the action",
  P13_VERIFICATION_INVALID: "P13 verification evidence is invalid",
} as const);

export function safeP13Failure(error: unknown): Readonly<{ code: string; message: string }> {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "P13_TOOL_FAILED";
  if (Object.hasOwn(SAFE_FAILURE_MESSAGES, code)) {
    return Object.freeze({
      code,
      message: SAFE_FAILURE_MESSAGES[code as keyof typeof SAFE_FAILURE_MESSAGES],
    });
  }
  return Object.freeze({ code: "P13_TOOL_FAILED", message: "P13 stage failed safely" });
}

export function createP13CutoverRecord(target: P13Target, now: () => Date = () => new Date()): P13CutoverRecord {
  const timestamp = now().toISOString();
  return Object.freeze({
    version: 1,
    checkpoint: "CHECKPOINT_0_PRE_FREEZE",
    persistence_authority: "supabase",
    source_checkpoint_identity: target.source_checkpoint_identity,
    target: Object.freeze({ cluster: target.cluster, port: target.port, database: target.database }),
    created_at: timestamp,
    updated_at: timestamp,
    freeze_readiness_evidence_sha256: null,
    authority_readiness_evidence_sha256: null,
    final_snapshot_sha256: null,
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

export function recordFreezeReadiness(
  record: P13CutoverRecord,
  readiness: P13ReadinessReport,
  now: () => Date = () => new Date(),
): P13CutoverRecord {
  assertRecord(record);
  if (record.checkpoint !== "CHECKPOINT_0_PRE_FREEZE" || readiness.status !== "PASS" ||
      readiness.source_checkpoint_identity !== record.source_checkpoint_identity || readiness.evidence_sha256.length !== 64) {
    throw new P13CutoverError("P13 freeze readiness is blocked");
  }
  return update(record, { freeze_readiness_evidence_sha256: readiness.evidence_sha256 }, now);
}

export function recordFinalCapture(
  record: P13CutoverRecord,
  snapshotSha256: string,
  now: () => Date = () => new Date(),
): P13CutoverRecord {
  assertRecord(record);
  if (!record.freeze_readiness_evidence_sha256 || !/^[0-9a-f]{64}$/.test(snapshotSha256)) {
    throw new P13CutoverError("P13 final snapshot identity is invalid or freeze evidence is missing");
  }
  assertP13CheckpointTransition(record.checkpoint, "CHECKPOINT_1_FINAL_SOURCE_CAPTURED");
  return update(record, {
    checkpoint: "CHECKPOINT_1_FINAL_SOURCE_CAPTURED",
    final_snapshot_sha256: snapshotSha256,
  }, now);
}

export function recordFinalImport(
  record: P13CutoverRecord,
  evidence: P13ImportEvidence,
  now: () => Date = () => new Date(),
): P13CutoverRecord {
  assertRecord(record);
  assertEvidence(record, evidence, "import");
  if (record.checkpoint !== "CHECKPOINT_1_FINAL_SOURCE_CAPTURED") {
    throw new P13CutoverError("P13 final import is out of order");
  }
  return update(record, { final_import_verified: true }, now);
}

export function recordFinalVerification(
  record: P13CutoverRecord,
  evidence: P13VerificationEvidence,
  now: () => Date = () => new Date(),
): P13CutoverRecord {
  assertRecord(record);
  assertEvidence(record, evidence, "verification");
  if (record.checkpoint !== "CHECKPOINT_1_FINAL_SOURCE_CAPTURED" || !record.final_import_verified) {
    throw new P13CutoverError("P13 verification requires a recorded final import");
  }
  assertP13CheckpointTransition(record.checkpoint, "CHECKPOINT_2_LOCAL_IMPORTED_VERIFIED");
  return update(record, {
    checkpoint: "CHECKPOINT_2_LOCAL_IMPORTED_VERIFIED",
    final_parity_verified: true,
  }, now);
}

export function armLocalAuthority(
  record: P13CutoverRecord,
  readiness: P13ReadinessReport,
  now: () => Date = () => new Date(),
): P13CutoverRecord {
  assertRecord(record);
  if (record.checkpoint !== "CHECKPOINT_2_LOCAL_IMPORTED_VERIFIED" || !record.final_parity_verified ||
      !record.pre_cutover_verification_sha256 ||
      readiness.status !== "PASS" || readiness.source_checkpoint_identity !== record.source_checkpoint_identity) {
    throw new P13CutoverError("P13 local authority cannot be armed without fresh passing freeze evidence and final parity");
  }
  assertP13CheckpointTransition(record.checkpoint, "CHECKPOINT_3_LOCAL_ARMED_NO_WRITES");
  return update(record, {
    checkpoint: "CHECKPOINT_3_LOCAL_ARMED_NO_WRITES",
    persistence_authority: "local_postgres",
    local_authoritative_write_count: 0,
    authority_readiness_evidence_sha256: readiness.evidence_sha256,
  }, now);
}

export function recordPreCutoverVerification(
  record: P13CutoverRecord,
  verification: P13VerificationReport,
  now: () => Date = () => new Date(),
): P13CutoverRecord {
  assertRecord(record);
  if (record.checkpoint !== "CHECKPOINT_2_LOCAL_IMPORTED_VERIFIED" || record.persistence_authority !== "supabase" ||
      verification.phase !== "pre_cutover" || verification.status !== "PASS" ||
      verification.source_checkpoint_identity !== record.source_checkpoint_identity || !validOptionalHash(verification.evidence_sha256)) {
    throw new P13CutoverError("P13 pre-cutover verification is not acceptable");
  }
  return update(record, { pre_cutover_verification_sha256: verification.evidence_sha256 }, now);
}

export function recordPostflight(
  record: P13CutoverRecord,
  evidence: Readonly<{ status: "PASS" | "FAIL"; local_authoritative_write_count: number }>,
  now: () => Date = () => new Date(),
): P13CutoverRecord {
  assertRecord(record);
  if (record.checkpoint !== "CHECKPOINT_3_LOCAL_ARMED_NO_WRITES" || evidence.status !== "PASS" ||
      !Number.isSafeInteger(evidence.local_authoritative_write_count) || evidence.local_authoritative_write_count < 0) {
    throw new P13CutoverError("P13 postflight evidence is invalid");
  }
  return update(record, {
    local_authoritative_write_count: evidence.local_authoritative_write_count,
    postflight_passed: true,
  }, now);
}

export function recordPostCutoverVerification(
  record: P13CutoverRecord,
  verification: P13VerificationReport,
  now: () => Date = () => new Date(),
): P13CutoverRecord {
  assertRecord(record);
  if (record.checkpoint !== "CHECKPOINT_3_LOCAL_ARMED_NO_WRITES" || !record.postflight_passed ||
      verification.phase !== "post_cutover" || verification.status !== "PASS" ||
      verification.source_checkpoint_identity !== record.source_checkpoint_identity || !validOptionalHash(verification.evidence_sha256)) {
    throw new P13CutoverError("P13 post-cutover verification is not acceptable");
  }
  return update(record, { post_cutover_verification_sha256: verification.evidence_sha256 }, now);
}

export function recordCanaryWrite(
  record: P13CutoverRecord,
  canaryIdentity: string,
  canaryId: string,
  now: () => Date = () => new Date(),
): P13CutoverRecord {
  assertRecord(record);
  if (record.checkpoint !== "CHECKPOINT_3_LOCAL_ARMED_NO_WRITES" || !record.postflight_passed) {
    throw new P13CutoverError("P13 canary write can only be recorded after postflight");
  }
  return update(record, { canary_cutover_identity: canaryIdentity, canary_id: canaryId }, now);
}

export function recordCanaryVerified(
  record: P13CutoverRecord,
  now: () => Date = () => new Date(),
): P13CutoverRecord {
  assertRecord(record);
  return update(record, {}, now);
}

export function recordCanaryCleanup(
  record: P13CutoverRecord,
  now: () => Date = () => new Date(),
): P13CutoverRecord {
  assertRecord(record);
  return update(record, {}, now);
}

export function rollbackCheck(
  record: P13CutoverRecord,
  evidence: Readonly<{
    local_writers_frozen: boolean;
    all_local_writes_projected: boolean;
    shadow_parity_verified: boolean;
  }>,
): P13RollbackAssessment {
  assertRecord(record);
  return assessP13Rollback({
    checkpoint: record.checkpoint,
    local_authoritative_write_count: record.local_authoritative_write_count,
    ...evidence,
  });
}

export function parseP13CutoverRecord(value: unknown): P13CutoverRecord {
  assertRecord(value);
  return Object.freeze(value);
}

function assertEvidence(record: P13CutoverRecord, evidence: P13ImportEvidence, label: string): void {
  if (evidence?.version !== 1 || evidence.status !== "PASS" ||
      evidence.source_checkpoint_identity !== record.source_checkpoint_identity ||
      evidence.final_snapshot_sha256 !== record.final_snapshot_sha256 ||
      evidence.target?.cluster !== record.target.cluster || evidence.target.port !== record.target.port ||
      evidence.target.database !== record.target.database) {
    throw new P13CutoverError(`P13 ${label} evidence does not match the guarded target/checkpoint`);
  }
}

function assertRecord(value: unknown): asserts value is P13CutoverRecord {
  const record = value as Partial<P13CutoverRecord> | null;
  if (!record || record.version !== 1 || !record.target || record.target.cluster !== "16/jhcnetops" ||
      record.target.port !== 5433 || record.target.database !== "jhc_netops" ||
      !P13_CHECKPOINTS.includes(record.checkpoint as P13Checkpoint) ||
      !/^[0-9a-f]{64}$/.test(record.source_checkpoint_identity ?? "") ||
      !["supabase", "local_postgres"].includes(record.persistence_authority ?? "") ||
      !Number.isSafeInteger(record.local_authoritative_write_count) || (record.local_authoritative_write_count ?? -1) < 0 ||
      typeof record.final_import_verified !== "boolean" || typeof record.final_parity_verified !== "boolean" ||
      typeof record.postflight_passed !== "boolean" || !validOptionalHash(record.freeze_readiness_evidence_sha256) ||
      !validOptionalHash(record.authority_readiness_evidence_sha256) || !validOptionalHash(record.final_snapshot_sha256) ||
      !validOptionalHash(record.pre_cutover_verification_sha256) || !validOptionalHash(record.post_cutover_verification_sha256) ||
      !validTimestamp(record.created_at) || !validTimestamp(record.updated_at) ||
      (record.canary_cutover_identity !== null && typeof record.canary_cutover_identity !== "string") ||
      (record.canary_id !== null && typeof record.canary_id !== "string") ||
      (record.persistence_authority === "local_postgres" && record.checkpoint !== "CHECKPOINT_3_LOCAL_ARMED_NO_WRITES") ||
      (record.checkpoint === "CHECKPOINT_3_LOCAL_ARMED_NO_WRITES" && record.persistence_authority !== "local_postgres")) {
    throw new P13CutoverError("P13 cutover record is invalid");
  }
}

function validOptionalHash(value: unknown): boolean {
  return value === null || (typeof value === "string" && /^[0-9a-f]{64}$/.test(value));
}

function validTimestamp(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function update(
  record: P13CutoverRecord,
  changes: Partial<P13CutoverRecord>,
  now: () => Date,
): P13CutoverRecord {
  return Object.freeze({ ...record, ...changes, updated_at: now().toISOString() });
}
