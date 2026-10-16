import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildServer } from "../src/server.js";
import { PostgresProfilesRepository } from "../src/persistence/profiles.js";
import { PostgresNetworkInventoryRepository } from "../src/persistence/inventory.js";
import { HEALTH_HISTORY_MAX_TARGETS, HEALTH_HISTORY_RANGES, HealthHistoryError,
  PostgresHealthHistoryRepository, validateHealthHistoryQuery } from "../src/persistence/health-history.js";
import type { PostgresQuery, PostgresTransactionalQuery } from "../src/persistence/postgres-query.js";

const TARGET = "10000000-0000-4000-8000-000000000001";
const OTHER = "20000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-10-09T08:15:30.000Z");
const TOKEN = "history-test-token-".repeat(3);
const signal = () => new AbortController().signal;
const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

function measuredRow(targetId = TARGET): Record<string, unknown> {
  return { target_id: targetId, sampled_at: new Date("2026-10-09T08:14:00Z"),
    status: "online", latency_ms: 1.25, packet_loss_percent: "0.00", sample_count: 5,
    observation_count: 1, latency_observation_count: 1, latency_min_ms: 1.25, latency_max_ms: 1.25,
    packet_loss_min_percent: 0, packet_loss_max_percent: 0,
    first_sample_at: new Date("2026-10-09T08:14:00Z"), last_sample_at: new Date("2026-10-09T08:14:00Z") };
}
class HistoryDatabase implements PostgresTransactionalQuery {
  calls: { sql: string; values: readonly unknown[] }[] = [];
  targets = [TARGET];
  samples: Record<string, unknown>[] = [measuredRow()];
  fail = false;
  async rows(sql: string, values: readonly unknown[], abort: AbortSignal) {
    abort.throwIfAborted();
    this.calls.push({ sql, values });
    if (this.fail) throw new Error("private database details must never escape");
    if (sql.includes("FROM public.network_targets")) return this.targets.map((id) => ({ id }));
    if (sql.includes("FROM public.network_health_samples")) return this.samples;
    return [];
  }
  async transaction<T>(abort: AbortSignal, action: (query: PostgresQuery) => Promise<T>): Promise<T> {
    abort.throwIfAborted(); return action(this);
  }
}
function serverFor(database: HistoryDatabase) {
  return buildServer({ logger: false, application: { token: TOKEN,
    profiles: new PostgresProfilesRepository(database), inventory: new PostgresNetworkInventoryRepository(database),
    healthHistory: new PostgresHealthHistoryRepository(database) } });
}

test("historical repository returns measured PostgreSQL rows with UTC timestamps and real zero loss", async () => {
  const database = new HistoryDatabase();
  const history = await new PostgresHealthHistoryRepository(database).read({ targetIds: [TARGET], range: "1h" }, NOW, signal());
  assert.equal(history.samples.length, 1);
  assert.equal(history.samples[0]!.latency_ms, 1.25);
  assert.equal(history.samples[0]!.packet_loss_percent, 0);
  assert.equal(history.samples[0]!.sampled_at, "2026-10-09T08:14:00.000Z");
  assert.equal(history.from, "2026-10-09T07:15:30.000Z");
  assert.equal(history.to, NOW.toISOString());
  assert.deepEqual(database.calls[1]!.values, [[TARGET], history.from, history.to, "1 minutes", 62]);
  assert.match(database.calls[1]!.sql, /sampled_at >= \$2::timestamptz AND sampled_at < \$3::timestamptz/);
  assert.match(database.calls[1]!.sql, /AT TIME ZONE 'UTC'/);
  assert.match(database.calls[1]!.sql, /ORDER BY sampled_at ASC,target_id ASC/);
  assert.doesNotMatch(database.calls.map(({ sql }) => sql).join("\n"), /INSERT|UPDATE|DELETE|generate_series/i);
});

test("empty history differs from unavailable target and database failure", async () => {
  const database = new HistoryDatabase();
  const repository = new PostgresHealthHistoryRepository(database);
  database.samples = [];
  assert.deepEqual((await repository.read({ targetIds: [TARGET], range: "1h" }, NOW, signal())).samples, []);
  database.targets = [];
  await assert.rejects(repository.read({ targetIds: [TARGET], range: "1h" }, NOW, signal()), { code: "HEALTH_HISTORY_TARGET_UNAVAILABLE" });
  database.targets = [TARGET]; database.fail = true;
  await assert.rejects(repository.read({ targetIds: [TARGET], range: "1h" }, NOW, signal()));
});

test("range validation rejects unknown/duplicate/extra/unbounded inputs", () => {
  for (const value of [{}, { target_ids: "192.168.1.8", range: "1h" }, { target_ids: TARGET, range: "30d" },
    { target_ids: `${TARGET},${TARGET.toUpperCase()}`, range: "1h" }, { target_ids: TARGET, range: "1h", limit: "100000" },
    { target_ids: [TARGET], range: "1h" }]) assert.equal(validateHealthHistoryQuery(value), null);
  const ids = Array.from({ length: HEALTH_HISTORY_MAX_TARGETS + 1 }, (_, index) =>
    `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
  assert.equal(validateHealthHistoryQuery({ target_ids: ids.slice(0, HEALTH_HISTORY_MAX_TARGETS).join(","), range: "1h" })?.targetIds.length, 20);
  assert.equal(validateHealthHistoryQuery({ target_ids: ids.join(","), range: "1h" }), null);
  assert.deepEqual(validateHealthHistoryQuery({ target_ids: `${OTHER},${TARGET}`, range: "7d" }), { targetIds: [TARGET, OTHER], range: "7d" });
});

test("long ranges aggregate all measured rows, retain extrema/count/nulls, and never silently truncate", async () => {
  const database = new HistoryDatabase();
  database.samples = [{ ...measuredRow(), status: "offline", latency_ms: null,
    latency_min_ms: null, latency_max_ms: null, latency_observation_count: 0 }];
  const repository = new PostgresHealthHistoryRepository(database);
  for (const range of ["1h", "6h", "24h", "7d"] as const) {
    const data = await repository.read({ targetIds: [TARGET], range }, NOW, signal());
    assert.equal(data.bucket_seconds, HEALTH_HISTORY_RANGES[range].bucketMinutes * 60);
    assert.equal(Date.parse(data.to) - Date.parse(data.from), HEALTH_HISTORY_RANGES[range].minutes * 60_000);
    assert.equal(data.samples[0]!.latency_ms, null);
    assert.equal(data.samples[0]!.status, "offline");
  }
  const sql = database.calls.find(({ sql }) => sql.includes("date_bin"))!.sql;
  for (const fragment of ["avg(latency_ms)", "avg(packet_loss_percent)", "min(latency_ms)", "max(latency_ms)",
    "count(latency_ms)", "count(*)", "min(packet_loss_percent)", "max(packet_loss_percent)", "min(sampled_at)", "max(sampled_at)"]) assert.ok(sql.includes(fragment));
  assert.doesNotMatch(sql, /coalesce\(.*latency|generate_series|OFFSET/i);
  database.samples = Array.from({ length: 62 }, () => measuredRow());
  await assert.rejects(repository.read({ targetIds: [TARGET], range: "1h" }, NOW, signal()), { code: "HEALTH_HISTORY_RESPONSE_TOO_LARGE" });
});

test("read aborts safely and validates target selection before querying", async () => {
  const database = new HistoryDatabase();
  const repository = new PostgresHealthHistoryRepository(database);
  await assert.rejects(repository.read({ targetIds: ["invalid"], range: "1h" }, NOW, signal()), HealthHistoryError);
  assert.equal(database.calls.length, 0);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(repository.read({ targetIds: [TARGET], range: "1h" }, NOW, abort.signal));
});

test("invalid measurements and unexpected target rows fail rather than synthesizing history", async () => {
  const database = new HistoryDatabase();
  const repository = new PostgresHealthHistoryRepository(database);
  for (const row of [{ ...measuredRow(), latency_ms: "not-a-number" }, { ...measuredRow(), packet_loss_percent: null },
    { ...measuredRow(), observation_count: 22 }, measuredRow(OTHER)]) {
    database.samples = [row];
    await assert.rejects(repository.read({ targetIds: [TARGET], range: "1h" }, NOW, signal()), { code: "HEALTH_HISTORY_QUERY_FAILED" });
  }
});

test("application historical route requires frontend bearer and distinguishes bounded errors without leaking SQL", async () => {
  const database = new HistoryDatabase();
  const server = serverFor(database);
  try {
    const url = `/api/application/network-health-samples?target_ids=${TARGET}&range=1h`;
    assert.equal((await server.inject({ method: "GET", url })).statusCode, 401);
    assert.equal((await server.inject({ method: "GET", url, headers: { authorization: "Bearer runner-only-token" } })).statusCode, 401);
    assert.equal(database.calls.length, 0);
    const headers = { authorization: `Bearer ${TOKEN}` };
    assert.equal((await server.inject({ method: "GET", url: `${url}&unknown=1`, headers })).statusCode, 400);
    const ok = await server.inject({ method: "GET", url, headers });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().data.samples[0].packet_loss_percent, 0);
    assert.equal(ok.headers["cache-control"], "private, no-store");
    database.samples = [];
    assert.deepEqual((await server.inject({ method: "GET", url, headers })).json().data.samples, []);
    database.targets = [];
    assert.equal((await server.inject({ method: "GET", url, headers })).statusCode, 404);
    database.targets = [TARGET]; database.samples = Array.from({ length: 62 }, () => measuredRow());
    assert.equal((await server.inject({ method: "GET", url, headers })).statusCode, 422);
    database.fail = true;
    const failed = await server.inject({ method: "GET", url, headers });
    assert.equal(failed.statusCode, 503);
    assert.deepEqual(failed.json(), { error: { code: "HEALTH_HISTORY_QUERY_FAILED" } });
    assert.doesNotMatch(failed.body, /private database|SELECT|token|postgres/i);
  } finally { await server.close(); }
});

test("history remains read-only, response bounded, and separate from monitoring/Manual Ping execution", () => {
  const repository = source("../src/persistence/health-history.ts");
  assert.match(repository, /Buffer\.byteLength\(JSON\.stringify\(\{ data \}\)/);
  assert.match(repository, /HEALTH_HISTORY_MAX_BYTES = 4 \* 1024 \* 1024/);
  assert.doesNotMatch(repository, /(?:INSERT INTO|UPDATE|DELETE FROM)\s+public\./);
  assert.doesNotMatch(repository, /pingTarget|asset\.|endpoint_assignments|randomUUID/);
});
