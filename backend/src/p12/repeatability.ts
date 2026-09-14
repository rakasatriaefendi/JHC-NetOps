import { canonicalJson, sha256 } from "./canonical.js";
import { P12_TABLES } from "./contract.js";
import type { P12ActiveStateReport, P12AuthReferenceReport, P12RunSummary } from "./reporting.js";
import type { P12ReconciliationReport } from "./reconciliation.js";
import type { P12VerificationReport } from "./verification.js";

export type P12RunOutcome = Readonly<{
  summary: P12RunSummary;
  verification: P12VerificationReport;
  reconciliation: P12ReconciliationReport;
  active: P12ActiveStateReport;
  auth: P12AuthReferenceReport;
}>;

export type P12RepeatabilityReport = Readonly<{
  version: 1;
  run_id: string;
  generated_at: string;
  status: "PASS" | "FAIL";
  run_a_fingerprint: string;
  run_b_fingerprint: string;
  differences: readonly string[];
  compared_fields: readonly string[];
}>;

export class P12RepeatabilityError extends Error {
  readonly code = "P12_REPEATABILITY_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "P12RepeatabilityError";
  }
}

export function compareP12Runs(
  runA: P12RunOutcome,
  runB: P12RunOutcome,
  now: () => Date = () => new Date(),
  expected?: Readonly<{ sourceSnapshotSha256: string; localBaselineSha256: string }>,
): P12RepeatabilityReport {
  validateOutcome(runA, "a");
  validateOutcome(runB, "b");
  if (runA.summary.run_id !== runB.summary.run_id) throw new P12RepeatabilityError("P12 repeatability runs do not use the same immutable run");
  const normalizedA = normalizedOutcome(runA);
  const normalizedB = normalizedOutcome(runB);
  const differences: string[] = [];
  if (expected) {
    compareField(differences, "current_snapshot_artifact", normalizedA.source_snapshot_sha256, expected.sourceSnapshotSha256);
    compareField(differences, "current_local_baseline_artifact", normalizedA.local_baseline_sha256, expected.localBaselineSha256);
  }
  compareField(differences, "source_snapshot_sha256", normalizedA.source_snapshot_sha256, normalizedB.source_snapshot_sha256);
  compareField(differences, "local_baseline_sha256", normalizedA.local_baseline_sha256, normalizedB.local_baseline_sha256);
  compareField(differences, "imported_row_counts", normalizedA.imported_row_counts, normalizedB.imported_row_counts);
  compareField(differences, "table_fingerprints", normalizedA.table_fingerprints, normalizedB.table_fingerprints);
  compareField(differences, "verification_outcomes", normalizedA.verification_outcomes, normalizedB.verification_outcomes);
  compareField(differences, "integrity_outcomes", normalizedA.integrity_outcomes, normalizedB.integrity_outcomes);
  compareField(differences, "sequence", normalizedA.sequence, normalizedB.sequence);
  compareField(differences, "reconciliation_counts", normalizedA.reconciliation_counts, normalizedB.reconciliation_counts);
  compareField(differences, "reconciliation_findings", normalizedA.reconciliation_findings, normalizedB.reconciliation_findings);
  compareField(differences, "active_state", normalizedA.active_state, normalizedB.active_state);
  compareField(differences, "auth_references", normalizedA.auth_references, normalizedB.auth_references);
  return Object.freeze({
    version: 1,
    run_id: runA.summary.run_id,
    generated_at: now().toISOString(),
    status: differences.length ? "FAIL" : "PASS",
    run_a_fingerprint: sha256(canonicalJson(normalizedA)),
    run_b_fingerprint: sha256(canonicalJson(normalizedB)),
    differences: Object.freeze(differences),
    compared_fields: Object.freeze([
      "source_snapshot_sha256", "local_baseline_sha256", "imported_row_counts", "table_fingerprints",
      "verification_outcomes", "integrity_outcomes", "sequence", "reconciliation_counts",
      "reconciliation_findings", "active_state", "auth_references",
    ]),
  });
}

function normalizedOutcome(outcome: P12RunOutcome): Readonly<Record<string, unknown>> {
  return Object.freeze({
    source_snapshot_sha256: outcome.summary.source_snapshot_sha256,
    local_baseline_snapshot_id: outcome.summary.local_baseline_snapshot_id,
    local_baseline_sha256: outcome.summary.local_baseline_sha256,
    imported_row_counts: outcome.verification.tables.map(({ table, source_row_count, target_row_count }) => ({ table, source_row_count, target_row_count })),
    table_fingerprints: outcome.verification.tables.map(({ table, source_sha256, target_sha256, source_chunks, target_chunks }) => ({ table, source_sha256, target_sha256, source_chunks, target_chunks })),
    verification_outcomes: outcome.verification.tables.map(({ table, count_status, pk_status, required_null_status, native_type_status, fingerprint_status, representative_status }) => ({ table, count_status, pk_status, required_null_status, native_type_status, fingerprint_status, representative_status })),
    integrity_outcomes: {
      unique: outcome.verification.unique_checks,
      foreign_keys: outcome.verification.foreign_key_checks,
      consistency: outcome.verification.consistency,
    },
    sequence: outcome.verification.sequence,
    reconciliation_counts: outcome.reconciliation.category_counts,
    reconciliation_findings: outcome.reconciliation.findings,
    active_state: { counts: outcome.active.counts_by_table, items: outcome.active.items },
    auth_references: {
      unresolved: outcome.auth.unresolved_logical_reference_count,
      references: outcome.auth.references,
    },
  });
}

function validateOutcome(outcome: P12RunOutcome, label: "a" | "b"): void {
  if (outcome.summary.version !== 1 || outcome.summary.rehearsal_label !== label || outcome.summary.run_id !== outcome.verification.run_id ||
      outcome.summary.run_id !== outcome.reconciliation.run_id || outcome.summary.run_id !== outcome.active.run_id ||
      outcome.summary.run_id !== outcome.auth.run_id || outcome.reconciliation.unclassified_count !== 0 ||
      outcome.verification.version !== 1 || outcome.reconciliation.version !== 1 || outcome.active.version !== 1 || outcome.auth.version !== 1 ||
      outcome.verification.tables.length !== P12_TABLES.length || !Array.isArray(outcome.reconciliation.findings) ||
      !Array.isArray(outcome.active.items) || !Array.isArray(outcome.auth.references) ||
      !validStatus(outcome.verification.overall_status) || !validStatus(outcome.reconciliation.overall_status)) {
    throw new P12RepeatabilityError(`P12 repeatability run ${label.toUpperCase()} report set is malformed`);
  }
}

function compareField(differences: string[], name: string, left: unknown, right: unknown): void {
  if (canonicalJson(left) !== canonicalJson(right)) differences.push(name);
}

function validStatus(value: unknown): value is "PASS" | "FAIL" | "WARN" {
  return value === "PASS" || value === "FAIL" || value === "WARN";
}
