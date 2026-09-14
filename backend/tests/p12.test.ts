import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { canonicalJsonLines, P12JsonNumber, parseLosslessJson, sha256 } from "../src/p12/canonical.js";
import {
  P12_AUTH_COUPLED_COLUMNS,
  P12_IMPORT_ORDER,
  P12_TABLES,
  type P12TableDefinition,
} from "../src/p12/contract.js";
import {
  importP12Snapshot,
  NETWORK_HEALTH_SEQUENCE_SQL,
  P12_TARGET_IDENTITY_SQL,
  parseSnapshotBundle,
  p12ImportOrder,
  type P12ImportQuery,
} from "../src/p12/import.js";
import {
  captureP12Snapshot,
  P12_NON_ATOMIC_WARNING,
  P12SnapshotError,
  publicSnapshotSummary,
  type P12SnapshotBundle,
  type P12SnapshotManifest,
  type SnapshotFetch,
} from "../src/p12/snapshot.js";
import { loadP12Target, P12TargetError, parseP12Target, p12DatabaseForRun } from "../src/p12/target.js";

const RUN_ID = "run01";
const DATABASE = "jhc_netops_p12_run01";
const TARGET_URL = `postgresql://p12_app:fixture-password@127.0.0.1:5433/${DATABASE}`;
const SOURCE_COMMIT = "a".repeat(40);
const SCHEMA_HASH = "b".repeat(64);
const FIXTURE_TABLE = Object.freeze({
  table: "fixture_rows",
  columns: Object.freeze(["id", "value", "optional"]),
  orderingKey: Object.freeze(["id"]),
}) satisfies P12TableDefinition;

test("P12 target guard accepts only the exact loopback rehearsal contract", () => {
  assert.equal(p12DatabaseForRun(RUN_ID), DATABASE);
  assert.deepEqual(parseP12Target(RUN_ID, TARGET_URL), {
    runId: RUN_ID,
    database: DATABASE,
    host: "127.0.0.1",
    port: 5433,
    connectionString: TARGET_URL,
  });
});

for (const [label, runId, url] of [
  ["live database", RUN_ID, "postgresql://p12_app:x@127.0.0.1:5433/jhc_netops"],
  ["postgres database", RUN_ID, "postgresql://p12_app:x@127.0.0.1:5433/postgres"],
  ["template0 database", RUN_ID, "postgresql://p12_app:x@127.0.0.1:5433/template0"],
  ["template1 database", RUN_ID, "postgresql://p12_app:x@127.0.0.1:5433/template1"],
  ["invalid name", "../bad", TARGET_URL],
  ["port 5432", RUN_ID, `postgresql://p12_app:x@127.0.0.1:5432/${DATABASE}`],
  ["non-loopback", RUN_ID, `postgresql://p12_app:x@192.168.1.130:5433/${DATABASE}`],
] as const) {
  test(`P12 target guard rejects ${label}`, () => {
    assert.throws(() => parseP12Target(runId, url), P12TargetError);
  });
}

test("P12 target configuration never falls back to DATABASE_URL", () => {
  assert.throws(() => loadP12Target({ DATABASE_URL: TARGET_URL }), (error: unknown) =>
    error instanceof P12TargetError && /never used as fallback/.test(error.message));
});

test("snapshot page size cannot exceed its bounded contract", async () => {
  await assert.rejects(
    () => capture(fixtureOptions(async () => response([], "*/0"), [FIXTURE_TABLE], 1_001)),
    /page size is invalid/,
  );
});

test("snapshot is GET-only, deterministically ordered, bounded, and handles multiple pages", async () => {
  const calls: { url: URL; method: string; authorization: string | undefined }[] = [];
  const rows = [
    { id: "a", value: { z: 2, a: 1 }, optional: null },
    { id: "b", value: [2, 1], optional: "x" },
    { id: "c", value: true, optional: null },
  ];
  const fetcher: SnapshotFetch = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, method: init.method, authorization: init.headers.Authorization });
    const offset = Number(url.searchParams.get("offset"));
    const page = rows.slice(offset, offset + 2);
    return response(page, `${offset}-${Math.max(offset, offset + page.length - 1)}/${rows.length}`);
  };
  const bundle = await capture(fixtureOptions(fetcher, [FIXTURE_TABLE], 2));
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.method === "GET"));
  assert.ok(calls.every((call) => call.url.searchParams.get("order") === "id.asc"));
  assert.ok(calls.every((call) => call.url.searchParams.get("limit") === "2"));
  assert.equal(bundle.manifest.tables[0]?.row_count, 3);
  assert.deepEqual(bundle.manifest.tables[0]?.chunks.map((chunk) => chunk.row_count), [2, 1]);
  assert.equal(bundle.artifacts.fixture_rows, canonicalJsonLines(rows));
});

test("snapshot handles an empty table and records a stable empty hash", async () => {
  const bundle = await capture(fixtureOptions(async () => response([], "*/0"), [FIXTURE_TABLE]));
  assert.equal(bundle.artifacts.fixture_rows, "");
  assert.equal(bundle.manifest.tables[0]?.row_count, 0);
  assert.equal(bundle.manifest.tables[0]?.output_sha256, sha256(""));
});

test("snapshot fails explicitly on a partial page without leaking source credentials", async () => {
  const secret = "source-secret-that-must-never-appear";
  let call = 0;
  const fetcher: SnapshotFetch = async () => {
    call += 1;
    if (call === 1) return response([
      { id: "a", value: 1, optional: null },
      { id: "b", value: 2, optional: null },
    ], "0-1/3");
    return response({ message: secret }, "2-2/3", 500);
  };
  await assert.rejects(
    () => capture(fixtureOptions(fetcher, [FIXTURE_TABLE], 2, secret)),
    (error: unknown) => error instanceof P12SnapshotError && /HTTP 500/.test(error.message) && !error.message.includes(secret),
  );
});

test("snapshot rejects malformed/schema-drift rows instead of silently skipping them", async () => {
  await assert.rejects(
    () => capture(fixtureOptions(async () => response([{ id: "a", value: 1 }], "0-0/1"), [FIXTURE_TABLE])),
    (error: unknown) => error instanceof P12SnapshotError && /audited schema/.test(error.message),
  );
});

test("canonical snapshot hash is independent of object property insertion order", () => {
  const left = canonicalJsonLines([{ id: "a", value: { z: 2, a: 1 } }]);
  const right = canonicalJsonLines([{ value: { a: 1, z: 2 }, id: "a" }]);
  assert.equal(left, right);
  assert.equal(sha256(left), sha256(right));
});

test("lossless snapshot parsing preserves bigint and nested JSON numeric literals", () => {
  const raw = '{"counter":900719925474099312345,"payload":{"value":12345678901234567890}}';
  const parsed = parseLosslessJson(raw);
  assert.equal(canonicalJsonLines([parsed as Readonly<Record<string, unknown>>]), `${raw}\n`);
});

test("legacy SNMP bytea is preserved only in the artifact and redacted from human summary", async () => {
  const definition = Object.freeze({
    table: "managed_telemetry_targets",
    columns: Object.freeze(["id", "snmp2c_community_encrypted"]),
    orderingKey: Object.freeze(["id"]),
    sensitiveColumns: Object.freeze(["snmp2c_community_encrypted"]),
  }) satisfies P12TableDefinition;
  const rawOpaqueValue = "\\x73656e736974697665";
  const bundle = await capture(fixtureOptions(
    async () => response([{ id: "target", snmp2c_community_encrypted: rawOpaqueValue }], "0-0/1"),
    [definition],
  ));
  assert.match(bundle.artifacts.managed_telemetry_targets ?? "", /73656e736974697665/);
  const summary = JSON.stringify(publicSnapshotSummary(bundle.manifest));
  assert.doesNotMatch(summary, /73656e736974697665/);
  assert.equal(bundle.manifest.tables[0]?.sensitive?.[0]?.present_rows, 1);
});

test("import order matches the audited FK dependency order and never targets asset schema", async () => {
  const bundle = fixtureImportBundle({
    profiles: [fixtureRow("profiles", { id: "11111111-1111-4111-8111-111111111111", approved_by: null })],
    diagnostic_runners: [fixtureRow("diagnostic_runners", { id: "runner-text-key" })],
  });
  const statements: { sql: string; values?: readonly unknown[] }[] = [];
  const query: P12ImportQuery = async (sql, values) => {
    statements.push({ sql, ...(values ? { values } : {}) });
    return queryResult(sql);
  };
  const result = await importP12Snapshot({ target: parseP12Target(RUN_ID, TARGET_URL), bundle, query });
  assert.deepEqual(p12ImportOrder(), P12_IMPORT_ORDER);
  const inserts = statements.filter(({ sql }) => sql.startsWith("INSERT"));
  assert.match(inserts[0]?.sql ?? "", /public\."profiles"/);
  assert.match(inserts[1]?.sql ?? "", /public\."diagnostic_runners"/);
  assert.ok(statements.every(({ sql }) => !/\basset\./.test(sql)));
  assert.equal(result.imported_rows, 2);
  assert.equal(statements[0]?.sql, P12_TARGET_IDENTITY_SQL);
  assert.equal(statements[1]?.sql, "BEGIN");
  assert.equal(statements.at(-1)?.sql, "COMMIT");
  assert.ok(statements.some(({ sql }) => sql === NETWORK_HEALTH_SEQUENCE_SQL));
});

test("import preserves UUIDs, text keys, Auth UUIDs, timestamps, nulls, and JSON values", async () => {
  const authId = "11111111-1111-4111-8111-111111111111";
  const timestamp = "2026-09-14T01:02:03.456Z";
  const json = { nested: [1, null, { safe: true }] };
  const bundle = fixtureImportBundle({
    profiles: [fixtureRow("profiles", { id: authId, created_at: timestamp, approved_by: null })],
    diagnostic_jobs: [fixtureRow("diagnostic_jobs", { id: "22222222-2222-4222-8222-222222222222", requested_by: authId, progress: json })],
  });
  const values: unknown[] = [];
  await importP12Snapshot({
    target: parseP12Target(RUN_ID, TARGET_URL),
    bundle,
    query: async (sql, parameters) => { if (parameters) values.push(...parameters); return queryResult(sql); },
  });
  assert.ok(values.includes(authId));
  assert.ok(values.includes(timestamp));
  assert.ok(values.includes(null));
  const jsonValue = values.find((value) => typeof value === "string" && value.includes("nested"));
  if (typeof jsonValue !== "string") assert.fail("JSONB import parameter was not preserved");
  assert.deepEqual(JSON.parse(jsonValue), json);
});

test("import binds unsafe PostgreSQL bigint and JSONB numeric content without JavaScript rounding", async () => {
  const unsafe = "900719925474099312345";
  const jsonUnsafe = "123456789012345678901";
  const row = fixtureRow("traffic_metrics", {
    id: "44444444-4444-4444-8444-444444444444",
    bytes_in: new P12JsonNumber(unsafe),
    protocol_breakdown: { exact: new P12JsonNumber(jsonUnsafe) },
  });
  const values: unknown[] = [];
  await importP12Snapshot({
    target: parseP12Target(RUN_ID, TARGET_URL),
    bundle: fixtureImportBundle({ traffic_metrics: [row] }),
    query: async (sql, parameters) => { if (parameters) values.push(...parameters); return queryResult(sql); },
  });
  assert.ok(values.includes(unsafe));
  assert.ok(values.includes(`{"exact":${jsonUnsafe}}`));
});

test("import failure rolls back and reports only the table boundary", async () => {
  const rawSecret = "opaque-value-must-not-leak";
  const bundle = fixtureImportBundle({
    managed_telemetry_targets: [fixtureRow("managed_telemetry_targets", {
      id: "33333333-3333-4333-8333-333333333333",
      snmp2c_community_encrypted: rawSecret,
    })],
  });
  const statements: string[] = [];
  await assert.rejects(
    () => importP12Snapshot({
      target: parseP12Target(RUN_ID, TARGET_URL),
      bundle,
      query: async (sql) => {
        statements.push(sql);
        if (sql.includes('public."managed_telemetry_targets"')) throw new Error(rawSecret);
        return queryResult(sql);
      },
    }),
    (error: unknown) => error instanceof Error && /managed_telemetry_targets/.test(error.message) && !error.message.includes(rawSecret),
  );
  assert.equal(statements.at(-1), "ROLLBACK");
  assert.ok(!statements.includes("COMMIT"));
});

test("snapshot integrity validation fails before import queries", async () => {
  const bundle = fixtureImportBundle();
  const corrupt = { ...bundle, artifacts: { ...bundle.artifacts, profiles: "{}\n" } };
  let called = false;
  await assert.rejects(() => importP12Snapshot({
    target: parseP12Target(RUN_ID, TARGET_URL),
    bundle: corrupt,
    query: async () => { called = true; return {}; },
  }), /integrity validation/);
  assert.equal(called, false);
});

test("connected target identity is verified before BEGIN or any write", async () => {
  const statements: string[] = [];
  await assert.rejects(() => importP12Snapshot({
    target: parseP12Target(RUN_ID, TARGET_URL),
    bundle: fixtureImportBundle(),
    query: async (sql) => {
      statements.push(sql);
      return { rows: [{ database_name: "jhc_netops", server_port: 5433, server_address: "127.0.0.1" }] };
    },
  }), /target identity preflight/);
  assert.deepEqual(statements, [P12_TARGET_IDENTITY_SQL]);
});

test("rehearsal schema preserves application tables without Auth, Realtime, cron, or asset mutation", () => {
  const schema = readFileSync(new URL("../migrations/p12/001_supabase_application_schema.sql", import.meta.url), "utf8");
  for (const definition of P12_TABLES) assert.match(schema, new RegExp(`CREATE TABLE public\\.${definition.table}\\b`, "i"));
  assert.doesNotMatch(schema, /CREATE\s+SCHEMA\s+asset|ALTER\s+TABLE\s+asset\.|auth\.users|supabase_realtime|cron\./i);
  assert.match(schema, /requested_by uuid NOT NULL/);
  assert.match(schema, /snmp2c_community_encrypted bytea/);
});

test("operator wrapper hard-codes the dedicated cluster and exact-manifest destruction guard", () => {
  const script = readFileSync(new URL("../../deploy/postgresql/p12/p12-rehearsal-db.sh", import.meta.url), "utf8");
  assert.match(script, /readonly CLUSTER="jhcnetops"/);
  assert.match(script, /readonly PORT="5433"/);
  assert.match(script, /--cluster "\$\{PG_VERSION\}\/\$\{CLUSTER\}"/);
  assert.match(script, /destroy requires the exact manifest database name/);
  assert.match(script, /--dbname "\$\{LIVE_DATABASE\}" --schema asset --format custom --serializable-deferrable/);
  assert.match(script, /--dbname "\$\{DATABASE\}" --exit-on-error --single-transaction/);
  assert.doesNotMatch(script, /--force/);
});

test("operator wrapper captures one immutable local baseline and reuses it for each restore", () => {
  const script = readFileSync(new URL("../../deploy/postgresql/p12/p12-rehearsal-db.sh", import.meta.url), "utf8");
  assert.match(script, /if \[\[ ! -f "\$\{BASELINE_DUMP\}" \]\]; then/);
  assert.equal(script.match(/\bpg_dump\b/g)?.length, 1);
  assert.match(script, /baseline_hash="\$\(sha256sum "\$\{BASELINE_DUMP\}"/);
  assert.match(script, /grep -Fxq "\$\{baseline_hash\}  asset-baseline\.dump" "\$\{BASELINE_HASH_MANIFEST\}" \|\| fail "local baseline artifact identity changed"/);
  assert.match(script, /pg_restore[\s\S]*"\$\{BASELINE_DUMP\}"/);
});

test("P12 runbook keeps live NetOps and unrelated PM2 processes untouched", () => {
  const runbook = readFileSync(new URL("../../deploy/postgresql/p12/README.md", import.meta.url), "utf8");
  assert.match(runbook, /without changing the\s+`current` symlink/);
  assert.match(runbook, /leave\s+`jhc-netops-backend`, `jhc-netops-frontend`, and `jhc-netops-runner` running/);
  assert.match(runbook, /No PM2 stop or restart is required for P12/);
  for (const processName of ["cf-tunnel", "diva-voice", "kiosk JHC new", "ollama-server"]) {
    assert.match(runbook, new RegExp(`\\b${processName.replaceAll(" ", "\\s+")}\\b`));
  }
  assert.doesNotMatch(runbook, /^\s*pm2\s+(?:stop|restart)\b/im);
  assert.match(runbook, /manifest records the capture start\/end window/);
  assert.match(runbook, /cross-table drift risk[\s\S]*reported as P12 evidence/);
});

function fixtureOptions(
  fetcher: SnapshotFetch,
  tables: readonly P12TableDefinition[],
  pageSize = 500,
  serviceRoleKey = "fixture-service-role-key",
) {
  return {
    baseUrl: "https://fixture.supabase.co",
    serviceRoleKey,
    runId: RUN_ID,
    sourceCommit: SOURCE_COMMIT,
    sourceSchemaVersion: "202609040001_operator_rbac.sql",
    sourceSchemaSha256: SCHEMA_HASH,
    fetch: fetcher,
    pageSize,
    signal: new AbortController().signal,
    tables,
    now: () => new Date("2026-09-14T01:02:03.000Z"),
  } as const;
}

async function capture(options: ReturnType<typeof fixtureOptions>) {
  return captureP12Snapshot(options);
}

function response(payload: unknown, contentRange: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-range": contentRange }),
    async text() { return JSON.stringify(payload); },
  };
}

function fixtureImportBundle(
  overrides: Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>> = {},
): P12SnapshotBundle {
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
    version: 1,
    run_id: RUN_ID,
    source_commit: SOURCE_COMMIT,
    source_schema_version: "fixture",
    source_schema_sha256: SCHEMA_HASH,
    capture_started_at: "2026-09-14T01:02:03.000Z",
    capture_completed_at: "2026-09-14T01:02:04.000Z",
    atomic: false,
    warning: P12_NON_ATOMIC_WARNING,
    auth_coupled_columns: P12_AUTH_COUPLED_COLUMNS,
    tables,
  };
  return { manifest, artifacts };
}

function fixtureRow(tableName: string, values: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const definition = P12_TABLES.find(({ table }) => table === tableName);
  assert.ok(definition);
  return Object.freeze({ ...Object.fromEntries(definition.columns.map((column) => [column, null])), ...values });
}

function queryResult(sql: string) {
  return sql === P12_TARGET_IDENTITY_SQL
    ? { rows: [{ database_name: DATABASE, server_port: 5433, server_address: "127.0.0.1" }] }
    : {};
}

test("manifest records all Auth-coupled UUID columns without creating fake users", () => {
  const bundle = fixtureImportBundle();
  assert.deepEqual(bundle.manifest.auth_coupled_columns, P12_AUTH_COUPLED_COLUMNS);
  assert.doesNotThrow(() => parseSnapshotBundle(bundle.manifest, bundle.artifacts));
});
