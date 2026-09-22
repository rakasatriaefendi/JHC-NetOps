import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { PostgresCutoverCanaryRepository } from "../src/persistence/cutover-canary.js";
import { PostgresOutboxRepository, type OutboxEvent } from "../src/persistence/outbox.js";
import type { PostgresQuery, PostgresTransactionalQuery } from "../src/persistence/postgres-query.js";
import {
  buildProjectionPlan,
  SHADOW_PROJECTION_ALLOWLIST,
  SupabaseShadowProjector,
  type OutboxProjectionStore,
} from "../src/persistence/shadow-projector.js";

const REQUIRED_SHADOW_TABLES = [
  "diagnostic_runners", "diagnostic_jobs", "network_discovery_sessions", "device_inspection_sessions",
  "traffic_live_sessions", "traffic_live_snapshots", "network_targets", "network_health_latest",
  "network_health_ping_jobs", "events", "managed_device_latest", "managed_interface_latest",
  "managed_observed_hosts_latest", "profiles", "network_nodes", "managed_telemetry_targets",
] as const;
const migration = source("../migrations/008_application_persistence_outbox.sql");

test("migration 008 uses transactional triggers for the exact reviewed shadow surface", () => {
  const triggerTables = [...migration.matchAll(/CREATE TRIGGER shadow_[a-z_]+ AFTER INSERT OR UPDATE OR DELETE ON public\.([a-z_]+)/g)]
    .map((match) => match[1]);
  assert.deepEqual(triggerTables, REQUIRED_SHADOW_TABLES);
  assert.match(migration, /CREATE FUNCTION public\.enqueue_realtime_shadow\(\) RETURNS trigger/);
  assert.match(migration, /INSERT INTO public\.realtime_outbox[\s\S]+VALUES \(TG_TABLE_NAME, key_value, TG_OP, row_value\)/);
  assert.doesNotMatch(migration, /EXCEPTION\s+WHEN/);
  assert.match(migration, /event_id uuid NOT NULL DEFAULT gen_random_uuid\(\) UNIQUE/);
  assert.doesNotMatch(migration, /idempotency_key/);
  assert.match(migration, /row_value := row_value - 'snmp2c_community_encrypted'/);
  assert.match(migration, /INSERT INTO public\.application_schema_migrations\(version\) VALUES \(8\)/);
  assert.match(migration, /GRANT USAGE,SELECT ON SEQUENCE public\.realtime_outbox_id_seq TO jhc_netops_app/);
  assert.doesNotMatch(migration, /GRANT (?:OWNERSHIP|CREATE|ALL)|GRANT [^;]*UPDATE ON SEQUENCE/i);
});

test("outbox event identity is per mutation and polling is monotonic per aggregate", async () => {
  assert.match(migration, /id bigserial PRIMARY KEY/);
  assert.match(migration, /realtime_outbox_aggregate_order_idx[\s\S]+aggregate_type, aggregate_key, id/);
  const database = new RecordingDatabase();
  const repository = new PostgresOutboxRepository(database);
  await repository.fetchPending(50, new AbortController().signal);
  const sql = database.calls[0]?.sql ?? "";
  assert.match(sql, /NOT EXISTS[\s\S]+earlier\.id < o\.id[\s\S]+earlier\.status <> 'delivered'/);
  assert.match(sql, /ORDER BY o\.id ASC/);
  assert.match(sql, /o\.id > COALESCE\(w\.last_delivered_outbox_id,0\)/);
});

test("projection plans preserve upsert and actual delete semantics", () => {
  const approved = SHADOW_PROJECTION_ALLOWLIST.find(({ aggregate_type }) => aggregate_type === "network_targets");
  assert.ok(approved);
  const update = buildProjectionPlan(event({ operation: "UPDATE" }), approved);
  assert.deepEqual(update, { kind: "upsert", table: "network_targets", payload: { id: "target-1", enabled: true }, onConflict: "id" });
  const deletion = buildProjectionPlan(event({ operation: "DELETE" }), approved);
  assert.deepEqual(deletion, { kind: "delete", table: "network_targets", match: { id: "target-1" } });
});

test("projection plans preserve required Traffic and reviewed control-plane fields", () => {
  const traffic = projectionPlan("traffic_live_sessions", { id: "30000000-0000-4000-8000-000000000001" }, {
    id: "30000000-0000-4000-8000-000000000001", runner_id: "it-lt8",
    capture_scope: "this_device", status: "queued",
  });
  if (traffic.kind !== "upsert") assert.fail("Traffic shadow plan must be an upsert");
  assert.equal(traffic.payload.capture_scope, "this_device");

  const reviewed = [
    ["diagnostic_runners", { id: "it-lt8" }, { id: "it-lt8", health_status: "online", preflight: {} }],
    ["network_health_ping_jobs", { id: "30000000-0000-4000-8000-000000000002" },
      { id: "30000000-0000-4000-8000-000000000002", runner_id: "it-lt8", status: "queued" }],
    ["device_inspection_sessions", { runner_id: "it-lt8" },
      { runner_id: "it-lt8", inspection_id: "30000000-0000-4000-8000-000000000003", status: "queued" }],
    ["network_discovery_sessions", { runner_id: "it-lt8" },
      { runner_id: "it-lt8", session_id: "30000000-0000-4000-8000-000000000004", status: "queued" }],
  ] as const;
  for (const [aggregateType, key, payload] of reviewed) {
    const plan = projectionPlan(aggregateType, key, payload);
    if (plan.kind !== "upsert") assert.fail(`${aggregateType} shadow plan must be an upsert`);
    assert.deepEqual(Object.fromEntries(Object.keys(key).map((column) => [column, plan.payload[column]])), key);
  }
});

test("malformed aggregate keys become a visible poison failure and are never delivered", async () => {
  const store = new FakeOutbox([event({ aggregate_key: { id: null } })]);
  const projector = new SupabaseShadowProjector(store, "https://example.invalid", "fixture-key",
    { batchSize: 10, maxRetries: 1, retryBaseDelayMs: 0, maxDelayMs: 0 },
    async () => ({ error: false }));
  const result = await projector.processBatch(new AbortController().signal);
  assert.deepEqual(result, { delivered: 0, failed: 1 });
  assert.deepEqual(store.failed, [{ id: 1, category: "payload_validation" }]);
  assert.deepEqual(store.delivered, []);
});

test("transient shadow failure is retained for retry and never marked delivered", async () => {
  const store = new FakeOutbox([event()]);
  const projector = new SupabaseShadowProjector(store, "https://example.invalid", "fixture-key",
    { batchSize: 10, maxRetries: 1, retryBaseDelayMs: 0, maxDelayMs: 0 },
    async () => ({ error: true, errorCategory: "transient_network", backendCode: "PGRST000" }));
  const result = await projector.processBatch(new AbortController().signal);
  assert.deepEqual(result, { delivered: 0, failed: 1 });
  assert.deepEqual(store.failed, [{ id: 1, category: "transient_network" }]);
  assert.deepEqual(store.delivered, []);
});

test("delivery bookkeeping failures retain the event and expose a bounded batch stage", async () => {
  const store = new FakeOutbox([event()]);
  store.failDelivery = true;
  const projector = new SupabaseShadowProjector(store, "https://example.invalid", "fixture-key",
    { batchSize: 10, maxRetries: 1, retryBaseDelayMs: 0, maxDelayMs: 0 },
    async () => ({ error: false }));
  await assert.rejects(() => projector.processBatch(new AbortController().signal),
    /OUTBOX_DELIVERY_BOOKKEEPING_FAILED/);
  assert.deepEqual(store.delivered, []);
  assert.deepEqual(store.failed, []);
});

test("projector retries one stored event identity and marks it delivered once", async () => {
  const store = new FakeOutbox([event()]);
  let attempts = 0;
  const projector = new SupabaseShadowProjector(store, "https://example.invalid", "fixture-key",
    { batchSize: 10, maxRetries: 2, retryBaseDelayMs: 0, maxDelayMs: 0 },
    async () => ({ error: ++attempts === 1 }));
  const result = await projector.processBatch(new AbortController().signal);
  assert.deepEqual(result, { delivered: 1, failed: 0 });
  assert.equal(attempts, 2);
  assert.deepEqual(store.delivered, [1]);
  assert.deepEqual(store.failed, []);
});

test("unknown projection events fail visibly and never become delivered", async () => {
  const store = new FakeOutbox([event({ aggregate_type: "caller_selected_table" })]);
  const projector = new SupabaseShadowProjector(store, "https://example.invalid", "fixture-key",
    { batchSize: 10, maxRetries: 1, retryBaseDelayMs: 0, maxDelayMs: 0 },
    async () => ({ error: false }));
  const result = await projector.processBatch(new AbortController().signal);
  assert.deepEqual(result, { delivered: 0, failed: 1 });
  assert.deepEqual(store.failed, [{ id: 1, category: "projection_not_allowed" }]);
  assert.deepEqual(store.delivered, []);
});

test("outbox polling retries only transient failures and health aggregation is valid and complete", async () => {
  const database = new RecordingDatabase();
  const repository = new PostgresOutboxRepository(database);
  await repository.fetchPending(50, new AbortController().signal);
  await repository.getHealth(new AbortController().signal);
  const pollSql = database.calls[0]?.sql ?? "";
  const healthSql = database.calls[1]?.sql ?? "";
  assert.match(pollSql, /o\.status='pending' OR o\.last_error_category IN \('transient_network','supabase_unavailable'\)/);
  assert.match(healthSql, /COUNT\(\*\) AS total_count/);
  assert.match(healthSql, /COUNT\(\*\) FILTER \(WHERE status='delivered'\) AS delivered_count/);
  assert.match(healthSql, /MIN\(created_at\) FILTER \(WHERE status IN \('pending','failed'\)\)/);
  assert.doesNotMatch(healthSql, /\)\*1000\s+FILTER/);
});

test("projector lifecycle aborts and awaits its in-process loop", async () => {
  const store = new FakeOutbox([]);
  const projector = new SupabaseShadowProjector(store, "https://example.invalid", "fixture-key",
    { batchSize: 10, maxRetries: 1, retryBaseDelayMs: 0, maxDelayMs: 0 },
    async () => ({ error: false }));
  projector.start();
  await projector.stop();
  assert.ok(store.fetches >= 1);
});

test("canary repository uses a non-domain row, verifies affected row, and performs real cleanup", async () => {
  const database = new CanaryDatabase();
  const repository = new PostgresCutoverCanaryRepository(database);
  const signal = new AbortController().signal;
  const identity = "p13-cutover-1757980800000-abc123";
  const written = await repository.write(identity, { test: "internal-cutover-canary", timestamp: "2026-09-16T00:00:00Z" }, signal);
  assert.equal(written.id, CanaryDatabase.ID);
  assert.ok(await repository.read(identity, CanaryDatabase.ID, signal));
  assert.equal(await repository.verify(identity, CanaryDatabase.ID, signal), true);
  assert.equal(await repository.cleanup(identity, CanaryDatabase.ID, signal), true);
  assert.ok(database.sql.some((sql) => /DELETE FROM public\.cutover_canary/.test(sql)));
  assert.ok(database.sql.every((sql) => !/\b(?:network_nodes|network_targets|diagnostic_jobs|events)\b/.test(sql)));
});

test("canary frontend path is Admin-only, verifies, and always attempts cleanup", () => {
  const action = source("../../frontend/app/actions/cutover-canary.ts");
  const transport = source("../../frontend/lib/application-persistence.ts");
  assert.match(action, /await requireAdminProfile\(\)/);
  assert.match(action, /method: "PATCH"|localApplicationRequest\("PATCH"/);
  assert.match(action, /finally\s*\{/);
  assert.doesNotMatch(action, /actor_id/);
  assert.match(transport, /safeApplicationPath/);
  assert.match(transport, /parsed\.origin !== base\.origin/);
});

test("legacy Edge mutation surfaces share the local-authority guard while projector stays narrow", () => {
  const guarded = ["diagnostic-jobs", "diagnostics", "ingest", "managed-telemetry", "network-discovery",
    "network-health", "traffic-live", "device-inspector"];
  for (const name of guarded) {
    const edge = source(`../../supabase/functions/${name}/index.ts`);
    assert.match(edge, /legacyApplicationMutationBlocked/);
  }
  const guard = source("../../supabase/functions/_shared/persistence-authority.ts");
  assert.match(guard, /PERSISTENCE_AUTHORITY/);
  assert.match(guard, /local_postgres/);
  const projector = source("../src/persistence/shadow-projector.ts");
  assert.match(projector, /SHADOW_PROJECTION_ALLOWLIST/);
  assert.match(projector, /defaultToNull:\s*false/);
  assert.doesNotMatch(projector, /caller.*table|table.*body/i);
});

class RecordingDatabase implements PostgresTransactionalQuery {
  readonly calls: { sql: string; values: readonly unknown[] }[] = [];
  async rows(sql: string, values: readonly unknown[]): Promise<readonly Record<string, unknown>[]> {
    this.calls.push({ sql, values });
    return [];
  }
  async transaction<T>(_signal: AbortSignal, action: (query: PostgresQuery) => Promise<T>): Promise<T> {
    return action(this);
  }
}

class FakeOutbox implements OutboxProjectionStore {
  delivered: number[] = [];
  failed: { id: number; category: string }[] = [];
  fetches = 0;
  failDelivery = false;
  constructor(private readonly events: OutboxEvent[]) {}
  async fetchPending(): Promise<OutboxEvent[]> { this.fetches++; return this.events; }
  async markDelivered(value: Pick<OutboxEvent, "id">): Promise<void> {
    if (this.failDelivery) throw new Error("fixture delivery failure");
    this.delivered.push(value.id);
  }
  async markFailed(id: number, category: "transient_network" | "supabase_unavailable" | "payload_validation" | "projection_not_allowed"): Promise<void> {
    this.failed.push({ id, category });
  }
}

class CanaryDatabase implements PostgresTransactionalQuery {
  static readonly ID = "10000000-0000-4000-8000-000000000001";
  readonly sql: string[] = [];
  private verified = false;
  private deleted = false;
  async rows(sql: string): Promise<readonly Record<string, unknown>[]> {
    this.sql.push(sql);
    if (/INSERT INTO public\.cutover_canary/.test(sql)) return [this.row()];
    if (/SELECT id,created_at,verified_at/.test(sql)) return this.deleted ? [] : [this.row()];
    if (/UPDATE public\.cutover_canary/.test(sql)) { this.verified = true; return [{ id: CanaryDatabase.ID }]; }
    if (/DELETE FROM public\.cutover_canary[\s\S]+RETURNING id/.test(sql)) { this.deleted = true; return [{ id: CanaryDatabase.ID }]; }
    return [];
  }
  async transaction<T>(_signal: AbortSignal, action: (query: PostgresQuery) => Promise<T>): Promise<T> {
    return action(this);
  }
  private row(): Record<string, unknown> {
    return { id: CanaryDatabase.ID, created_at: "2026-09-16T00:00:00Z", verified_at: this.verified ? "2026-09-16T00:00:01Z" : null };
  }
}

function event(overrides: Partial<OutboxEvent> = {}): OutboxEvent {
  return {
    id: 1, event_id: "20000000-0000-4000-8000-000000000001", aggregate_type: "network_targets",
    aggregate_key: { id: "target-1" }, operation: "UPDATE", payload: { id: "target-1", enabled: true },
    status: "pending", attempt_count: 0, next_attempt_at: null, created_at: "2026-09-16T00:00:00Z",
    delivered_at: null, last_error_category: null, ...overrides,
  };
}

function projectionPlan(
  aggregateType: string,
  aggregateKey: Record<string, unknown>,
  payload: Record<string, unknown>,
) {
  const approved = SHADOW_PROJECTION_ALLOWLIST.find(({ aggregate_type }) => aggregate_type === aggregateType);
  assert.ok(approved);
  return buildProjectionPlan(event({ aggregate_type: aggregateType, aggregate_key: aggregateKey, payload }), approved);
}

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}
