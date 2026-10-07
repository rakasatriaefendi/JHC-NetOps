import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isMonitoringInterval, MONITORING_INTERVALS } from "../src/monitoring-intervals.js";
import { InventoryPersistenceError, PostgresNetworkInventoryRepository,
  type HealthTargetInput, type ManagedTargetInput } from "../src/persistence/inventory.js";
import type { PostgresQuery, PostgresTransactionalQuery } from "../src/persistence/postgres-query.js";
import { PostgresProfilesRepository } from "../src/persistence/profiles.js";
import { buildServer } from "../src/server.js";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const NODE = "22222222-2222-4222-8222-222222222222";
const TARGET = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";
const signal = () => new AbortController().signal;
const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const health: HealthTargetInput = { node_id: NODE, runner_id: "runner-test", enabled: true,
  critical: false, probe_interval_seconds: 900, timeout_ms: 1000, failure_threshold: 3,
  recovery_threshold: 2, latency_warning_ms: 100, loss_warning_percent: 40 };
const managed: ManagedTargetInput = { node_id: NODE, runner_id: "runner-test", enabled: true,
  credential_profile_ref: "authorized-readonly", snmp_version: "3", snmp_port: 161,
  poll_interval_seconds: 900, oper_error_threshold: 5, discard_threshold: 10,
  util_warning_percent: 80, util_critical_percent: 95, util_sustained_seconds: 300 };

class InventoryDatabase implements PostgresTransactionalQuery {
  role = "operator";
  status = "approved";
  calls: { sql: string; values: readonly unknown[] }[] = [];
  targets = new Map<string, Record<string, unknown>>([
    [TARGET, { id: TARGET, ...managed, poll_interval_seconds: 60 }],
    [OTHER, { id: OTHER, ...managed, poll_interval_seconds: 30 }],
  ]);
  healthRow: Record<string, unknown> | null = null;
  transactions = 0;
  async transaction<T>(_signal: AbortSignal, action: (query: PostgresQuery) => Promise<T>): Promise<T> {
    _signal.throwIfAborted();
    this.transactions += 1;
    return action(this);
  }
  async rows(sql: string, values: readonly unknown[]): Promise<readonly Record<string, unknown>[]> {
    this.calls.push({ sql, values });
    if (sql.includes("SELECT role,status")) return [{ role: this.role, status: this.status }];
    if (sql.includes("FROM public.diagnostic_runners")) return [{ id: "runner-test" }];
    if (sql.includes("UPDATE public.managed_telemetry_targets SET poll_interval_seconds=$2")) {
      const row = this.targets.get(String(values[0]));
      if (!row) return [];
      row.poll_interval_seconds = values[1];
      return [{ ...row }];
    }
    if (/^\s*SELECT\b/.test(sql) && sql.includes("FROM public.managed_telemetry_targets")) {
      const row = sql.includes("WHERE node_id=") ? this.targets.get(TARGET) : this.targets.get(String(values[0]));
      return row ? [{ ...row, name: "Lab", node_name: "Lab", ip_address: "192.0.2.10" }] : [];
    }
    if (sql.includes("INSERT INTO public.managed_telemetry_targets")) {
      const row = { id: TARGET, ...managed, poll_interval_seconds: values[6] };
      this.targets.set(TARGET, row);
      return [row];
    }
    if (sql.includes("DELETE FROM public.managed_telemetry_targets")) {
      return this.targets.delete(String(values[0])) ? [{ id: values[0] }] : [];
    }
    if (sql.includes("INSERT INTO public.network_targets")) {
      this.healthRow = { id: TARGET, ...health, probe_interval_seconds: values[4] };
      return [{ ...this.healthRow }];
    }
    if (sql.includes("FROM public.network_targets")) return this.healthRow ? [{ ...this.healthRow }] : [];
    return [];
  }
  mutations() { return this.calls.filter(({ sql }) => /^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(sql)); }
}

test("018 replaces only the reviewed SNMP CHECK with all five presets and requires latest 017", () => {
  const migration = source("../migrations/018_snmp_monitoring_intervals.sql");
  const sql = migration.replace(/--[^\r\n]*/g, "");
  const original = source("../migrations/007_application_persistence.sql");
  assert.match(original, /poll_interval_seconds integer NOT NULL DEFAULT 60 CHECK \(poll_interval_seconds IN \(30,60\)\)/);
  for (const guard of ["current_database() <> 'jhc_netops'", "current_setting('port')::integer <> 5433",
    "NOT BETWEEN 160000 AND 169999", "'/var/lib/postgresql/16/jhcnetops'", "session_user <> 'postgres'",
    "WHERE version = 17", "max(version) FROM public.application_schema_migrations) <> 17"]) {
    assert.ok(sql.includes(guard), guard);
  }
  assert.match(sql, /c\.conrelid=to_regclass\('public\.managed_telemetry_targets'\)[\s\S]*c\.conname='managed_telemetry_targets_poll_interval_seconds_check'/);
  assert.match(sql, /a\.attname='poll_interval_seconds'/);
  assert.match(sql, /ALTER TABLE public\.managed_telemetry_targets\s+DROP CONSTRAINT managed_telemetry_targets_poll_interval_seconds_check,\s+ADD CONSTRAINT managed_telemetry_targets_poll_interval_seconds_check\s+CHECK \(poll_interval_seconds IN \(15,30,60,900,1800\)\)/);
  assert.equal((sql.match(/ALTER TABLE/g) ?? []).length, 1);
  assert.doesNotMatch(sql, /\b(?:UPDATE|DELETE|GRANT|CREATE|OWNER TO|SET DEFAULT|ADD COLUMN)\b/i);
  assert.match(sql, /BEGIN;[\s\S]*SET ROLE jhc_netops_owner;[\s\S]*VALUES \(18\);\s*RESET ROLE;\s*COMMIT;/);
});

test("the write contract accepts exactly the five numeric monitoring intervals", () => {
  assert.deepEqual(MONITORING_INTERVALS, [15, 30, 60, 900, 1800]);
  for (const interval of MONITORING_INTERVALS) assert.equal(isMonitoringInterval(interval), true);
  for (const interval of [0, 45, 90, 3600, "900", null, {}, NaN]) assert.equal(isMonitoringInterval(interval), false);
});

test("approved Admin and Operator can save all Health presets, and no-op does not write", async () => {
  for (const role of ["admin", "operator"]) {
    const db = new InventoryDatabase(); db.role = role;
    const repository = new PostgresNetworkInventoryRepository(db);
    for (const interval of MONITORING_INTERVALS) {
      const saved = await repository.upsertHealthTarget(ACTOR, { ...health, probe_interval_seconds: interval }, signal());
      assert.equal(saved.probe_interval_seconds, interval);
      assert.equal(saved.changed, true);
    }
    const count = db.mutations().length;
    assert.equal((await repository.upsertHealthTarget(ACTOR, { ...health, probe_interval_seconds: 1800 }, signal())).changed, false);
    assert.equal(db.mutations().length, count);
    assert.ok(db.calls.some(({ sql }) => sql.includes("FOR SHARE")));
  }
});

test("Viewer and unapproved actors cannot change Health or SNMP intervals", async () => {
  for (const [role, status] of [["viewer", "approved"], ["operator", "pending"], ["admin", "rejected"], ["admin", "disabled"]]) {
    const db = new InventoryDatabase(); db.role = role!; db.status = status!;
    const repository = new PostgresNetworkInventoryRepository(db);
    for (const operation of [() => repository.upsertHealthTarget(ACTOR, health, signal()),
      () => repository.setManagedPollingInterval(ACTOR, TARGET, 900, signal())]) {
      await assert.rejects(operation(), (error: unknown) => error instanceof InventoryPersistenceError && error.code === "OPERATOR_ACCESS_REQUIRED");
    }
    assert.equal(db.mutations().length, 0);
  }
});

test("Admin and Operator SNMP interval changes preserve every non-interval field and other targets", async () => {
  for (const role of ["admin", "operator"]) {
    const db = new InventoryDatabase(); db.role = role;
    const repository = new PostgresNetworkInventoryRepository(db);
    const before = { ...db.targets.get(TARGET) };
    const otherBefore = { ...db.targets.get(OTHER) };
    for (const interval of MONITORING_INTERVALS) {
      assert.deepEqual(await repository.setManagedPollingInterval(ACTOR, TARGET, interval, signal()),
        { id: TARGET, poll_interval_seconds: interval, changed: true });
      assert.deepEqual(db.targets.get(TARGET), { ...before, poll_interval_seconds: interval });
      assert.deepEqual(db.targets.get(OTHER), otherBefore);
    }
    const count = db.mutations().length;
    assert.deepEqual(await repository.setManagedPollingInterval(ACTOR, TARGET, 1800, signal()),
      { id: TARGET, poll_interval_seconds: 1800, changed: false });
    assert.equal(db.mutations().length, count);
    assert.ok(db.mutations().every(({ sql, values }) =>
      /^UPDATE public\.managed_telemetry_targets SET poll_interval_seconds=\$2\s+WHERE id=\$1::uuid RETURNING id,poll_interval_seconds$/.test(sql.trim()) && values[0] === TARGET));
    assert.equal(db.transactions, 6);
  }
});

test("full SNMP configuration and deletion require Admin, not the interval-only Operator permission", async () => {
  for (const role of ["operator", "viewer"]) {
    const db = new InventoryDatabase(); db.role = role;
    const repository = new PostgresNetworkInventoryRepository(db);
    for (const operation of [() => repository.upsertManagedTarget(ACTOR, managed, signal()),
      () => repository.deleteManagedTarget(ACTOR, TARGET, "Lab (192.0.2.10)", signal())]) {
      await assert.rejects(operation(), (error: unknown) => error instanceof InventoryPersistenceError && error.code === "ADMIN_ACCESS_REQUIRED");
    }
    assert.equal(db.mutations().length, 0);
  }
  const db = new InventoryDatabase(); db.role = "admin";
  const repository = new PostgresNetworkInventoryRepository(db);
  assert.equal((await repository.upsertManagedTarget(ACTOR, managed, signal())).changed, true);
  const count = db.mutations().length;
  assert.equal((await repository.upsertManagedTarget(ACTOR, managed, signal())).changed, false);
  assert.equal(db.mutations().length, count);
  assert.equal(await repository.deleteManagedTarget(ACTOR, TARGET, "Lab (192.0.2.10)", signal()), true);
});

test("legacy Health intervals remain readable without rewrites; new writes require a preset", async () => {
  const db = new InventoryDatabase(); db.healthRow = { id: TARGET, ...health, probe_interval_seconds: 45 };
  const repository = new PostgresNetworkInventoryRepository(db);
  assert.equal((await repository.listHealthTargets(signal()))[0]?.probe_interval_seconds, 45);
  assert.equal(db.mutations().length, 0);
  await assert.rejects(repository.upsertHealthTarget(ACTOR, { ...health, probe_interval_seconds: 45 }, signal()));
  assert.equal(db.mutations().length, 0);
  // The authoritative interval refetch must include the persisted field.
  assert.equal((await repository.getManagedTarget(TARGET, signal()))?.poll_interval_seconds, 60);
  assert.ok(db.calls.some(({ sql }) => /SELECT t\.id,t\.node_id,t\.runner_id,t\.enabled,t\.poll_interval_seconds/.test(sql)));
  assert.match(source("../src/persistence/inventory.ts"), /SELECT \$1, id, true, \$3::uuid, 900 FROM unnest[\s\S]*ON CONFLICT \(runner_id,node_id\) DO UPDATE SET enabled=true/);
});

test("interval route requires bearer auth, strict bounded input, and repository role authorization", async () => {
  const db = new InventoryDatabase();
  const server = buildServer({ logger: false, application: { token: "frontend-test-token-only",
    profiles: new PostgresProfilesRepository(db), inventory: new PostgresNetworkInventoryRepository(db) } });
  const url = `/api/application/managed-targets/${TARGET}/interval`;
  const headers = { authorization: "Bearer frontend-test-token-only" };
  const payload = { actor_id: ACTOR, poll_interval_seconds: 900 };
  try {
    assert.equal((await server.inject({ method: "PATCH", url, payload })).statusCode, 401);
    for (const extra of ["credential_profile_ref", "snmp_version", "enabled", "node_id", "runner_id", "community", "auth_password"]) {
      assert.equal((await server.inject({ method: "PATCH", url, headers, payload: { ...payload, [extra]: "rejected" } })).statusCode, 400);
    }
    for (const invalid of [{ ...payload, poll_interval_seconds: 90 }, { ...payload, poll_interval_seconds: "900" },
      { ...payload, actor_id: "bad-id" }, { actor_id: ACTOR }]) {
      assert.equal((await server.inject({ method: "PATCH", url, headers, payload: invalid })).statusCode, 400);
    }
    assert.equal((await server.inject({ method: "PATCH", url: url.replace(TARGET, "bad-id"), headers, payload })).statusCode, 400);
    assert.equal((await server.inject({ method: "PATCH", url, headers, payload: { ...payload, padding: "x".repeat(2000) } })).statusCode, 413);
    assert.equal(db.mutations().length, 0);
    db.role = "viewer";
    assert.equal((await server.inject({ method: "PATCH", url, headers, payload })).statusCode, 403);
    assert.equal(db.mutations().length, 0);
    db.role = "operator";
    const saved = await server.inject({ method: "PATCH", url, headers, payload });
    assert.equal(saved.statusCode, 200);
    assert.deepEqual(saved.json().data, { id: TARGET, poll_interval_seconds: 900, changed: true });
    assert.equal((await server.inject({ method: "PATCH", url, headers, payload })).json().data.changed, false);
    assert.equal(db.mutations().length, 1);
    assert.equal((await server.inject({ method: "POST", url: "/api/application/managed-targets", headers,
      payload: { actor_id: ACTOR, input: managed } })).statusCode, 403);
    assert.equal(db.mutations().length, 1);
  } finally { await server.close(); }
});
