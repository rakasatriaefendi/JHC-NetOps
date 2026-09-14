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
      transaction_read_only: "on",
      ...overrides,
    }];
    return POSTGRES_BASELINE_OBJECTS
      .map((name) => ({ object_name: name, object_exists: !missing.includes(name) }));
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
  assert.match(fake.statements[0] ?? "", /host\(inet_server_addr\(\)\)/);
  assert.doesNotMatch(fake.statements[0] ?? "", /data_directory/);
  assert.match(fake.statements[1] ?? "", /to_regclass\(required\.object_name\) IS NOT NULL AS object_exists/);
  assert.doesNotMatch(fake.statements[1] ?? "", /::text\s+AS\s+resolved_name/i);
  for (const statement of fake.statements) {
    assert.match(statement.trim(), /^SELECT\b/i);
    assert.doesNotMatch(statement, /\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|COPY)\b/i);
  }
});

test("read-only preflight accepts normalized IPv6 loopback", async () => {
  const fake = foundationQuery({ server_address: "::1" });
  await assert.doesNotReject(() => verifyPostgresFoundation(fake.query));
});

for (const [name, overrides, expected] of [
  ["wrong database", { database_name: "mercure" }, /database identity/],
  ["shared port 5432", { server_port: 5432 }, /dedicated port 5433/],
  ["unauthorized role", { role_name: "postgres" }, /runtime role/],
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
  const fake = foundationQuery({}, ["asset.medical_service_records", "asset.medical_service_record_number_seq"]);
  await assert.rejects(() => verifyPostgresFoundation(fake.query), (error: unknown) =>
    error instanceof PostgresFoundationError && /2 object\(s\) missing/.test(error.message));
  assert.equal(fake.statements.length, 2);
});
