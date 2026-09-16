import { canonicalJson, canonicalJsonLines, parseLosslessJson, sha256 } from "./canonical.js";
import { P12_AUTH_COUPLED_COLUMNS, P12_TABLES, type P12TableDefinition } from "./contract.js";

export const P12_SNAPSHOT_PAGE_SIZE = 500;
export const P12_SNAPSHOT_MAX_PAGES = 10_000;
export const P12_SNAPSHOT_MAX_PAGE_BYTES = 32 * 1024 * 1024;
export const P12_NON_ATOMIC_WARNING =
  "Supabase REST tables are captured independently; this is a non-atomic P12 rehearsal snapshot and is not sufficient for P13 cutover.";

export type P12SnapshotChunk = Readonly<{
  page: number;
  offset: number;
  row_count: number;
}>;

export type P12SensitiveSummary = Readonly<{
  column: string;
  present_rows: number;
  serialized_bytes: number;
  sha256: string;
}>;

export type P12SnapshotTableManifest = Readonly<{
  source_table: string;
  row_count: number;
  ordering_key: readonly string[];
  chunks: readonly P12SnapshotChunk[];
  output_sha256: string;
  artifact: string;
  sensitive?: readonly P12SensitiveSummary[];
}>;

export type P12SnapshotManifest = Readonly<{
  version: 1;
  run_id: string;
  source_commit: string;
  source_schema_version: string;
  source_schema_sha256: string;
  capture_started_at: string;
  capture_completed_at: string;
  atomic: false;
  warning: string;
  auth_coupled_columns: typeof P12_AUTH_COUPLED_COLUMNS;
  tables: readonly P12SnapshotTableManifest[];
}>;

export type P12SnapshotBundle = Readonly<{
  manifest: P12SnapshotManifest;
  artifacts: Readonly<Record<string, string>>;
}>;

export type SnapshotFetch = (
  input: string | URL,
  init: Readonly<{ method: "GET"; headers: Readonly<Record<string, string>>; signal: AbortSignal }>,
) => Promise<Pick<Response, "ok" | "status" | "text" | "headers">>;

export class P12SnapshotError extends Error {
  readonly code = "P12_SNAPSHOT_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "P12SnapshotError";
  }
}

type SnapshotOptions = Readonly<{
  baseUrl: string;
  serviceRoleKey: string;
  runId: string;
  sourceCommit: string;
  sourceSchemaVersion: string;
  sourceSchemaSha256: string;
  fetch?: SnapshotFetch;
  pageSize?: number;
  signal: AbortSignal;
  now?: () => Date;
  tables?: readonly P12TableDefinition[];
}>;

export async function captureP12Snapshot(options: SnapshotOptions): Promise<P12SnapshotBundle> {
  validateSnapshotOptions(options);
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const artifacts: Record<string, string> = {};
  const manifests: P12SnapshotTableManifest[] = [];
  for (const definition of options.tables ?? P12_TABLES) {
    const captured = await captureTable(definition, options);
    artifacts[definition.table] = captured.content;
    manifests.push(captured.manifest);
  }
  return Object.freeze({
    manifest: Object.freeze({
      version: 1,
      run_id: options.runId,
      source_commit: options.sourceCommit,
      source_schema_version: options.sourceSchemaVersion,
      source_schema_sha256: options.sourceSchemaSha256,
      capture_started_at: startedAt,
      capture_completed_at: now().toISOString(),
      atomic: false,
      warning: P12_NON_ATOMIC_WARNING,
      auth_coupled_columns: P12_AUTH_COUPLED_COLUMNS,
      tables: Object.freeze(manifests),
    }),
    artifacts: Object.freeze(artifacts),
  });
}

async function captureTable(
  definition: P12TableDefinition,
  options: SnapshotOptions,
): Promise<Readonly<{ content: string; manifest: P12SnapshotTableManifest }>> {
  const pageSize = options.pageSize ?? P12_SNAPSHOT_PAGE_SIZE;
  const fetcher = options.fetch ?? globalThis.fetch;
  const rows: Readonly<Record<string, unknown>>[] = [];
  const chunks: P12SnapshotChunk[] = [];
  const identities = new Set<string>();
  let expectedTotal: number | null = null;

  for (let page = 0; page < P12_SNAPSHOT_MAX_PAGES; page += 1) {
    const offset = page * pageSize;
    const url = new URL(`rest/v1/${definition.table}`, normalizedBaseUrl(options.baseUrl));
    url.searchParams.set("select", "*");
    url.searchParams.set("order", definition.orderingKey.map((key) => `${key}.asc`).join(","));
    url.searchParams.set("limit", String(pageSize));
    url.searchParams.set("offset", String(offset));

    let response: Pick<Response, "ok" | "status" | "text" | "headers">;
    try {
      response = await fetcher(url, {
        method: "GET",
        headers: Object.freeze({
          Authorization: `Bearer ${options.serviceRoleKey}`,
          apikey: options.serviceRoleKey,
          Accept: "application/json",
          Prefer: "count=exact",
        }),
        signal: options.signal,
      });
    } catch {
      throw tableError(definition.table, page, "request failed");
    }
    if (!response.ok) throw tableError(definition.table, page, `HTTP ${response.status}`);
    const total = contentRangeTotal(response.headers.get("content-range"));
    if (total === null) throw tableError(definition.table, page, "exact row count is unavailable");
    if (expectedTotal === null) expectedTotal = total;
    if (expectedTotal !== total) throw tableError(definition.table, page, "row count changed during capture");

    let payload: unknown;
    try {
      const responseText = await response.text();
      if (Buffer.byteLength(responseText) > P12_SNAPSHOT_MAX_PAGE_BYTES) {
        throw new P12SnapshotError("page response exceeds the bounded size");
      }
      payload = parseLosslessJson(responseText);
    } catch {
      throw tableError(definition.table, page, "response is not valid JSON");
    }
    if (!Array.isArray(payload) || payload.length > pageSize) {
      throw tableError(definition.table, page, "page payload is invalid");
    }
    const pageRows = payload.map((value, index) => validatedRow(definition, value, page, index));
    for (const row of pageRows) {
      const identity = canonicalJson(definition.orderingKey.map((key) => row[key]));
      if (identities.has(identity)) throw tableError(definition.table, page, "duplicate ordering key");
      identities.add(identity);
      rows.push(row);
    }
    chunks.push(Object.freeze({ page, offset, row_count: pageRows.length }));
    if (rows.length === expectedTotal) break;
    if (pageRows.length === 0 || rows.length > expectedTotal) {
      throw tableError(definition.table, page, "partial or inconsistent export");
    }
    if (page === P12_SNAPSHOT_MAX_PAGES - 1) {
      throw tableError(definition.table, page, "pagination bound exceeded");
    }
  }

  if (expectedTotal === null || rows.length !== expectedTotal) {
    throw new P12SnapshotError(`Snapshot table ${definition.table} is incomplete`);
  }
  const content = canonicalJsonLines(rows);
  const sensitive = sensitiveSummary(definition, rows);
  return Object.freeze({
    content,
    manifest: Object.freeze({
      source_table: definition.table,
      row_count: rows.length,
      ordering_key: definition.orderingKey,
      chunks: Object.freeze(chunks),
      output_sha256: sha256(content),
      artifact: `${definition.table}.jsonl`,
      ...(sensitive.length ? { sensitive: Object.freeze(sensitive) } : {}),
    }),
  });
}

export function publicSnapshotSummary(manifest: P12SnapshotManifest): Readonly<Record<string, unknown>> {
  return Object.freeze({
    status: "ok",
    run_id: manifest.run_id,
    atomic: manifest.atomic,
    warning: manifest.warning,
    capture_started_at: manifest.capture_started_at,
    capture_completed_at: manifest.capture_completed_at,
    tables: manifest.tables.map((tableManifest) => ({
      source_table: tableManifest.source_table,
      row_count: tableManifest.row_count,
      output_sha256: tableManifest.output_sha256,
      sensitive: tableManifest.sensitive,
    })),
  });
}

function sensitiveSummary(
  definition: P12TableDefinition,
  rows: readonly Readonly<Record<string, unknown>>[],
): P12SensitiveSummary[] {
  return (definition.sensitiveColumns ?? []).map((column) => {
    const values = rows.map((row) => row[column]).filter((value) => value !== null && value !== undefined);
    const serialized = canonicalJson(values);
    return Object.freeze({
      column,
      present_rows: values.length,
      serialized_bytes: Buffer.byteLength(serialized),
      sha256: sha256(serialized),
    });
  });
}

function validatedRow(
  definition: P12TableDefinition,
  value: unknown,
  page: number,
  index: number,
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw tableError(definition.table, page, `row ${index} is malformed`);
  const actualColumns = Object.keys(value).sort();
  const expectedColumns = [...definition.columns].sort();
  if (actualColumns.length !== expectedColumns.length ||
      actualColumns.some((column, columnIndex) => column !== expectedColumns[columnIndex])) {
    throw tableError(definition.table, page, `row ${index} does not match the audited schema`);
  }
  for (const key of definition.orderingKey) {
    if (value[key] === null || value[key] === undefined) {
      throw tableError(definition.table, page, `row ${index} has no ordering key`);
    }
  }
  return value;
}

function validateSnapshotOptions(options: SnapshotOptions): void {
  if (!/^[a-z0-9][a-z0-9_]{0,47}$/.test(options.runId)) throw new P12SnapshotError("Snapshot run ID is invalid");
  if (!/^[0-9a-f]{40}$/i.test(options.sourceCommit)) throw new P12SnapshotError("Snapshot source commit is invalid");
  if (!/^[0-9a-f]{64}$/i.test(options.sourceSchemaSha256)) throw new P12SnapshotError("Snapshot schema hash is invalid");
  if (!options.sourceSchemaVersion || options.sourceSchemaVersion.length > 256) throw new P12SnapshotError("Snapshot schema version is invalid");
  if (!options.serviceRoleKey || options.serviceRoleKey.length > 4096) throw new P12SnapshotError("Snapshot source credential is unavailable");
  const pageSize = options.pageSize ?? P12_SNAPSHOT_PAGE_SIZE;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1_000) throw new P12SnapshotError("Snapshot page size is invalid");
  normalizedBaseUrl(options.baseUrl);
}

function normalizedBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    const loopback = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !loopback) || url.username || url.password || url.search || url.hash) throw new Error("invalid");
    url.pathname = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
    return url.toString();
  } catch {
    throw new P12SnapshotError("Snapshot Supabase URL is invalid");
  }
}

function contentRangeTotal(value: string | null): number | null {
  const match = value?.match(/\/(\d+)$/);
  if (!match) return null;
  const total = Number(match[1]);
  return Number.isSafeInteger(total) && total >= 0 ? total : null;
}

function tableError(tableName: string, page: number, detail: string): P12SnapshotError {
  return new P12SnapshotError(`Snapshot table ${tableName} page ${page} ${detail}`);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
