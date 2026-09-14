import assert from "node:assert/strict";
import test from "node:test";

import {
  POSTGRES_BASELINE_OBJECTS,
  POSTGRES_FOUNDATION,
  PostgresFoundationError,
  type FoundationQuery,
  verifyPostgresFoundation,
} from "../src/postgres-foundation.js";

type IdentityOverrides = Partial<Readonly<{
  database_name: string;
  role_name: string;
  server_port: number;
  server_address: string;
  data_directory: string;
  transaction_read_only: string;
}>>;

function foundationQuery(overrides: IdentityOverrides = {}, missing: readonly string[] = []) {
  const statements: string[] = [];
  const query: FoundationQuery = async (sql) => {
    statements.push(sql);
    if (statements.length === 1) return [{
      database_name: POSTGRES_FOUNDATION.database,
      role_name: POSTGRES_FOUNDATION.role,
      server_port: POSTGRES_FOUNDATION.port,
      server_address: "127.0.0.1",
      data_directory: POSTGRES_FOUNDATION.dataDirectory,
      transaction_read_only: "on",
      ...overrides,
    }];
    return POSTGRES_BASELINE_OBJECTS
      .filter((name) => !missing.includes(name))
      .map((name) => ({ object_name: name, resolved_name: name }));
  };
  return { query, statements };
}

test("read-only preflight accepts the dedicated PostgreSQL 16/jhcnetops baseline", async () => {
  const fake = foundationQuery();
  const result = await verifyPostgresFoundation(fake.query);

  assert.deepEqual(result, {
    database: "jhc_netops",
    role: "jhc_netops_app",
    port: 5433,
    readOnly: true,
    baselineObjectCount: POSTGRES_BASELINE_OBJECTS.length,
  });
  assert.equal(fake.statements.length, 2);
  for (const statement of fake.statements) {
    assert.match(statement.trim(), /^SELECT\b/i);
    assert.doesNotMatch(statement, /\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|COPY)\b/i);
  }
});

for (const [name, overrides, expected] of [
  ["wrong database", { database_name: "mercure" }, /database identity/],
  ["shared port 5432", { server_port: 5432 }, /dedicated port 5433/],
  ["unauthorized role", { role_name: "postgres" }, /runtime role/],
  ["wrong data directory", { data_directory: "/var/lib/postgresql/16/main" }, /cluster 16\/jhcnetops/],
  ["non-loopback server", { server_address: "192.168.1.130" }, /loopback/],
  ["writable session", { transaction_read_only: "off" }, /not read-only/],
] as const) {
  test(`preflight rejects ${name}`, async () => {
    const fake = foundationQuery(overrides);
    await assert.rejects(() => verifyPostgresFoundation(fake.query), (error: unknown) =>
      error instanceof PostgresFoundationError && expected.test(error.message));
    assert.equal(fake.statements.length, 1);
  });
}

test("preflight rejects an incomplete established migration baseline without repairing it", async () => {
  const fake = foundationQuery({}, ["asset.medical_service_records"]);
  await assert.rejects(() => verifyPostgresFoundation(fake.query), (error: unknown) =>
    error instanceof PostgresFoundationError && /1 object\(s\) missing/.test(error.message));
  assert.equal(fake.statements.length, 2);
});

