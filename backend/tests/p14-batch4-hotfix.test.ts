import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { PostgresEventsRepository } from "../src/persistence/events.js";
import type { PostgresQuery } from "../src/persistence/postgres-query.js";

const migration010 = source("../migrations/010_diagnostics_device_inspector_realtime.sql");
const migration012 = source("../migrations/012_fix_local_realtime_control_trigger.sql");

test("migration 012 replaces only the realtime control function with table-safe record access", () => {
  assert.match(migration012, /NOT EXISTS \(SELECT 1 FROM public\.application_schema_migrations WHERE version = 11\)/);
  assert.match(migration012, /CREATE OR REPLACE FUNCTION public\.publish_local_realtime_control_invalidation\(\) RETURNS trigger/);
  assert.doesNotMatch(migration012, /CREATE TRIGGER|DROP TRIGGER|ALTER TABLE/);

  const runners = branch("diagnostic_runners", "diagnostic_jobs");
  assert.match(runners, /topic_value <> 'diagnostics'/);
  assert.match(runners, /TG_ARGV\[1\] <> 'id'/);
  assert.match(runners, /TG_OP = 'DELETE'[\s\S]*OLD\.id::text[\s\S]*NEW\.id::text/);
  assert.doesNotMatch(runners, /runner_id/);

  const jobs = branch("diagnostic_jobs", "device_inspection_sessions");
  assert.match(jobs, /topic_value <> 'diagnostics'/);
  assert.match(jobs, /TG_ARGV\[1\] <> 'id'/);
  assert.match(jobs, /TG_OP = 'DELETE'[\s\S]*OLD\.id::text[\s\S]*NEW\.id::text/);
  assert.doesNotMatch(jobs, /runner_id/);

  const inspector = migration012.match(
    /ELSIF TG_TABLE_NAME = 'device_inspection_sessions' THEN([\s\S]*?)\n  ELSE\n    RAISE EXCEPTION 'local realtime control trigger table is invalid'/,
  )?.[1];
  assert.ok(inspector);
  assert.match(inspector, /topic_value <> 'device_inspector'/);
  assert.match(inspector, /TG_ARGV\[1\] <> 'runner_id'/);
  assert.match(inspector, /TG_OP = 'DELETE'[\s\S]*OLD\.runner_id::text[\s\S]*NEW\.runner_id::text/);

  assert.match(migration012, /TG_OP NOT IN \('INSERT', 'UPDATE', 'DELETE'\)/);
  assert.match(migration012, /PERFORM pg_notify\('jhc_netops_realtime_v1', notification_value\)/);
  assert.match(migration012, /octet_length\(notification_value\) > 1024/);
  const fields = migration012.match(/notification_value := jsonb_build_object\(([\s\S]*?)\)::text;/)?.[1];
  assert.ok(fields);
  assert.deepEqual([...fields.matchAll(/'([a-z_]+)'\s*,/g)].map((match) => match[1]),
    ["version", "event_id", "topic", "aggregate_key", "occurred_at"]);
  assert.match(migration012, /INSERT INTO public\.application_schema_migrations\(version\) VALUES \(12\)/);

  assert.match(migration010, /CREATE FUNCTION public\.publish_local_realtime_control_invalidation\(\) RETURNS trigger/);
  assert.match(migration010, /INSERT INTO public\.application_schema_migrations\(version\) VALUES \(10\)/);
  assert.doesNotMatch(migration010, /version\) VALUES \(12\)|CREATE OR REPLACE FUNCTION/);
});

test("local Alerts event query is bounded, unresolved-only, source-scoped, and newest-first", async () => {
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const expected = [
    { id: "22222222-2222-4222-8222-222222222222", created_at: "2026-09-28T02:00:00.000Z" },
    { id: "11111111-1111-4111-8111-111111111111", created_at: "2026-09-28T01:00:00.000Z" },
  ];
  const database: PostgresQuery = {
    async rows(sql, values) { calls.push({ sql, values }); return expected; },
  };

  const rows = await new PostgresEventsRepository(database).listOpenBySource(
    "network_health", 5_000, new AbortController().signal,
  );
  assert.deepEqual(rows, expected);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql,
    /SELECT id,created_at,severity,title,description,source_ref,resolved_at,raw_context[\s\S]*FROM public\.events/);
  assert.match(calls[0]!.sql, /WHERE source=\$1 AND resolved_at IS NULL/);
  assert.match(calls[0]!.sql, /ORDER BY created_at DESC LIMIT \$2/);
  assert.deepEqual(calls[0]!.values, ["network_health", 500]);
});

function branch(table: string, nextTable: string): string {
  const match = migration012.match(new RegExp(
    `(?:IF|ELSIF) TG_TABLE_NAME = '${table}' THEN([\\s\\S]*?)ELSIF TG_TABLE_NAME = '${nextTable}' THEN`,
  ));
  assert.ok(match);
  return match[1]!;
}

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}
