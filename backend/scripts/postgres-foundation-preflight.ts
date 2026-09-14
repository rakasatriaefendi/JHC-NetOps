import { Pool } from "pg";

import { parseDedicatedPostgresUrl } from "../src/config.js";
import { PostgresFoundationError, verifyPostgresFoundation } from "../src/postgres-foundation.js";

const PREFLIGHT_TIMEOUT_MS = 5_000;

async function main(): Promise<void> {
  const configuredUrl = process.env.DATABASE_URL?.trim();
  if (!configuredUrl) throw new PostgresFoundationError("DATABASE_URL is required for PostgreSQL preflight");
  const connectionString = parseDedicatedPostgresUrl(configuredUrl);
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 3_000,
    statement_timeout: PREFLIGHT_TIMEOUT_MS,
    query_timeout: PREFLIGHT_TIMEOUT_MS + 1_000,
    options: "-c default_transaction_read_only=on",
    application_name: "jhc-netops-p11-read-only-preflight",
  });

  try {
    const client = await pool.connect();
    try {
      const result = await verifyPostgresFoundation(async (sql, values) => {
        const response = await client.query(sql, values ? [...values] : undefined);
        return response.rows as readonly Readonly<Record<string, unknown>>[];
      });
      process.stdout.write(`${JSON.stringify({ status: "ok", ...result })}\n`);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

try {
  await main();
} catch (error) {
  const known = error instanceof PostgresFoundationError;
  process.stderr.write(`${JSON.stringify({
    status: "error",
    code: known ? error.code : "POSTGRES_PREFLIGHT_FAILED",
    message: known ? error.message : "PostgreSQL foundation preflight failed",
  })}\n`);
  process.exitCode = 1;
}

