import { canonicalJson, isP12JsonNumber, parseLosslessJson, sha256 } from "./canonical.js";
import { P12_AUTH_COUPLED_COLUMNS, P12_IMPORT_ORDER, P12_TABLES, type P12TableDefinition } from "./contract.js";
import type { P12SnapshotBundle, P12SnapshotManifest } from "./snapshot.js";
import type { P12Target } from "./target.js";
import { parseP12Target } from "./target.js";

export const P12_IMPORT_BATCH_SIZE = 100;

export type P12ImportQueryResult = Readonly<{ rows?: readonly Readonly<Record<string, unknown>>[] }>;
export type P12ImportQuery = (
  sql: string,
  values?: readonly unknown[],
) => Promise<P12ImportQueryResult>;

export type P12ImportResult = Readonly<{
  run_id: string;
  database: string;
  imported_rows: number;
  tables: readonly Readonly<{ table: string; rows: number }>[];
  sequence_adjusted: "public.network_health_samples.id";
}>;

export class P12ImportError extends Error {
  readonly code = "P12_IMPORT_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "P12ImportError";
  }
}

export function parseSnapshotBundle(
  manifest: P12SnapshotManifest,
  artifacts: Readonly<Record<string, string>>,
): ReadonlyMap<string, readonly Readonly<Record<string, unknown>>[]> {
  if (manifest.version !== 1 || manifest.atomic !== false || typeof manifest.warning !== "string" ||
      !Array.isArray(manifest.tables) || !/^[a-z0-9][a-z0-9_]{0,47}$/.test(manifest.run_id) ||
      !/^[0-9a-f]{40}$/i.test(manifest.source_commit) ||
      !/^[0-9a-f]{64}$/i.test(manifest.source_schema_sha256) ||
      !validTimestamp(manifest.capture_started_at) || !validTimestamp(manifest.capture_completed_at) ||
      canonicalJson(manifest.auth_coupled_columns) !== canonicalJson(P12_AUTH_COUPLED_COLUMNS)) {
    throw new P12ImportError("P12 snapshot manifest is invalid");
  }
  const manifestByTable = new Map(manifest.tables.map((entry) => [entry.source_table, entry]));
  if (manifestByTable.size !== P12_TABLES.length || manifest.tables.length !== P12_TABLES.length) {
    throw new P12ImportError("P12 snapshot table set is incomplete");
  }
  const result = new Map<string, readonly Readonly<Record<string, unknown>>[]>();
  for (const definition of P12_TABLES) {
    const entry = manifestByTable.get(definition.table);
    const content = artifacts[definition.table];
    if (!entry || typeof content !== "string" || !validTableManifest(entry, definition) ||
        entry.artifact !== `${definition.table}.jsonl` ||
        entry.output_sha256 !== sha256(content)) {
      throw new P12ImportError(`P12 snapshot artifact for ${definition.table} failed integrity validation`);
    }
    const rows = parseRows(definition, content);
    if (rows.length !== entry.row_count) {
      throw new P12ImportError(`P12 snapshot artifact for ${definition.table} has an invalid row count`);
    }
    const orderingKeys = rows.map((row) => canonicalJson(definition.orderingKey.map((column) => row[column])));
    if (new Set(orderingKeys).size !== orderingKeys.length) {
      throw new P12ImportError(`P12 snapshot artifact for ${definition.table} has a duplicate primary key`);
    }
    result.set(definition.table, Object.freeze(rows));
  }
  return result;
}

export async function importP12Snapshot(options: Readonly<{
  target: P12Target;
  bundle: P12SnapshotBundle;
  query: P12ImportQuery;
  batchSize?: number;
}>): Promise<P12ImportResult> {
  // Re-parse the URL immediately before the first query. Callers cannot bypass the
  // guard by constructing a structurally compatible object themselves.
  const target = parseP12Target(options.target.runId, options.target.connectionString);
  if (target.database !== options.target.database || options.bundle.manifest.run_id !== target.runId) {
    throw new P12ImportError("P12 target and immutable snapshot run do not match");
  }
  const batchSize = options.batchSize ?? P12_IMPORT_BATCH_SIZE;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > P12_IMPORT_BATCH_SIZE) {
    throw new P12ImportError("P12 import batch size is invalid");
  }
  const rowsByTable = parseSnapshotBundle(options.bundle.manifest, options.bundle.artifacts);
  const imported: { table: string; rows: number }[] = [];
  let activeTable = "transaction";
  let transactionStarted = false;

  try {
    activeTable = "target identity preflight";
    const identity = await options.query(P12_TARGET_IDENTITY_SQL);
    validateP12TargetIdentity(identity, target);
    await options.query("BEGIN");
    transactionStarted = true;
    for (const definition of P12_TABLES) {
      activeTable = definition.table;
      const rows = rowsByTable.get(definition.table) ?? [];
      for (let offset = 0; offset < rows.length; offset += batchSize) {
        const batch = rows.slice(offset, offset + batchSize);
        const statement = insertStatement(definition, batch.length);
        const values = batch.flatMap((row) =>
          definition.columns.map((column) => importValue(definition, column, row[column])));
        await options.query(statement, values);
      }
      imported.push({ table: definition.table, rows: rows.length });
    }
    activeTable = "network_health_samples sequence";
    await options.query(NETWORK_HEALTH_SEQUENCE_SQL);
    await options.query("COMMIT");
  } catch {
    if (transactionStarted) {
      try {
        await options.query("ROLLBACK");
      } catch {}
    }
    throw new P12ImportError(`P12 import failed while processing ${activeTable}`);
  }

  return Object.freeze({
    run_id: target.runId,
    database: target.database,
    imported_rows: imported.reduce((total, entry) => total + entry.rows, 0),
    tables: Object.freeze(imported.map((entry) => Object.freeze(entry))),
    sequence_adjusted: "public.network_health_samples.id",
  });
}

export function p12ImportOrder(): readonly string[] {
  return P12_IMPORT_ORDER;
}

export const NETWORK_HEALTH_SEQUENCE_SQL = `
SELECT setval(
  pg_get_serial_sequence('public.network_health_samples', 'id'),
  COALESCE((SELECT MAX(id) FROM public.network_health_samples), 1),
  EXISTS (SELECT 1 FROM public.network_health_samples)
)
`.trim();

export const P12_TARGET_IDENTITY_SQL = `
SELECT
  current_database()::text AS database_name,
  inet_server_port()::integer AS server_port,
  COALESCE(host(inet_server_addr()), '') AS server_address
`.trim();

export function validateP12TargetIdentity(result: P12ImportQueryResult, target: P12Target): void {
  const identity = result.rows?.[0];
  if (!identity || result.rows?.length !== 1 || identity.database_name !== target.database ||
      identity.server_port !== target.port ||
      (identity.server_address !== "127.0.0.1" && identity.server_address !== "::1")) {
    throw new P12ImportError("P12 connected database identity does not match the guarded rehearsal target");
  }
}

function insertStatement(definition: P12TableDefinition, rowCount: number): string {
  const quotedColumns = definition.columns.map(quoteIdentifier).join(", ");
  let parameter = 0;
  const rows = Array.from({ length: rowCount }, () =>
    `(${definition.columns.map(() => `$${parameter += 1}`).join(", ")})`);
  return `INSERT INTO public.${quoteIdentifier(definition.table)} (${quotedColumns}) VALUES ${rows.join(", ")}`;
}

function parseRows(
  definition: P12TableDefinition,
  content: string,
): Readonly<Record<string, unknown>>[] {
  if (!content) return [];
  if (!content.endsWith("\n")) {
    throw new P12ImportError(`P12 snapshot artifact for ${definition.table} is not canonical JSONL`);
  }
  const lines = content.slice(0, -1).split("\n");
  return lines.map((line) => {
    let row: unknown;
    try {
      row = parseLosslessJson(line);
    } catch {
      throw new P12ImportError(`P12 snapshot artifact for ${definition.table} contains invalid JSON`);
    }
    if (!isRecord(row)) {
      throw new P12ImportError(`P12 snapshot artifact for ${definition.table} contains a malformed row`);
    }
    const keys = Object.keys(row).sort();
    const expected = [...definition.columns].sort();
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
      throw new P12ImportError(`P12 snapshot artifact for ${definition.table} does not match the audited schema`);
    }
    if (canonicalJson(row) !== line) {
      throw new P12ImportError(`P12 snapshot artifact for ${definition.table} is not canonical JSONL`);
    }
    return row;
  });
}

function validTableManifest(
  entry: P12SnapshotManifest["tables"][number],
  definition: P12TableDefinition,
): boolean {
  return entry.source_table === definition.table && Number.isSafeInteger(entry.row_count) && entry.row_count >= 0 &&
    entry.row_count <= 10_000_000 && Array.isArray(entry.ordering_key) &&
    entry.ordering_key.length === definition.orderingKey.length &&
    entry.ordering_key.every((key, index) => key === definition.orderingKey[index]) &&
    Array.isArray(entry.chunks) && entry.chunks.length > 0 && entry.chunks.length <= 10_000 &&
    entry.chunks.every((chunk, index) => chunk.page === index && Number.isSafeInteger(chunk.offset) && chunk.offset >= 0 &&
      Number.isSafeInteger(chunk.row_count) && chunk.row_count >= 0 && chunk.row_count <= 1_000) &&
    entry.chunks.reduce((total, chunk) => total + chunk.row_count, 0) === entry.row_count &&
    /^[0-9a-f]{64}$/i.test(entry.output_sha256);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new P12ImportError("P12 SQL identifier is invalid");
  return `"${value}"`;
}

function importValue(definition: P12TableDefinition, column: string, value: unknown): unknown {
  if (value === null) return null;
  if (definition.jsonColumns?.includes(column)) return canonicalJson(value);
  if (isP12JsonNumber(value)) {
    if (!definition.numericColumns?.includes(column)) {
      throw new P12ImportError(`P12 snapshot artifact for ${definition.table} has an unexpected numeric value`);
    }
    return value.raw;
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
