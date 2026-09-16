import { canonicalJson, canonicalJsonLines, isP12JsonNumber, parseLosslessJson, sha256 } from "./canonical.js";
import { P12_TABLES, type P12TableDefinition } from "./contract.js";
import { parseSnapshotBundle, P12_TARGET_IDENTITY_SQL, validateP12TargetIdentity, type P12ImportQuery } from "./import.js";
import type { P12SnapshotBundle } from "./snapshot.js";
import type { P12Target } from "./target.js";
import { parseP12Target } from "./target.js";
import {
  P12_FOREIGN_KEYS,
  P12_NATIVE_TYPE_EXPECTATIONS,
  P12_REQUIRED_COLUMNS,
  P12_UNIQUE_KEYS,
} from "./verification-contract.js";

export const P12_VERIFICATION_CHUNK_SIZE = 500;
export const P12_VERIFICATION_MAX_CHUNKS = 10_000;

export type P12CheckStatus = "PASS" | "FAIL" | "WARN";

export type P12FingerprintChunk = Readonly<{
  index: number;
  row_count: number;
  first_key: string | null;
  last_key: string | null;
  sha256: string;
}>;

export type P12TableVerification = Readonly<{
  table: string;
  source_row_count: number;
  target_row_count: number;
  count_status: P12CheckStatus;
  pk_status: P12CheckStatus;
  duplicate_pk_count: number;
  required_null_status: P12CheckStatus;
  required_null_count: number;
  native_type_status: P12CheckStatus;
  native_type_mismatches: readonly string[];
  fingerprint_status: P12CheckStatus;
  source_sha256: string;
  target_sha256: string;
  source_chunks: readonly P12FingerprintChunk[];
  target_chunks: readonly P12FingerprintChunk[];
  timestamp_range: Readonly<{ source_min: string | null; source_max: string | null; target_min: string | null; target_max: string | null }>;
  representative_status: P12CheckStatus;
}>;

export type P12IntegrityCheck = Readonly<{
  name: string;
  table: string;
  status: P12CheckStatus;
  violation_count: number;
}>;

export type P12SequenceVerification = Readonly<{
  status: P12CheckStatus;
  source_max_id: string | null;
  target_max_id: string | null;
  sequence_last_value: string;
  sequence_is_called: boolean;
}>;

export type P12ConsistencyCheck = Readonly<{
  name: string;
  status: P12CheckStatus;
  evidence_count: number;
}>;

export type P12VerificationReport = Readonly<{
  version: 1;
  run_id: string;
  generated_at: string;
  source_snapshot_sha256: string;
  local_baseline_snapshot_id: "asset-baseline.dump";
  local_baseline_sha256: string;
  overall_status: P12CheckStatus;
  tables: readonly P12TableVerification[];
  unique_checks: readonly P12IntegrityCheck[];
  foreign_key_checks: readonly P12IntegrityCheck[];
  sequence: P12SequenceVerification;
  consistency: readonly P12ConsistencyCheck[];
}>;

export type P12RehearsalData = Readonly<{
  rows: ReadonlyMap<string, readonly Readonly<Record<string, unknown>>[]>;
  nativeTypes: ReadonlyMap<string, ReadonlyMap<string, string>>;
  sequence: Readonly<{ lastValue: string; isCalled: boolean }>;
}>;

export class P12VerificationError extends Error {
  readonly code = "P12_VERIFICATION_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "P12VerificationError";
  }
}

export async function loadP12RehearsalData(options: Readonly<{
  target: P12Target;
  bundle: P12SnapshotBundle;
  query: P12ImportQuery;
  chunkSize?: number;
}>): Promise<P12RehearsalData> {
  const target = parseP12Target(options.target.runId, options.target.connectionString);
  if (target.database !== options.target.database || options.bundle.manifest.run_id !== target.runId) {
    throw new P12VerificationError("P12 target and immutable snapshot run do not match");
  }
  parseSnapshotBundle(options.bundle.manifest, options.bundle.artifacts);
  const chunkSize = options.chunkSize ?? P12_VERIFICATION_CHUNK_SIZE;
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > P12_VERIFICATION_CHUNK_SIZE) {
    throw new P12VerificationError("P12 verification chunk size is invalid");
  }
  try {
    validateP12TargetIdentity(await options.query(P12_TARGET_IDENTITY_SQL), target);
    const rows = new Map<string, readonly Readonly<Record<string, unknown>>[]>();
    const nativeTypes = new Map<string, ReadonlyMap<string, string>>();
    for (const definition of P12_TABLES) {
      const countResult = await options.query(`SELECT count(*)::text AS row_count FROM public.${quoteIdentifier(definition.table)}`);
      const count = boundedRowCount(countResult.rows?.[0]?.row_count);
      const tableRows: Readonly<Record<string, unknown>>[] = [];
      for (let chunk = 0; tableRows.length < count; chunk += 1) {
        if (chunk >= P12_VERIFICATION_MAX_CHUNKS) throw new P12VerificationError("P12 verification row bound exceeded");
        const result = await options.query(targetRowsSql(definition), [chunkSize, chunk * chunkSize]);
        const page = result.rows ?? [];
        if (!page.length || page.length > chunkSize) throw new P12VerificationError(`P12 target table ${definition.table} returned an incomplete page`);
        tableRows.push(...page.map((row) => parseTargetRow(definition, row.row_json)));
        if (tableRows.length > count) throw new P12VerificationError(`P12 target table ${definition.table} changed during verification`);
      }
      if (tableRows.length !== count) throw new P12VerificationError(`P12 target table ${definition.table} count is inconsistent`);
      rows.set(definition.table, Object.freeze(tableRows));

      const typeResult = await options.query(P12_COLUMN_TYPES_SQL, [definition.table]);
      const types = new Map<string, string>();
      for (const row of typeResult.rows ?? []) {
        if (typeof row.column_name !== "string" || typeof row.udt_name !== "string") {
          throw new P12VerificationError(`P12 target table ${definition.table} type metadata is malformed`);
        }
        types.set(row.column_name, row.udt_name);
      }
      nativeTypes.set(definition.table, types);
    }
    const sequenceResult = await options.query(P12_SEQUENCE_STATE_SQL);
    const sequenceRow = sequenceResult.rows?.[0];
    if (!sequenceRow || sequenceResult.rows?.length !== 1 || typeof sequenceRow.is_called !== "boolean") {
      throw new P12VerificationError("P12 sequence state is malformed");
    }
    return Object.freeze({
      rows,
      nativeTypes,
      sequence: Object.freeze({ lastValue: integerText(sequenceRow.last_value), isCalled: sequenceRow.is_called }),
    });
  } catch (error) {
    if (error instanceof P12VerificationError) throw error;
    throw new P12VerificationError("P12 rehearsal data could not be loaded safely");
  }
}

export function verifyP12Rehearsal(options: Readonly<{
  bundle: P12SnapshotBundle;
  target: P12RehearsalData;
  localBaselineSha256: string;
  now?: () => Date;
  chunkSize?: number;
}>): P12VerificationReport {
  const source = parseSnapshotBundle(options.bundle.manifest, options.bundle.artifacts);
  if (!/^[0-9a-f]{64}$/i.test(options.localBaselineSha256)) {
    throw new P12VerificationError("P12 local baseline identity is invalid");
  }
  const chunkSize = options.chunkSize ?? P12_VERIFICATION_CHUNK_SIZE;
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > P12_VERIFICATION_CHUNK_SIZE) {
    throw new P12VerificationError("P12 verification chunk size is invalid");
  }
  const tables = P12_TABLES.map((definition) => verifyTable(
    definition,
    source.get(definition.table) ?? [],
    options.target.rows.get(definition.table) ?? [],
    options.target.nativeTypes.get(definition.table) ?? new Map(),
    chunkSize,
  ));
  const uniqueChecks = P12_UNIQUE_KEYS.map((definition) => {
    const violations = duplicateCount(options.target.rows.get(definition.table) ?? [], definition.columns, definition.activeStatuses);
    return integrity(definition.name, definition.table, violations);
  });
  const foreignKeyChecks = P12_FOREIGN_KEYS.map((definition) => {
    const children = options.target.rows.get(definition.table) ?? [];
    const parents = options.target.rows.get(definition.parentTable) ?? [];
    const parentKeys = new Set(parents.map((row) => keyFor(row, definition.parentColumns)));
    const violations = children.filter((row) => {
      const values = definition.columns.map((column) => row[column]);
      if (values.some((value) => value === null || value === undefined)) return !definition.nullable;
      return !parentKeys.has(canonicalJson(values));
    }).length;
    return integrity(`${definition.table}.${definition.columns.join("+")}->${definition.parentTable}`, definition.table, violations);
  });
  const sequence = verifySequence(
    source.get("network_health_samples") ?? [],
    options.target.rows.get("network_health_samples") ?? [],
    options.target.sequence,
  );
  const consistency = verifyConsistency(options.target.rows);
  const hardChecks = [
    ...tables.flatMap((table) => [table.count_status, table.pk_status, table.required_null_status, table.native_type_status, table.fingerprint_status, table.representative_status]),
    ...uniqueChecks.map(({ status }) => status),
    ...foreignKeyChecks.map(({ status }) => status),
    sequence.status,
    ...consistency.filter(({ status }) => status === "FAIL").map(({ status }) => status),
  ];
  return Object.freeze({
    version: 1,
    run_id: options.bundle.manifest.run_id,
    generated_at: (options.now ?? (() => new Date()))().toISOString(),
    source_snapshot_sha256: snapshotIdentity(options.bundle),
    local_baseline_snapshot_id: "asset-baseline.dump",
    local_baseline_sha256: options.localBaselineSha256.toLowerCase(),
    overall_status: hardChecks.includes("FAIL") ? "FAIL" : consistency.some(({ status }) => status === "WARN") ? "WARN" : "PASS",
    tables: Object.freeze(tables),
    unique_checks: Object.freeze(uniqueChecks),
    foreign_key_checks: Object.freeze(foreignKeyChecks),
    sequence,
    consistency: Object.freeze(consistency),
  });
}

export function tableFingerprint(
  rows: readonly Readonly<Record<string, unknown>>[],
  orderingKey: readonly string[],
  chunkSize = P12_VERIFICATION_CHUNK_SIZE,
): Readonly<{ sha256: string; chunks: readonly P12FingerprintChunk[] }> {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > P12_VERIFICATION_CHUNK_SIZE) {
    throw new P12VerificationError("P12 fingerprint chunk size is invalid");
  }
  const sorted = [...rows].sort((left, right) => compareText(canonicalJson(keyValues(left, orderingKey)), canonicalJson(keyValues(right, orderingKey))));
  const chunks: P12FingerprintChunk[] = [];
  for (let offset = 0; offset < sorted.length; offset += chunkSize) {
    const chunkRows = sorted.slice(offset, offset + chunkSize).map(normalizeVerificationRow);
    chunks.push(Object.freeze({
      index: chunks.length,
      row_count: chunkRows.length,
      first_key: canonicalJson(keyValues(sorted[offset] ?? {}, orderingKey)),
      last_key: canonicalJson(keyValues(sorted[offset + chunkRows.length - 1] ?? {}, orderingKey)),
      sha256: sha256(canonicalJsonLines(chunkRows)),
    }));
  }
  return Object.freeze({ sha256: sha256(canonicalJsonLines(sorted.map(normalizeVerificationRow))), chunks: Object.freeze(chunks) });
}

export function snapshotIdentity(bundle: P12SnapshotBundle): string {
  return sha256(canonicalJson({
    source_commit: bundle.manifest.source_commit,
    source_schema_sha256: bundle.manifest.source_schema_sha256,
    tables: bundle.manifest.tables.map(({ source_table, row_count, output_sha256 }) => ({ source_table, row_count, output_sha256 })),
  }));
}

export const P12_COLUMN_TYPES_SQL = `
SELECT a.attname::text AS column_name, t.typname::text AS udt_name
FROM pg_catalog.pg_attribute a
JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
WHERE n.nspname = 'public' AND c.relname = $1 AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attnum
`.trim();

export const P12_SEQUENCE_STATE_SQL = `
SELECT last_value::text AS last_value, is_called
FROM public.network_health_samples_id_seq
`.trim();

function verifyTable(
  definition: P12TableDefinition,
  sourceRows: readonly Readonly<Record<string, unknown>>[],
  targetRows: readonly Readonly<Record<string, unknown>>[],
  targetTypes: ReadonlyMap<string, string>,
  chunkSize: number,
): P12TableVerification {
  const sourceFingerprint = tableFingerprint(sourceRows, definition.orderingKey, chunkSize);
  const targetFingerprint = tableFingerprint(targetRows, definition.orderingKey, chunkSize);
  const duplicatePk = duplicateCount(targetRows, definition.orderingKey);
  const requiredColumns = (P12_REQUIRED_COLUMNS as Readonly<Record<string, readonly string[]>>)[definition.table] ?? definition.orderingKey;
  const requiredNulls = targetRows.reduce((count, row) => count + requiredColumns.filter((column) => row[column] === null || row[column] === undefined).length, 0);
  const expectedTypes = {
    ...((P12_NATIVE_TYPE_EXPECTATIONS as Readonly<Record<string, Readonly<Record<string, string>>>>)[definition.table] ?? {}),
    ...Object.fromEntries(definition.columns.filter(isTimestampColumn).map((column) => [column, "timestamptz"])),
  };
  const nativeTypeMismatches = Object.entries(expectedTypes)
    .filter(([column, expected]) => targetTypes.get(column) !== expected)
    .map(([column, expected]) => `${column}:${targetTypes.get(column) ?? "missing"}->${expected}`);
  const representative = representativeHashes(sourceRows, targetRows, definition.orderingKey);
  const sourceRange = timestampRange(sourceRows);
  const targetRange = timestampRange(targetRows);
  return Object.freeze({
    table: definition.table,
    source_row_count: sourceRows.length,
    target_row_count: targetRows.length,
    count_status: sourceRows.length === targetRows.length ? "PASS" : "FAIL",
    pk_status: duplicatePk === 0 ? "PASS" : "FAIL",
    duplicate_pk_count: duplicatePk,
    required_null_status: requiredNulls === 0 ? "PASS" : "FAIL",
    required_null_count: requiredNulls,
    native_type_status: nativeTypeMismatches.length ? "FAIL" : "PASS",
    native_type_mismatches: Object.freeze(nativeTypeMismatches),
    fingerprint_status: sourceFingerprint.sha256 === targetFingerprint.sha256 ? "PASS" : "FAIL",
    source_sha256: sourceFingerprint.sha256,
    target_sha256: targetFingerprint.sha256,
    source_chunks: sourceFingerprint.chunks,
    target_chunks: targetFingerprint.chunks,
    timestamp_range: Object.freeze({ source_min: sourceRange.min, source_max: sourceRange.max, target_min: targetRange.min, target_max: targetRange.max }),
    representative_status: representative ? "PASS" : "FAIL",
  });
}

function verifySequence(
  sourceRows: readonly Readonly<Record<string, unknown>>[],
  targetRows: readonly Readonly<Record<string, unknown>>[],
  sequence: P12RehearsalData["sequence"],
): P12SequenceVerification {
  const sourceMax = maximumInteger(sourceRows.map(({ id }) => id));
  const targetMax = maximumInteger(targetRows.map(({ id }) => id));
  const lastValue = BigInt(sequence.lastValue);
  const targetMaximum = targetMax === null ? null : BigInt(targetMax);
  const pass = sourceMax === targetMax && (targetMaximum === null ? !sequence.isCalled : sequence.isCalled && lastValue >= targetMaximum);
  return Object.freeze({
    status: pass ? "PASS" : "FAIL",
    source_max_id: sourceMax,
    target_max_id: targetMax,
    sequence_last_value: sequence.lastValue,
    sequence_is_called: sequence.isCalled,
  });
}

function verifyConsistency(rows: ReadonlyMap<string, readonly Readonly<Record<string, unknown>>[]>): P12ConsistencyCheck[] {
  const healthSamples = rows.get("network_health_samples") ?? [];
  const samplesByTarget = groupLatest(healthSamples, "target_id", "sampled_at");
  const healthDrift = (rows.get("network_health_latest") ?? []).filter((row) => {
    const latestSample = samplesByTarget.get(String(row.target_id));
    return latestSample && timestampMillis(latestSample) > timestampMillis(row.last_checked_at);
  }).length;
  const managedDeviceTargets = new Set((rows.get("managed_device_latest") ?? []).map(({ target_id }) => String(target_id)));
  const managedChildrenWithoutDevice = [
    ...(rows.get("managed_interface_latest") ?? []),
    ...(rows.get("managed_observed_hosts_latest") ?? []),
  ].filter(({ target_id }) => !managedDeviceTargets.has(String(target_id))).length;
  return [
    Object.freeze({ name: "network_health_latest_not_older_than_history", status: healthDrift ? "WARN" : "PASS", evidence_count: healthDrift }),
    Object.freeze({ name: "managed_children_have_device_latest", status: managedChildrenWithoutDevice ? "WARN" : "PASS", evidence_count: managedChildrenWithoutDevice }),
  ];
}

function representativeHashes(
  sourceRows: readonly Readonly<Record<string, unknown>>[],
  targetRows: readonly Readonly<Record<string, unknown>>[],
  orderingKey: readonly string[],
): boolean {
  if (sourceRows.length !== targetRows.length) return false;
  const source = [...sourceRows].sort((a, b) => compareText(canonicalJson(keyValues(a, orderingKey)), canonicalJson(keyValues(b, orderingKey))));
  const target = [...targetRows].sort((a, b) => compareText(canonicalJson(keyValues(a, orderingKey)), canonicalJson(keyValues(b, orderingKey))));
  const indexes = new Set([0, Math.floor(source.length / 2), source.length - 1]);
  for (const index of indexes) {
    if (index < 0) continue;
    if (sha256(canonicalJson(normalizeVerificationRow(source[index]))) !== sha256(canonicalJson(normalizeVerificationRow(target[index])))) return false;
  }
  return true;
}

function duplicateCount(
  rows: readonly Readonly<Record<string, unknown>>[],
  columns: readonly string[],
  activeStatuses?: readonly string[],
): number {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const row of rows) {
    if (activeStatuses && !activeStatuses.includes(String(row.status))) continue;
    const values = columns.map((column) => row[column]);
    if (values.some((value) => value === null || value === undefined)) continue;
    const key = canonicalJson(values);
    if (seen.has(key)) duplicates += 1;
    else seen.add(key);
  }
  return duplicates;
}

function normalizeVerificationRow(row: Readonly<Record<string, unknown>> | undefined): Readonly<Record<string, unknown>> {
  if (!row) return Object.freeze({});
  const normalized: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(row)) {
    normalized[column] = isTimestampColumn(column) && typeof value === "string" && Number.isFinite(Date.parse(value))
      ? new Date(value).toISOString()
      : value;
  }
  return Object.freeze(normalized);
}

function timestampRange(rows: readonly Readonly<Record<string, unknown>>[]): { min: string | null; max: string | null } {
  const values = rows.flatMap((row) => Object.entries(row)
    .filter(([column, value]) => isTimestampColumn(column) && typeof value === "string" && Number.isFinite(Date.parse(value)))
    .map(([, value]) => new Date(value as string).toISOString())).sort();
  return { min: values[0] ?? null, max: values.at(-1) ?? null };
}

function isTimestampColumn(column: string): boolean {
  return column.endsWith("_at") || column === "first_seen" || column === "last_seen";
}

function targetRowsSql(definition: P12TableDefinition): string {
  const columns = definition.columns.map(quoteIdentifier).join(", ");
  const ordering = definition.orderingKey.map(quoteIdentifier).join(", ");
  return `SELECT row_to_json(p12_row)::text AS row_json FROM (SELECT ${columns} FROM public.${quoteIdentifier(definition.table)} ORDER BY ${ordering} LIMIT $1 OFFSET $2) p12_row`;
}

function parseTargetRow(definition: P12TableDefinition, value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "string") throw new P12VerificationError(`P12 target table ${definition.table} returned a malformed row`);
  let parsed: unknown;
  try { parsed = parseLosslessJson(value); } catch { throw new P12VerificationError(`P12 target table ${definition.table} returned invalid JSON`); }
  if (!isRecord(parsed) || canonicalJson(Object.keys(parsed).sort()) !== canonicalJson([...definition.columns].sort())) {
    throw new P12VerificationError(`P12 target table ${definition.table} does not match the audited schema`);
  }
  return parsed;
}

function boundedRowCount(value: unknown): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new P12VerificationError("P12 target row count is malformed");
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0 || count > P12_VERIFICATION_CHUNK_SIZE * P12_VERIFICATION_MAX_CHUNKS) {
    throw new P12VerificationError("P12 target row count exceeds the verification bound");
  }
  return count;
}

function integerText(value: unknown): string {
  const text = isP12JsonNumber(value) ? value.raw : typeof value === "number" || typeof value === "bigint" ? String(value) : value;
  if (typeof text !== "string" || !/^\d+$/.test(text)) throw new P12VerificationError("P12 sequence value is malformed");
  return text;
}

function maximumInteger(values: readonly unknown[]): string | null {
  let maximum: bigint | null = null;
  for (const value of values) {
    const text = integerText(value);
    const integer = BigInt(text);
    if (maximum === null || integer > maximum) maximum = integer;
  }
  return maximum?.toString() ?? null;
}

function integrity(name: string, table: string, violations: number): P12IntegrityCheck {
  return Object.freeze({ name, table, status: violations ? "FAIL" : "PASS", violation_count: violations });
}

function keyValues(row: Readonly<Record<string, unknown>>, columns: readonly string[]): readonly unknown[] {
  return columns.map((column) => row[column]);
}

function keyFor(row: Readonly<Record<string, unknown>>, columns: readonly string[]): string {
  return canonicalJson(keyValues(row, columns));
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new P12VerificationError("P12 SQL identifier is invalid");
  return `"${value}"`;
}

function groupLatest(
  rows: readonly Readonly<Record<string, unknown>>[],
  keyColumn: string,
  timestampColumn: string,
): Map<string, unknown> {
  const result = new Map<string, unknown>();
  for (const row of rows) {
    const key = String(row[keyColumn]);
    const value = row[timestampColumn];
    if (!result.has(key) || timestampMillis(value) > timestampMillis(result.get(key))) result.set(key, value);
  }
  return result;
}

function timestampMillis(value: unknown): number {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
