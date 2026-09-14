import { canonicalJson } from "./canonical.js";
import { P12_AUTH_COUPLED_COLUMNS, P12_TABLES } from "./contract.js";
import type { P12SnapshotBundle } from "./snapshot.js";
import { parseSnapshotBundle } from "./import.js";
import type { P12CheckStatus, P12VerificationReport } from "./verification.js";
import type { P12ReconciliationReport } from "./reconciliation.js";

export type P12AuthReference = Readonly<{
  referenced_uuid: string;
  originating_table: string;
  originating_column: string;
  represented_in_profiles: boolean;
}>;

export type P12AuthReferenceReport = Readonly<{
  version: 1;
  run_id: string;
  generated_at: string;
  status: P12CheckStatus;
  reference_count: number;
  unresolved_logical_reference_count: number;
  validates_supabase_auth: false;
  references: readonly P12AuthReference[];
}>;

export type P12ActiveStateItem = Readonly<{
  table: string;
  id: string;
  status: string;
}>;

export type P12ActiveStateReport = Readonly<{
  version: 1;
  run_id: string;
  generated_at: string;
  status: P12CheckStatus;
  active_count: number;
  counts_by_table: Readonly<Record<string, number>>;
  items: readonly P12ActiveStateItem[];
}>;

export type P12RunSummary = Readonly<{
  version: 1;
  run_id: string;
  rehearsal_label: "a" | "b";
  generated_at: string;
  source_capture_started_at: string;
  source_capture_completed_at: string;
  source_snapshot_atomic: false;
  source_snapshot_warning: string;
  source_snapshot_sha256: string;
  local_baseline_snapshot_id: "asset-baseline.dump";
  local_baseline_sha256: string;
  source_rows: Readonly<Record<string, number>>;
  imported_rows: Readonly<Record<string, number>>;
  verification_status: P12CheckStatus;
  auth_reference_status: P12CheckStatus;
  active_state_status: P12CheckStatus;
  reconciliation_status: P12CheckStatus;
  reconciliation_category_counts: P12ReconciliationReport["category_counts"];
  unresolved_blockers: readonly string[];
  preliminary_p13_readiness: "BLOCKED_PENDING_FINAL_CUTOVER_STRATEGY";
}>;

export function buildP12AuthReferenceReport(
  bundle: P12SnapshotBundle,
  now: () => Date = () => new Date(),
): P12AuthReferenceReport {
  const rows = parseSnapshotBundle(bundle.manifest, bundle.artifacts);
  const profileIds = new Set((rows.get("profiles") ?? []).map(({ id }) => String(id)));
  const references: P12AuthReference[] = [];
  for (const [table, columns] of Object.entries(P12_AUTH_COUPLED_COLUMNS)) {
    for (const row of rows.get(table) ?? []) {
      for (const column of columns) {
        const value = row[column];
        if (value === null || value === undefined) continue;
        if (typeof value !== "string" || !uuid(value)) throw new P12ReportingError("P12 Auth logical reference is malformed");
        references.push(Object.freeze({
          referenced_uuid: value,
          originating_table: table,
          originating_column: column,
          represented_in_profiles: profileIds.has(value),
        }));
      }
    }
  }
  references.sort((left, right) => canonicalJson([left.referenced_uuid, left.originating_table, left.originating_column])
    < canonicalJson([right.referenced_uuid, right.originating_table, right.originating_column]) ? -1 :
    canonicalJson([left.referenced_uuid, left.originating_table, left.originating_column])
      > canonicalJson([right.referenced_uuid, right.originating_table, right.originating_column]) ? 1 : 0);
  const unresolved = references.filter(({ represented_in_profiles }) => !represented_in_profiles).length;
  return Object.freeze({
    version: 1,
    run_id: bundle.manifest.run_id,
    generated_at: now().toISOString(),
    status: unresolved ? "WARN" : "PASS",
    reference_count: references.length,
    unresolved_logical_reference_count: unresolved,
    validates_supabase_auth: false,
    references: Object.freeze(references),
  });
}

export function buildP12ActiveStateReport(
  bundle: P12SnapshotBundle,
  now: () => Date = () => new Date(),
): P12ActiveStateReport {
  const rows = parseSnapshotBundle(bundle.manifest, bundle.artifacts);
  const contracts = [
    { table: "diagnostic_jobs", id: "id", states: ["queued", "running"] },
    { table: "traffic_live_sessions", id: "id", states: ["queued", "running", "stopping"] },
    { table: "network_health_ping_jobs", id: "id", states: ["queued", "running"] },
    { table: "network_discovery_sessions", id: "session_id", states: ["queued", "running"] },
    { table: "device_inspection_sessions", id: "inspection_id", states: ["queued", "running"] },
  ] as const;
  const items: P12ActiveStateItem[] = [];
  const counts: Record<string, number> = {};
  for (const contract of contracts) {
    const active = (rows.get(contract.table) ?? []).filter(({ status }) => contract.states.includes(String(status) as never));
    counts[contract.table] = active.length;
    for (const row of active) {
      const id = row[contract.id];
      if (typeof id !== "string" || !id) throw new P12ReportingError(`P12 active state for ${contract.table} is malformed`);
      items.push(Object.freeze({ table: contract.table, id, status: String(row.status) }));
    }
  }
  items.sort((left, right) => canonicalJson([left.table, left.id]) < canonicalJson([right.table, right.id]) ? -1 :
    canonicalJson([left.table, left.id]) > canonicalJson([right.table, right.id]) ? 1 : 0);
  return Object.freeze({
    version: 1,
    run_id: bundle.manifest.run_id,
    generated_at: now().toISOString(),
    status: items.length ? "WARN" : "PASS",
    active_count: items.length,
    counts_by_table: Object.freeze(counts),
    items: Object.freeze(items),
  });
}

export function buildP12RunSummary(options: Readonly<{
  label: "a" | "b";
  bundle: P12SnapshotBundle;
  verification: P12VerificationReport;
  reconciliation: P12ReconciliationReport;
  auth: P12AuthReferenceReport;
  active: P12ActiveStateReport;
  now?: () => Date;
}>): P12RunSummary {
  const blockers: string[] = [];
  if (options.verification.overall_status === "FAIL") blockers.push("verification_failed");
  if (options.reconciliation.unclassified_count !== 0) blockers.push("reconciliation_unclassified");
  if (options.reconciliation.category_counts.CONFLICT) blockers.push("identity_conflicts_require_review");
  if (options.reconciliation.category_counts.AMBIGUOUS) blockers.push("ambiguous_identities_require_review");
  if (options.active.active_count) blockers.push("active_lifecycle_rows_require_cutover_plan");
  if (options.auth.unresolved_logical_reference_count) blockers.push("unresolved_auth_references_require_p15_plan");
  blockers.push("non_atomic_source_snapshot_not_valid_for_p13");
  return Object.freeze({
    version: 1,
    run_id: options.bundle.manifest.run_id,
    rehearsal_label: options.label,
    generated_at: (options.now ?? (() => new Date()))().toISOString(),
    source_capture_started_at: options.bundle.manifest.capture_started_at,
    source_capture_completed_at: options.bundle.manifest.capture_completed_at,
    source_snapshot_atomic: false,
    source_snapshot_warning: options.bundle.manifest.warning,
    source_snapshot_sha256: options.verification.source_snapshot_sha256,
    local_baseline_snapshot_id: options.verification.local_baseline_snapshot_id,
    local_baseline_sha256: options.verification.local_baseline_sha256,
    source_rows: Object.freeze(Object.fromEntries(options.verification.tables.map((table) => [table.table, table.source_row_count]))),
    imported_rows: Object.freeze(Object.fromEntries(options.verification.tables.map((table) => [table.table, table.target_row_count]))),
    verification_status: options.verification.overall_status,
    auth_reference_status: options.auth.status,
    active_state_status: options.active.status,
    reconciliation_status: options.reconciliation.overall_status,
    reconciliation_category_counts: options.reconciliation.category_counts,
    unresolved_blockers: Object.freeze([...new Set(blockers)].sort()),
    preliminary_p13_readiness: "BLOCKED_PENDING_FINAL_CUTOVER_STRATEGY",
  });
}

export function publicP12Summary(summary: P12RunSummary): Readonly<Record<string, unknown>> {
  return Object.freeze({
    status: summary.verification_status === "FAIL" ? "failed" : "recorded",
    run_id: summary.run_id,
    rehearsal_label: summary.rehearsal_label,
    verification_status: summary.verification_status,
    reconciliation_status: summary.reconciliation_status,
    active_count_status: summary.active_state_status,
    unresolved_blockers: summary.unresolved_blockers,
    preliminary_p13_readiness: summary.preliminary_p13_readiness,
  });
}

export class P12ReportingError extends Error {
  readonly code = "P12_REPORT_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "P12ReportingError";
  }
}

export function assertP12TableSet(rows: ReadonlyMap<string, unknown>): void {
  if (rows.size !== P12_TABLES.length || P12_TABLES.some(({ table }) => !rows.has(table))) {
    throw new P12ReportingError("P12 report table set is incomplete");
  }
}

function uuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
