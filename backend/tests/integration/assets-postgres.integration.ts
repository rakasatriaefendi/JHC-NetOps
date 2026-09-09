import assert from "node:assert/strict";
import test from "node:test";

import { Pool } from "pg";

import { PostgresAssetRepository } from "../../src/assets/repository.js";

const optedIn = process.env.P10C_POSTGRES_TEST_OPT_IN === "1";

test("opt-in Asset Inventory repository reads the dedicated PostgreSQL contract", { skip: !optedIn }, async () => {
  const connectionString = dedicatedTestDatabaseUrl(process.env.P10C_TEST_DATABASE_URL);
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 3_000,
    statement_timeout: 5_000,
    query_timeout: 6_000,
    options: "-c default_transaction_read_only=on",
    application_name: "jhc-netops-p10c-read-only-acceptance",
  });
  try {
    const repository = new PostgresAssetRepository(pool);
    const result = await repository.list({
      search: "",
      deviceType: null,
      vendor: null,
      platform: null,
      status: null,
      sort: "name_asc",
      page: 1,
      pageSize: 10,
    }, AbortSignal.timeout(7_000));
    assert.ok(result.pagination.total >= 0);
    assert.ok(result.items.length <= 10);
    assert.equal(result.pagination.page_size, 10);
    assert.ok(result.device_types.length <= 256);
    if (result.items[0]) {
      const detail = await repository.detail(result.items[0].id, AbortSignal.timeout(7_000));
      assert.equal(detail?.id, result.items[0].id);
    }
  } finally {
    await pool.end();
  }
});

function dedicatedTestDatabaseUrl(value: string | undefined): string {
  if (!value) throw new Error("P10C_TEST_DATABASE_URL is required for the explicit integration test");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("P10C test database URL is invalid"); }
  if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== "5433" ||
      url.pathname !== "/jhc_netops" || url.username !== "jhc_netops_app" || !url.password || url.hash || url.search) {
    throw new Error("P10C integration test refuses any database except jhc_netops_app@127.0.0.1:5433/jhc_netops");
  }
  return value;
}
