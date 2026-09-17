import { canonicalJson, canonicalJsonLines, isP12JsonNumber, parseLosslessJson, sha256 } from "../data-migration/canonical.js";
import { P12_TABLES, type P12TableDefinition } from "../data-migration/contract.js";
import { NETWORK_HEALTH_SEQUENCE_SQL, snapshotImportValue, snapshotInsertStatement } from "../data-migration/import.js";
import { tableFingerprint } from "../data-migration/verification.js";
import type { P13CutoverRecord, P13ImportEvidence } from "./cutover.js";

export const P13_BOOTSTRAP_BATCH_SIZE = 100;
export const P13_S1_MANIFEST_KIND = "p13_s1_source_snapshot_manifest";
export const P13_APPLICATION_TABLES = Object.freeze([
  "profiles", "traffic_metrics", "flows", "events", "bandwidth_measurements", "hop_measurements",
  "diagnostic_runners", "diagnostic_jobs", "traffic_live_sessions", "traffic_live_snapshots",
  "network_nodes", "network_targets", "network_health_latest", "network_health_samples",
  "network_health_ping_jobs", "network_discovery_sessions", "device_inspection_sessions",
  "managed_telemetry_targets", "managed_device_latest", "managed_interface_latest",
  "managed_observed_hosts_latest",
] as const);
export const P13_MIGRATION_TABLE = "application_schema_migrations";
export const P13_OUTBOX_TABLES = Object.freeze([
  "realtime_outbox", "realtime_projection_watermarks", "cutover_canary",
] as const);
export const P13_SHADOW_TRIGGERS = Object.freeze([
  "shadow_diagnostic_runners", "shadow_diagnostic_jobs", "shadow_network_discovery_sessions",
  "shadow_device_inspection_sessions", "shadow_traffic_live_sessions", "shadow_traffic_live_snapshots",
  "shadow_network_targets", "shadow_network_health_latest", "shadow_network_health_ping_jobs",
  "shadow_events", "shadow_managed_device_latest", "shadow_managed_interface_latest",
  "shadow_managed_observed_hosts_latest", "shadow_profiles", "shadow_network_nodes",
  "shadow_managed_telemetry_targets",
] as const);

const MIGRATION_SHA256 = Object.freeze({
  7: "3bca710e7bde75505af29d5abe1bf858527b0718e38ec329e07211912de23983",
  8: "0067542c718a39bb542c305f09bc891a852050406494fb8996be5440eb5645c5",
} as const);

export type P13ImportMode = "bootstrap" | "delta";
export type P13TargetApplicationState = "empty_application_target" | "accepted_s0_baseline" | "partial_or_unrecognized";
export type P13BootstrapQueryResult = Readonly<{ rows?: readonly Readonly<Record<string, unknown>>[] }>;
export type P13BootstrapQuery = (sql: string, values?: readonly unknown[]) => Promise<P13BootstrapQueryResult>;
export type P13TargetInventory = Readonly<{
  public_relations: readonly string[];
  asset_relations: readonly string[];
  migration_versions: readonly number[];
  s0_baseline_verified: boolean;
}>;
export type P13S1ManifestTable = Readonly<{ table: string; row_count: number; file: string; sha256: string }>;
export type P13S1Bundle = Readonly<{
  source_checkpoint_identity: string;
  tables: readonly P13S1ManifestTable[];
  rows: ReadonlyMap<string, readonly Readonly<Record<string, unknown>>[]>;
}>;

export class P13BootstrapError extends Error {
  readonly code = "P13_BOOTSTRAP_BLOCKED";
  constructor(message: string) { super(message); this.name = "P13BootstrapError"; }
}

export async function bootstrapP13S1(options: Readonly<{
  mode: P13ImportMode;
  record: P13CutoverRecord;
  source_checkpoint_identity: string;
  expected_s1_manifest_sha256: string;
  manifest_text: string;
  artifacts: Readonly<Record<string, string>>;
  migration_007: string;
  migration_008: string;
  query: P13BootstrapQuery;
}>): Promise<P13ImportEvidence> {
  validateBootstrapContract(options);
  if (options.mode !== "bootstrap") throw new P13BootstrapError("The S1 bootstrap command requires explicit bootstrap mode");
  const bundle = parseP13S1Bundle(options.manifest_text, options.artifacts);
  if (bundle.source_checkpoint_identity !== options.source_checkpoint_identity) {
    throw new P13BootstrapError("S1 manifest source checkpoint identity does not match");
  }
  const migration007 = migrationBody(options.migration_007, 7);
  const migration008 = migrationBody(options.migration_008, 8);
  let transactionStarted = false;
  try {
    await options.query("BEGIN");
    transactionStarted = true;
    await options.query(P13_IMPORT_LOCK_SQL);
    validateAdministrativeIdentity(await options.query(P13_ADMIN_TARGET_IDENTITY_SQL));
    const initial = await loadP13TargetInventory(options.query);
    assertP13ImportMode(options.mode, initial);
    const assetBefore = await assetFingerprint(options.query, initial.asset_relations);

    await options.query(migration007);
    await options.query("SET ROLE jhc_netops_owner");
    for (const definition of P12_TABLES) {
      const rows = bundle.rows.get(definition.table) ?? [];
      for (let offset = 0; offset < rows.length; offset += P13_BOOTSTRAP_BATCH_SIZE) {
        const batch = rows.slice(offset, offset + P13_BOOTSTRAP_BATCH_SIZE);
        await options.query(snapshotInsertStatement(definition, batch.length), batch.flatMap((row) =>
          definition.columns.map((column) => snapshotImportValue(definition, column, row[column]))));
      }
    }
    await options.query(NETWORK_HEALTH_SEQUENCE_SQL);
    await options.query("RESET ROLE");

    assertMigrationStage(await loadP13TargetInventory(options.query), [7], false);
    await options.query(migration008);
    const finalInventory = await loadP13TargetInventory(options.query);
    assertMigrationStage(finalInventory, [7, 8], true);
    const tables = await verifyFinalS1Parity(options.query, bundle);
    const outbox = await cleanOutboxEvidence(options.query);
    const assetAfter = await assetFingerprint(options.query, finalInventory.asset_relations);
    if (assetBefore !== assetAfter) throw new P13BootstrapError("asset schema or data changed during P13 bootstrap");

    await options.query("COMMIT");
    transactionStarted = false;
    return Object.freeze({
      version: 1, status: "PASS", mode: "bootstrap", target_state_before: "empty_application_target",
      source_checkpoint_identity: options.source_checkpoint_identity,
      final_snapshot_sha256: options.expected_s1_manifest_sha256,
      target: Object.freeze({ cluster: "16/jhcnetops", port: 5433, database: "jhc_netops", execution_role: "jhc_netops_owner" }),
      tables, s1_parity: "PASS", migration_versions: Object.freeze([7, 8] as const), outbox,
      asset: Object.freeze({ before_sha256: assetBefore, after_sha256: assetAfter, unchanged: true }),
    });
  } catch (error) {
    if (transactionStarted) { try { await options.query("ROLLBACK"); } catch {} }
    if (error instanceof P13BootstrapError) throw error;
    throw new P13BootstrapError("P13 S1 bootstrap failed safely");
  }
}

export function parseP13S1Bundle(manifestText: string, artifacts: Readonly<Record<string, string>>): P13S1Bundle {
  let parsed: unknown;
  try { parsed = parseLosslessJson(manifestText); } catch { throw new P13BootstrapError("S1 manifest is not valid lossless JSON"); }
  if (!isRecord(parsed) || integer(parsed.version, 1, 1) !== 1 || parsed.kind !== P13_S1_MANIFEST_KIND ||
      typeof parsed.source_checkpoint_identity !== "string" || !/^[0-9a-f]{64}$/.test(parsed.source_checkpoint_identity) ||
      integer(parsed.table_count, P13_APPLICATION_TABLES.length, P13_APPLICATION_TABLES.length) !== P13_APPLICATION_TABLES.length ||
      !Array.isArray(parsed.tables) || parsed.tables.length !== P13_APPLICATION_TABLES.length) {
    throw new P13BootstrapError("S1 manifest header is invalid");
  }
  const definitions = new Map(P12_TABLES.map((definition) => [definition.table, definition]));
  if (definitions.size !== P13_APPLICATION_TABLES.length || P13_APPLICATION_TABLES.some((table) => !definitions.has(table))) {
    throw new P13BootstrapError("P13 application allowlist does not match the reviewed import schema");
  }
  const tables: P13S1ManifestTable[] = [];
  const rows = new Map<string, readonly Readonly<Record<string, unknown>>[]>();
  const names = new Set<string>();
  for (const value of parsed.tables) {
    if (!isRecord(value) || typeof value.table !== "string" || !definitions.has(value.table) || names.has(value.table) ||
        typeof value.file !== "string" || value.file !== `tables/${value.table}.json` ||
        typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256) ||
        !(Array.isArray(value.pagination) || isRecord(value.pagination)) ||
        Buffer.byteLength(canonicalJson(value.pagination)) > 64 * 1024) {
      throw new P13BootstrapError("S1 manifest table entry is invalid");
    }
    const rowCount = integer(value.row_count, 0, 10_000_000);
    const content = artifacts[value.table];
    if (typeof content !== "string" || sha256(content) !== value.sha256) {
      throw new P13BootstrapError(`S1 artifact integrity failed for ${value.table}`);
    }
    const tableRows = parseS1Rows(definitions.get(value.table)!, content);
    if (tableRows.length !== rowCount) throw new P13BootstrapError(`S1 row count failed for ${value.table}`);
    names.add(value.table);
    tables.push(Object.freeze({ table: value.table, row_count: rowCount, file: value.file, sha256: value.sha256 }));
    rows.set(value.table, Object.freeze(tableRows));
  }
  if (names.size !== P13_APPLICATION_TABLES.length || P13_APPLICATION_TABLES.some((table) => !names.has(table)) ||
      Object.keys(artifacts).length !== P13_APPLICATION_TABLES.length || Object.keys(artifacts).some((table) => !names.has(table))) {
    throw new P13BootstrapError("S1 manifest/artifact table allowlist is not exact");
  }
  return Object.freeze({ source_checkpoint_identity: parsed.source_checkpoint_identity, tables: Object.freeze(tables), rows });
}

export function classifyP13TargetState(inventory: P13TargetInventory): P13TargetApplicationState {
  validateInventory(inventory);
  const application = new Set(inventory.public_relations.filter((name) => P13_APPLICATION_TABLES.includes(name as typeof P13_APPLICATION_TABLES[number])));
  const hasMigrationTable = inventory.public_relations.includes(P13_MIGRATION_TABLE);
  const outboxCount = P13_OUTBOX_TABLES.filter((name) => inventory.public_relations.includes(name)).length;
  if (inventory.public_relations.length === 0 && application.size === 0 && !hasMigrationTable && outboxCount === 0 &&
      inventory.migration_versions.length === 0) return "empty_application_target";
  if (application.size === P13_APPLICATION_TABLES.length && hasMigrationTable && outboxCount === 0 &&
      inventory.public_relations.length === P13_APPLICATION_TABLES.length + 1 && inventory.s0_baseline_verified &&
      canonicalJson(inventory.migration_versions) === "[7]") return "accepted_s0_baseline";
  return "partial_or_unrecognized";
}

export function assertP13ImportMode(mode: P13ImportMode, inventory: P13TargetInventory): P13TargetApplicationState {
  const state = classifyP13TargetState(inventory);
  if (!inventory.asset_relations.includes("assets")) throw new P13BootstrapError("P13 target does not contain the required asset schema");
  if (mode !== "bootstrap" && mode !== "delta") throw new P13BootstrapError("P13 import mode is invalid");
  if (mode === "bootstrap" && state !== "empty_application_target") throw new P13BootstrapError("Bootstrap mode requires an empty application target");
  if (mode === "delta" && state !== "accepted_s0_baseline") throw new P13BootstrapError("Delta mode requires a verified accepted S0 baseline");
  return state;
}

export function migrationBody(source: string, version: 7 | 8): string {
  if (sha256(source) !== MIGRATION_SHA256[version]) throw new P13BootstrapError(`Migration ${version} source hash is not the reviewed hash`);
  const lines = source.replaceAll("\r\n", "\n").trim().split("\n");
  const transactionLines = lines.map((line, index) => ({ line: line.trim(), index }))
    .filter(({ line }) => line === "BEGIN;" || line === "COMMIT;");
  if (lines[0]?.trim() !== "\\set ON_ERROR_STOP on" || lines[1]?.trim() !== "BEGIN;" || lines.at(-1)?.trim() !== "COMMIT;" ||
      transactionLines.length !== 2 || transactionLines[0]?.index !== 1 || transactionLines[1]?.index !== lines.length - 1 ||
      lines.slice(1).some((line) => line.trim().startsWith("\\"))) {
    throw new P13BootstrapError(`Migration ${version} does not have the reviewed outer transaction wrapper`);
  }
  const body = lines.slice(2, -1).join("\n").trim();
  if (!body.includes("SET ROLE jhc_netops_owner;") ||
      !body.includes(`INSERT INTO public.application_schema_migrations(version) VALUES (${version});`) ||
      /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE|ALTER\s+TABLE|CREATE\s+TABLE|DROP\s+TABLE)\s+asset\./i.test(body)) {
    throw new P13BootstrapError(`Migration ${version} violates the reviewed owner/asset contract`);
  }
  return body;
}

function validateBootstrapContract(options: Readonly<{
  record: P13CutoverRecord; source_checkpoint_identity: string; expected_s1_manifest_sha256: string; manifest_text: string;
}>): void {
  if (options.record.checkpoint !== "CHECKPOINT_1_FINAL_SOURCE_CAPTURED" || options.record.persistence_authority !== "supabase" ||
      options.record.local_authoritative_write_count !== 0 || !/^[0-9a-f]{64}$/.test(options.source_checkpoint_identity) ||
      options.record.source_checkpoint_identity !== options.source_checkpoint_identity || !/^[0-9a-f]{64}$/.test(options.expected_s1_manifest_sha256) ||
      options.record.final_snapshot_sha256 !== options.expected_s1_manifest_sha256 || sha256(options.manifest_text) !== options.expected_s1_manifest_sha256) {
    throw new P13BootstrapError("P13 checkpoint or immutable S1 manifest identity does not match");
  }
}

function parseS1Rows(definition: P12TableDefinition, content: string): Readonly<Record<string, unknown>>[] {
  let value: unknown;
  try { value = parseLosslessJson(content); } catch { throw new P13BootstrapError(`S1 artifact for ${definition.table} is invalid JSON`); }
  if (!Array.isArray(value)) throw new P13BootstrapError(`S1 artifact for ${definition.table} is not an array`);
  const identities = new Set<string>();
  return value.map((row) => {
    if (!isRecord(row)) throw new P13BootstrapError(`S1 artifact for ${definition.table} contains a malformed row`);
    const columns = Object.keys(row).sort();
    const expected = [...definition.columns].sort();
    if (columns.length !== expected.length || columns.some((column, index) => column !== expected[index])) {
      throw new P13BootstrapError(`S1 artifact for ${definition.table} does not match the reviewed schema`);
    }
    const identityValues = definition.orderingKey.map((column) => row[column]);
    if (identityValues.some((entry) => entry === null || entry === undefined)) throw new P13BootstrapError(`S1 artifact for ${definition.table} has a missing canonical key`);
    const identity = canonicalJson(identityValues);
    if (identities.has(identity)) throw new P13BootstrapError(`S1 artifact for ${definition.table} has a duplicate canonical key`);
    identities.add(identity);
    return row;
  });
}

async function loadP13TargetInventory(query: P13BootstrapQuery): Promise<P13TargetInventory> {
  const result = await query(P13_TARGET_INVENTORY_SQL);
  const publicRelations: string[] = [];
  const assetRelations: string[] = [];
  for (const row of result.rows ?? []) {
    const schema = row.schema_name;
    const relation = row.relation_name;
    if ((schema !== "public" && schema !== "asset") || typeof relation !== "string" || !/^[a-z][a-z0-9_]*$/.test(relation)) {
      throw new P13BootstrapError("P13 target inventory is malformed");
    }
    (schema === "public" ? publicRelations : assetRelations).push(relation);
  }
  if (new Set(publicRelations).size !== publicRelations.length || new Set(assetRelations).size !== assetRelations.length) {
    throw new P13BootstrapError("P13 target inventory contains duplicate relations");
  }
  let versions: number[] = [];
  if (publicRelations.includes(P13_MIGRATION_TABLE)) {
    versions = (await query(P13_MIGRATION_VERSIONS_SQL)).rows?.map((row) => integer(row.version, 1, 999)) ?? [];
  }
  return Object.freeze({ public_relations: Object.freeze(publicRelations.sort()), asset_relations: Object.freeze(assetRelations.sort()),
    migration_versions: Object.freeze(versions), s0_baseline_verified: false });
}

function assertMigrationStage(inventory: P13TargetInventory, versions: readonly number[], outboxReady: boolean): void {
  const application = new Set(inventory.public_relations.filter((name) => P13_APPLICATION_TABLES.includes(name as typeof P13_APPLICATION_TABLES[number])));
  const outbox = P13_OUTBOX_TABLES.filter((name) => inventory.public_relations.includes(name));
  if (application.size !== P13_APPLICATION_TABLES.length || canonicalJson(inventory.migration_versions) !== canonicalJson(versions) ||
      (outboxReady ? outbox.length !== P13_OUTBOX_TABLES.length : outbox.length !== 0)) {
    throw new P13BootstrapError("P13 migration stage does not match the required bootstrap order");
  }
}

async function verifyFinalS1Parity(query: P13BootstrapQuery, bundle: P13S1Bundle): Promise<P13ImportEvidence["tables"]> {
  const evidence: P13ImportEvidence["tables"][number][] = [];
  const manifest = new Map(bundle.tables.map((table) => [table.table, table]));
  for (const definition of P12_TABLES) {
    const expected = bundle.rows.get(definition.table) ?? [];
    const actual = await loadTargetRows(query, definition);
    const expectedFingerprint = tableFingerprint(expected, definition.orderingKey);
    const actualFingerprint = tableFingerprint(actual, definition.orderingKey);
    const expectedKeys = keysetSha256(expected, definition.orderingKey);
    const actualKeys = keysetSha256(actual, definition.orderingKey);
    const artifact = manifest.get(definition.table);
    if (!artifact || actual.length !== expected.length || actualKeys !== expectedKeys || actualFingerprint.sha256 !== expectedFingerprint.sha256) {
      throw new P13BootstrapError(`Final S1 parity failed for ${definition.table}`);
    }
    evidence.push(Object.freeze({ table: definition.table, row_count: actual.length, artifact_sha256: artifact.sha256,
      keyset_sha256: actualKeys, content_sha256: actualFingerprint.sha256 }));
  }
  return Object.freeze(evidence);
}

async function loadTargetRows(query: P13BootstrapQuery, definition: P12TableDefinition): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const countResult = await query(`SELECT count(*)::text AS row_count FROM public.${quoteIdentifier(definition.table)}`);
  const count = integer(countResult.rows?.[0]?.row_count, 0, 10_000_000);
  const rows: Readonly<Record<string, unknown>>[] = [];
  for (let offset = 0; offset < count; offset += 500) {
    const columns = definition.columns.map(quoteIdentifier).join(", ");
    const ordering = definition.orderingKey.map(quoteIdentifier).join(", ");
    const result = await query(`SELECT row_to_json(p13_row)::text AS row_json FROM (SELECT ${columns} FROM public.${quoteIdentifier(definition.table)} ORDER BY ${ordering} LIMIT $1 OFFSET $2) p13_row`, [500, offset]);
    const page = result.rows ?? [];
    if (!page.length || page.length > 500) throw new P13BootstrapError(`Final S1 rows are incomplete for ${definition.table}`);
    rows.push(...page.map((row) => parseTargetRow(definition, row.row_json)));
  }
  if (rows.length !== count) throw new P13BootstrapError(`Final S1 row count changed for ${definition.table}`);
  return Object.freeze(rows);
}

function parseTargetRow(definition: P12TableDefinition, value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "string") throw new P13BootstrapError(`Final S1 row is malformed for ${definition.table}`);
  let parsed: unknown;
  try { parsed = parseLosslessJson(value); } catch { throw new P13BootstrapError(`Final S1 row is invalid for ${definition.table}`); }
  if (!isRecord(parsed) || canonicalJson(Object.keys(parsed).sort()) !== canonicalJson([...definition.columns].sort())) {
    throw new P13BootstrapError(`Final S1 row schema is invalid for ${definition.table}`);
  }
  return parsed;
}

function keysetSha256(rows: readonly Readonly<Record<string, unknown>>[], keys: readonly string[]): string {
  const keyRows = rows.map((row) => Object.freeze(Object.fromEntries(keys.map((key) => [key, row[key]]))))
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  return sha256(canonicalJsonLines(keyRows));
}

async function cleanOutboxEvidence(query: P13BootstrapQuery): Promise<P13ImportEvidence["outbox"]> {
  const row = (await query(P13_OUTBOX_STATE_SQL)).rows?.[0];
  if (!row) throw new P13BootstrapError("P13 outbox state is unavailable");
  const triggers = ((await query(P13_SHADOW_TRIGGER_SQL)).rows ?? []).map(({ trigger_name }) => trigger_name).sort();
  if (triggers.some((name) => typeof name !== "string") || canonicalJson(triggers) !== canonicalJson([...P13_SHADOW_TRIGGERS].sort())) {
    throw new P13BootstrapError("P13 shadow trigger set is incomplete or unexpected");
  }
  const outbox = Object.freeze({ total_count: integer(row.total_count, 0, 10_000_000),
    pending_count: integer(row.pending_count, 0, 10_000_000),
    failed_count: integer(row.failed_count, 0, 10_000_000), watermark_count: integer(row.watermark_count, 0, 10_000_000),
    canary_count: integer(row.canary_count, 0, 10_000_000), shadow_trigger_count: triggers.length });
  if ([outbox.total_count, outbox.pending_count, outbox.failed_count, outbox.watermark_count, outbox.canary_count]
      .some((count) => count !== 0)) {
    throw new P13BootstrapError("P13 bootstrap outbox is not clean");
  }
  return outbox;
}

async function assetFingerprint(query: P13BootstrapQuery, tables: readonly string[]): Promise<string> {
  if (!tables.length || tables.length > 64) throw new P13BootstrapError("asset relation inventory is invalid");
  const schemaRows = (await query(P13_ASSET_SCHEMA_IDENTITY_SQL)).rows ?? [];
  const schemaTables = new Set(schemaRows.map(({ table_name }) => table_name));
  if (schemaRows.length > 10_000 || schemaTables.size !== tables.length || tables.some((table) => !schemaTables.has(table))) {
    throw new P13BootstrapError("asset schema identity is incomplete");
  }
  const normalizedSchema = schemaRows.map((row) => canonicalJson(row)).sort();
  const evidence: Array<Readonly<{ table: string; row_count: number; sha256: string }>> = [];
  let totalBytes = normalizedSchema.reduce((total, row) => total + Buffer.byteLength(row), 0);
  for (const table of [...tables].sort()) {
    const result = await query(`SELECT row_to_json(asset_row)::text AS row_json FROM (SELECT * FROM asset.${quoteIdentifier(table)}) asset_row`);
    const rows = (result.rows ?? []).map((row) => {
      if (typeof row.row_json !== "string") throw new P13BootstrapError("asset evidence row is malformed");
      let parsed: unknown;
      try { parsed = parseLosslessJson(row.row_json); } catch { throw new P13BootstrapError("asset evidence row is invalid JSON"); }
      const canonical = canonicalJson(parsed);
      totalBytes += Buffer.byteLength(canonical);
      if (totalBytes > 256 * 1024 * 1024) throw new P13BootstrapError("asset evidence exceeds the bounded size");
      return canonical;
    }).sort();
    if (rows.length > 1_000_000) throw new P13BootstrapError("asset evidence row count exceeds the bound");
    evidence.push(Object.freeze({ table, row_count: rows.length, sha256: sha256(rows.join("\n")) }));
  }
  return sha256(canonicalJson({ schema: normalizedSchema, tables: evidence }));
}

function validateAdministrativeIdentity(result: P13BootstrapQueryResult): void {
  const row = result.rows?.[0];
  if (!row || result.rows?.length !== 1 || row.database_name !== "jhc_netops" || row.server_port !== 5433 ||
      !["", "127.0.0.1", "::1"].includes(String(row.server_address)) || row.login_role !== "postgres" ||
      row.data_directory !== "/var/lib/postgresql/16/jhcnetops") {
    throw new P13BootstrapError("P13 administrative connection is not the exact dedicated target");
  }
}

function validateInventory(inventory: P13TargetInventory): void {
  for (const relations of [inventory.public_relations, inventory.asset_relations]) {
    if (!Array.isArray(relations) || relations.length > 256 || new Set(relations).size !== relations.length ||
        relations.some((name) => typeof name !== "string" || !/^[a-z][a-z0-9_]*$/.test(name))) {
      throw new P13BootstrapError("P13 target relation inventory is invalid");
    }
  }
  if (typeof inventory.s0_baseline_verified !== "boolean" || !Array.isArray(inventory.migration_versions) ||
      inventory.migration_versions.length > 16 || inventory.migration_versions.some((version) => !Number.isSafeInteger(version) || version < 1 || version > 999)) {
    throw new P13BootstrapError("P13 migration version inventory is invalid");
  }
}

function integer(value: unknown, minimum: number, maximum: number): number {
  const text = isP12JsonNumber(value) ? value.raw : value;
  const numeric = typeof text === "string" && /^\d+$/.test(text) ? Number(text) : text;
  if (!Number.isSafeInteger(numeric) || (numeric as number) < minimum || (numeric as number) > maximum) {
    throw new P13BootstrapError("P13 bounded integer evidence is invalid");
  }
  return numeric as number;
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new P13BootstrapError("P13 SQL identifier is invalid");
  return `"${value}"`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const P13_IMPORT_LOCK_SQL = "SELECT pg_advisory_xact_lock(743130013)";
export const P13_ADMIN_TARGET_IDENTITY_SQL = `SELECT current_database()::text AS database_name,
  current_setting('port')::integer AS server_port, COALESCE(host(inet_server_addr()), '') AS server_address,
  session_user::text AS login_role, current_setting('data_directory')::text AS data_directory`.trim();
export const P13_TARGET_INVENTORY_SQL = `SELECT n.nspname::text AS schema_name, c.relname::text AS relation_name
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public','asset') AND c.relkind IN ('r','p') ORDER BY n.nspname,c.relname`.trim();
export const P13_MIGRATION_VERSIONS_SQL = "SELECT version FROM public.application_schema_migrations ORDER BY version";
export const P13_OUTBOX_STATE_SQL = `SELECT count(*)::text AS total_count,
  count(*) FILTER (WHERE status = 'pending')::text AS pending_count,
  count(*) FILTER (WHERE status = 'failed')::text AS failed_count,
  (SELECT count(*)::text FROM public.realtime_projection_watermarks) AS watermark_count,
  (SELECT count(*)::text FROM public.cutover_canary) AS canary_count FROM public.realtime_outbox`.trim();
export const P13_SHADOW_TRIGGER_SQL = `SELECT t.tgname::text AS trigger_name FROM pg_catalog.pg_trigger t
  JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND NOT t.tgisinternal AND t.tgname LIKE 'shadow_%' ORDER BY t.tgname`.trim();
export const P13_ASSET_SCHEMA_IDENTITY_SQL = `SELECT kind,table_name,identity,definition FROM (
  SELECT 'column'::text AS kind,c.relname::text AS table_name,a.attnum::text AS identity,
    concat_ws('|',a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod),a.attnotnull::text,
      COALESCE(pg_catalog.pg_get_expr(d.adbin,d.adrelid),''))::text AS definition
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
  WHERE n.nspname='asset' AND c.relkind IN ('r','p')
  UNION ALL SELECT 'constraint',c.relname,co.oid::text,pg_catalog.pg_get_constraintdef(co.oid,true)
  FROM pg_catalog.pg_constraint co JOIN pg_catalog.pg_class c ON c.oid=co.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='asset'
  UNION ALL SELECT 'index',c.relname,i.indexrelid::text,pg_catalog.pg_get_indexdef(i.indexrelid)
  FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indrelid
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='asset'
  UNION ALL SELECT 'trigger',c.relname,t.oid::text,pg_catalog.pg_get_triggerdef(t.oid,true)
  FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='asset' AND NOT t.tgisinternal
) identity_rows ORDER BY kind,table_name,identity,definition`.trim();
