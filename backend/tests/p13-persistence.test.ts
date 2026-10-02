import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { P12_TABLES } from "../src/data-migration/contract.js";
import type { PostgresQuery, PostgresTransactionalQuery } from "../src/persistence/postgres-query.js";
import { PostgresRunnerHeartbeatRepository } from "../src/persistence/runner-heartbeat.js";
import { PostgresNetworkHealthRepository } from "../src/persistence/network-health.js";
import { PostgresTrafficRepository } from "../src/persistence/traffic.js";
import { PostgresManagedTelemetryRepository } from "../src/persistence/managed-telemetry.js";
import { PostgresProfilesRepository } from "../src/persistence/profiles.js";
import { PostgresNetworkInventoryRepository } from "../src/persistence/inventory.js";
import { PostgresHopMeasurementsRepository } from "../src/persistence/hop-measurements.js";
import { buildServer } from "../src/server.js";

const migration = readFileSync(fileURLToPath(new URL("../migrations/007_application_persistence.sql", import.meta.url)), "utf8");

test("migration 007 carries all 21 reviewed application tables without Auth, Realtime, or Asset DDL", () => {
  assert.equal(P12_TABLES.length, 21);
  const created = [...migration.matchAll(/CREATE TABLE public\.([a-z_]+)\s*\(/g)].map((match) => match[1]);
  assert.deepEqual(new Set(created), new Set([...P12_TABLES.map(({ table }) => table), "application_schema_migrations"]));
  assert.match(migration, /current_database\(\) <> 'jhc_netops'/);
  assert.match(migration, /current_setting\('port'\)::integer <> 5433/);
  assert.match(migration, /to_regclass\('asset\.assets'\) IS NULL/);
  assert.match(migration, /INSERT INTO public\.application_schema_migrations\(version\) VALUES \(7\)/);
  assert.doesNotMatch(migration, /(?:CREATE|ALTER|DROP|INSERT INTO|UPDATE|DELETE FROM)\s+(?:TABLE\s+)?(?:auth|realtime|storage|asset)\./i);
  assert.doesNotMatch(migration, /CREATE PUBLICATION|ALTER PUBLICATION|auth\.users/i);
  assert.match(migration, /requested_by uuid NOT NULL/);
});

test("local heartbeat writes parameterized SQL and preserves the existing stored response", async () => {
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const database: PostgresQuery = {
    async rows(sql, values) {
      calls.push({ sql, values });
      return [{ id: "runner-1", last_seen_at: new Date("2026-09-16T00:00:00Z"),
        health_status: "online", health_error_code: null }];
    },
  };
  const repository = new PostgresRunnerHeartbeatRepository(database);
  const stored = await repository.upsertHeartbeat({
    id: "runner-1", display_name: "Runner", last_seen_at: "2026-09-16T00:00:00Z",
    health_status: "online", health_error_code: null,
    capabilities: { source_locations: [], targets: [], durations: [], traffic_durations_seconds: [], operations: [] },
    updated_at: "2026-09-16T00:00:00Z",
  }, new AbortController().signal);
  assert.deepEqual(stored, { id: "runner-1", last_seen_at: "2026-09-16T00:00:00.000Z",
    health_status: "online", health_error_code: null });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /ON CONFLICT \(id\) DO UPDATE/);
  assert.equal(calls[0]!.values[0], "runner-1");
});

test("local stale-session recovery retains the reviewed bounded lease predicate", async () => {
  const calls: string[] = [];
  const database: PostgresQuery = { async rows(sql) { calls.push(sql); return []; } };
  await new PostgresRunnerHeartbeatRepository(database).expireStaleTrafficSessions("runner-1", new AbortController().signal);
  assert.equal(calls.length, 1);
  for (const fragment of ["10 minutes", "30 seconds", "45 seconds", "SESSION_ORPHANED"]) {
    assert.ok(calls[0]!.includes(fragment));
  }
});

test("local Health Watch rejects an unassigned target before any mutation", async () => {
  const queries: string[] = [];
  const database: PostgresTransactionalQuery = {
    async rows(sql) { queries.push(sql); return []; },
    async transaction(_signal, action) { return action(this); },
  };
  const repository = new PostgresNetworkHealthRepository(database);
  await assert.rejects(repository.publish("runner-1", [{
    target_id: "11111111-1111-4111-8111-111111111111", status: "online", latency_ms: 1,
    packet_loss_percent: 0, last_checked_at: "2026-09-16T00:00:00Z", last_success_at: "2026-09-16T00:00:00Z",
    consecutive_failures: 0, sample_count: 1,
  }], [], "2026-09-16T00:00:00Z", new AbortController().signal),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "TARGET_NOT_AUTHORIZED");
  assert.equal(queries.length, 1);
  assert.match(queries[0]!, /t\.runner_id = \$1 AND t\.enabled = true/);
});

test("local Health Watch reuses minute coalescing and event deduplication semantics", async () => {
  const queries: string[] = [];
  const targetId = "11111111-1111-4111-8111-111111111111";
  const eventId = "22222222-2222-4222-8222-222222222222";
  const database: PostgresQuery = {
    async rows(sql) {
      queries.push(sql);
      if (sql.includes("FROM public.network_targets t")) return [{ id: targetId, critical: true, name: "Lab", ip_address: "192.168.1.10" }];
      if (sql.includes("RETURNING id")) return [{ id: eventId }];
      return [];
    },
  };
  const result = await new PostgresNetworkHealthRepository(database).publish("runner-1", [{
    target_id: targetId, status: "offline", latency_ms: null, packet_loss_percent: 100,
    last_checked_at: "2026-09-16T00:00:22Z", last_success_at: null, consecutive_failures: 3, sample_count: 3,
  }], [{ event_id: eventId, target_id: targetId, previous_status: "online", new_status: "offline",
    occurred_at: "2026-09-16T00:00:22Z", latency_ms: null, packet_loss_percent: 100,
    consecutive_failures: 3 }], "2026-09-16T00:00:22Z", new AbortController().signal);
  assert.deepEqual(result, { states: 1, events: 1 });
  assert.ok(queries.some((sql) => sql.includes("ON CONFLICT (target_id,sampled_at)")));
  assert.ok(queries.some((sql) => sql.includes("ON CONFLICT (id) DO NOTHING")));
});

test("local Traffic claim is runner-scoped and cannot double-claim a queued session", async () => {
  const queries: string[] = [];
  const database: PostgresTransactionalQuery = {
    async rows(sql) { queries.push(sql); return []; },
    async transaction(_signal, action) { return action(this); },
  };
  const claim = await new PostgresTrafficRepository(database).claim("runner-1", new Date("2026-09-16T00:00:00Z"),
    new AbortController().signal);
  assert.equal(claim, null);
  assert.equal(queries.length, 2);
  assert.match(queries[1]!, /FOR UPDATE SKIP LOCKED/);
  assert.match(queries[1]!, /runner_id=\$1 AND status='queued'/);
  assert.match(queries[1]!, /AND s.status='queued'/);
});

test("local Traffic rejects snapshot publication for a non-active runner session", async () => {
  const queries: string[] = [];
  const database: PostgresTransactionalQuery = {
    async rows(sql) { queries.push(sql); return []; },
    async transaction(_signal, action) { return action(this); },
  };
  const repository = new PostgresTrafficRepository(database);
  await assert.rejects(repository.updateSnapshot({
    action: "update_snapshot", runner_id: "runner-1", session_id: "11111111-1111-4111-8111-111111111111",
    snapshot: { captured_at: "2026-09-16T00:00:00Z", summary: {}, flows: [], conversations: [], top_talkers: [] },
  }, "2026-09-16T00:00:00Z", new AbortController().signal),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "SESSION_NOT_ACTIVE");
  assert.equal(queries.length, 1);
  assert.match(queries[0]!, /runner_id=\$1 AND status IN \('running','stopping'\)/);
});

test("local Managed Telemetry rejects an unauthorized target inside the write transaction", async () => {
  let transactions = 0;
  const sql: string[] = [];
  const database: PostgresTransactionalQuery = {
    async rows() { throw new Error("outside transaction"); },
    async transaction(_signal, action) {
      transactions += 1;
      return action({ async rows(query) { sql.push(query); return []; } });
    },
  };
  const repository = new PostgresManagedTelemetryRepository(database);
  await assert.rejects(repository.publish("runner-1", {
    target_id: "11111111-1111-4111-8111-111111111111", status: "unreachable",
  }, [], [], [], "2026-09-16T00:00:00Z", new AbortController().signal),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "TARGET_NOT_AUTHORIZED");
  assert.equal(transactions, 1);
  assert.equal(sql.length, 1);
  assert.match(sql[0]!, /runner_id=\$1 AND enabled=true FOR UPDATE/);
});

test("local Managed Telemetry publishes current/stale hosts atomically and preserves first seen", async () => {
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const targetId = "11111111-1111-4111-8111-111111111111";
  const database: PostgresTransactionalQuery = {
    async rows() { throw new Error("outside transaction"); },
    async transaction(_signal, action) {
      return action({ async rows(sql, values) {
        calls.push({ sql, values });
        if (sql.includes("SELECT id FROM public.managed_telemetry_targets")) return [{ id: targetId }];
        if (sql.includes("SELECT host(ip_address) AS ip_address,first_seen_at")) return [
          { ip_address: "192.168.1.10", first_seen_at: new Date("2026-09-15T00:00:00Z"),
            netbios_name: "OldName", enrichment_status: "resolved" },
          { ip_address: "192.168.1.11", first_seen_at: new Date("2026-09-15T00:00:00Z"),
            netbios_name: null, enrichment_status: "unavailable" },
        ];
        return [];
      } });
    },
  };
  const result = await new PostgresManagedTelemetryRepository(database).publish("runner-1", {
    target_id: targetId, status: "connected", sys_name: "lab", observed_hosts_status: "available",
  }, [], [], [{ target_id: targetId, ip_address: "192.168.1.10", mac_address: null,
    netbios_name: null, observation_source: "ip_net_to_physical", enrichment_status: "unavailable" }],
  "2026-09-16T00:00:00Z", new AbortController().signal);
  assert.deepEqual(result, { devices: 1, interfaces: 0, observed_hosts: 1, events: 0 });
  assert.ok(calls.some(({ sql }) => sql.includes("DELETE FROM public.managed_interface_latest")));
  assert.ok(calls.some(({ sql }) => sql.includes("status='stale'")));
  const current = calls.find(({ sql }) => sql.includes("INSERT INTO public.managed_observed_hosts_latest"));
  assert.ok(current);
  const rows = JSON.parse(String(current.values[0])) as { first_seen_at: string; netbios_name: string }[];
  assert.equal(rows[0]!.first_seen_at, "2026-09-15T00:00:00.000Z");
  assert.equal(rows[0]!.netbios_name, "OldName");
});

test("local profile adapter keeps Supabase Auth UUID external and bootstraps pending only", async () => {
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const database: PostgresTransactionalQuery = {
    async rows(sql, values) {
      calls.push({ sql, values });
      return [{ id: "11111111-1111-4111-8111-111111111111", email: "test@example.invalid",
        full_name: null, role: "viewer", status: "pending", created_at: new Date("2026-09-16T00:00:00Z"),
        approved_at: null, approved_by: null }];
    },
    async transaction() { throw new Error("unused"); },
  };
  const repository = new PostgresProfilesRepository(database);
  const row = await repository.bootstrapPending("11111111-1111-4111-8111-111111111111", "test@example.invalid", null,
    new AbortController().signal);
  assert.equal(row.status, "pending");
  assert.equal(row.id, "11111111-1111-4111-8111-111111111111");
  assert.match(calls[0]!.sql, /VALUES \(\$1::uuid,\$2,\$3,'viewer','pending'\)/);
  assert.doesNotMatch(calls[0]!.sql, /auth\.users/i);
});

test("local profile access denies pending admin and retains approval metadata on role-only edit", async () => {
  const actorId = "11111111-1111-4111-8111-111111111111";
  const targetId = "22222222-2222-4222-8222-222222222222";
  let actorStatus = "pending";
  const calls: string[] = [];
  const database: PostgresTransactionalQuery = {
    async rows() { throw new Error("outside transaction"); },
    async transaction(_signal, action) {
      return action({ async rows(sql, values) {
        calls.push(sql);
        if (sql.includes("FROM public.profiles WHERE id")) return [{
          id: values[0], email: "test@example.invalid", full_name: null,
          role: "admin", status: values[0] === actorId ? actorStatus : "approved",
          created_at: "2026-09-15T00:00:00Z", approved_at: "2026-09-15T00:00:00Z", approved_by: actorId,
        }];
        if (sql.includes("count(*)")) return [{ count: 2 }];
        if (sql.includes("FROM public.local_auth_credentials")) return [{ user_id: actorId }];
        return [];
      } });
    },
  };
  const repository = new PostgresProfilesRepository(database);
  await assert.rejects(repository.setAccess(actorId, targetId, "operator", "active", new AbortController().signal),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "ADMIN_ACCESS_REQUIRED");
  assert.equal(calls.filter((sql) => sql.includes("UPDATE public.profiles")).length, 0);
  actorStatus = "approved";
  assert.equal(await repository.setAccess(actorId, targetId, "operator", "active", new AbortController().signal), targetId);
  const update = calls.find((sql) => sql.includes("UPDATE public.profiles"));
  assert.ok(update);
  assert.match(update, /WHEN \$3='approved' AND status='approved' THEN approved_at/);
  assert.match(update, /WHEN \$3='approved' AND status='approved' THEN approved_by/);
  assert.ok(calls.some((sql) => sql.includes("LOCK TABLE public.profiles")));
});

test("local inventory blocks pending operators before creating a node", async () => {
  const queries: string[] = [];
  const database: PostgresTransactionalQuery = {
    async rows() { throw new Error("outside transaction"); },
    async transaction(_signal, action) {
      return action({ async rows(sql) {
        queries.push(sql);
        if (sql.includes("SELECT role,status")) return [{ role: "operator", status: "pending" }];
        return [];
      } });
    },
  };
  await assert.rejects(new PostgresNetworkInventoryRepository(database).createNode(
    "11111111-1111-4111-8111-111111111111",
    { ip_address: "192.168.1.10", name: "Lab", device_type: "server", location: null, notes: null },
    new AbortController().signal),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "OPERATOR_ACCESS_REQUIRED");
  assert.equal(queries.filter((sql) => sql.includes("INSERT INTO public.network_nodes")).length, 0);
});

test("local target CRUD uses local profile authorization, fixed SQL and credential references only", async () => {
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const database: PostgresTransactionalQuery = {
    async rows() { throw new Error("outside transaction"); },
    async transaction(_signal, action) {
      return action({ async rows(sql, values) {
        calls.push({ sql, values });
        if (sql.includes("SELECT role,status")) return [{ role: "operator", status: "approved" }];
        if (sql.includes("FROM public.diagnostic_runners")) return [{ id: "runner-1" }];
        if (sql.includes("RETURNING id,node_id")) return [{ id: "33333333-3333-4333-8333-333333333333" }];
        return [];
      } });
    },
  };
  const repository = new PostgresNetworkInventoryRepository(database);
  await repository.upsertHealthTarget("11111111-1111-4111-8111-111111111111", {
    node_id: "22222222-2222-4222-8222-222222222222", runner_id: "runner-1",
    enabled: true, critical: false, probe_interval_seconds: 30, timeout_ms: 1000,
    failure_threshold: 3, recovery_threshold: 2, latency_warning_ms: 100,
    loss_warning_percent: 40,
  }, new AbortController().signal);
  await repository.upsertManagedTarget("11111111-1111-4111-8111-111111111111", {
    node_id: "22222222-2222-4222-8222-222222222222", runner_id: "runner-1",
    enabled: true, credential_profile_ref: "authorized-readonly", snmp_version: "3",
    snmp_port: 161, poll_interval_seconds: 60, oper_error_threshold: 5,
    discard_threshold: 10, util_warning_percent: 80, util_critical_percent: 95,
    util_sustained_seconds: 300,
  }, new AbortController().signal);
  assert.ok(calls.some(({ sql }) => sql.includes("ON CONFLICT (runner_id,node_id)")));
  assert.ok(calls.some(({ sql }) => sql.includes("credential_profiles' ? $2")));
  assert.ok(calls.every(({ sql }) => !/community|auth_password|priv_password/i.test(sql)));
  assert.ok(calls.some(({ values }) => values.includes("authorized-readonly")));
});

test("local application routes reject unauthenticated and malformed frontend writes before repository SQL", async () => {
  const queries: string[] = [];
  const database: PostgresTransactionalQuery = {
    async rows(sql) { queries.push(sql); return []; },
    async transaction(_signal, action) { return action({ async rows(sql) { queries.push(sql); return []; } }); },
  };
  const server = buildServer({ logger: false, application: {
    token: "frontend-server-token-for-tests-only",
    profiles: new PostgresProfilesRepository(database),
    inventory: new PostgresNetworkInventoryRepository(database),
  } });
  try {
    const unauthorized = await server.inject({ method: "POST", url: "/api/application/network-nodes",
      payload: { actor_id: "11111111-1111-4111-8111-111111111111", input: {} } });
    assert.equal(unauthorized.statusCode, 401);
    const malformed = await server.inject({ method: "POST", url: "/api/application/network-nodes",
      headers: { authorization: "Bearer frontend-server-token-for-tests-only" },
      payload: { actor_id: "11111111-1111-4111-8111-111111111111",
        input: { ip_address: "192.168.1.10", name: "Lab", device_type: "server", location: null,
          notes: null, unexpected: "not allowed" } } });
    assert.equal(malformed.statusCode, 400);
    assert.deepEqual(queries, []);
  } finally {
    await server.close();
  }
});

test("local Health and SNMP list routes require bearer auth and return UI read models", async () => {
  const queries: string[] = [];
  const targetId = "22222222-2222-4222-8222-222222222222";
  const node = { id: "11111111-1111-4111-8111-111111111111", ip_address: "192.168.1.8",
    name: "Ruijie", device_type: "router", location: "IT", detected_fingerprint: null,
    last_inspected_at: null };
  const database: PostgresTransactionalQuery = {
    async rows(sql) {
      queries.push(sql);
      if (sql.includes("FROM public.diagnostic_runners ORDER BY")) {
        return [{ id: "runner-1", display_name: "Runner", capabilities: { operations: ["manual_ping"] } }];
      }
      if (sql.includes("FROM public.network_targets t")) {
        return [{ id: targetId, node_id: node.id, runner_id: "runner-1", enabled: true,
          critical: true, node, latest: { status: "online", latency_ms: 1.2 } }];
      }
      if (sql.includes("FROM public.managed_telemetry_targets t")) {
        return [{ id: targetId, node_id: node.id, runner_id: "runner-1", enabled: true,
          util_warning_percent: "80", util_critical_percent: "95", node,
          latest: { target_id: targetId, status: "connected", sys_name: "core" } }];
      }
      if (sql.includes("FROM public.managed_interface_latest")) {
        return [{ target_id: targetId, if_index: 1, name: "eth0", is_physical: true }];
      }
      if (sql.includes("FROM public.managed_observed_hosts_latest")) {
        return [{ target_id: targetId, ip_address: "192.168.1.20", status: "current",
          network_nodes: { name: "Workstation" } }];
      }
      return [];
    },
    async transaction(_signal, action) { return action(this); },
  };
  const server = buildServer({ logger: false, application: {
    token: "frontend-server-token-for-tests-only",
    profiles: new PostgresProfilesRepository(database),
    inventory: new PostgresNetworkInventoryRepository(database),
  } });
  const routes = [
    "/api/application/runners",
    "/api/application/network-targets",
    "/api/application/managed-targets",
    `/api/application/managed-interfaces?target_id=${targetId}`,
    `/api/application/managed-observed-hosts?target_id=${targetId}`,
  ];
  try {
    for (const url of routes) {
      const unauthorized = await server.inject({ method: "GET", url });
      assert.equal(unauthorized.statusCode, 401);
    }
    assert.deepEqual(queries, []);
    const responses = await Promise.all(routes.map((url) => server.inject({ method: "GET", url,
      headers: { authorization: "Bearer frontend-server-token-for-tests-only" } })));
    assert.ok(responses.every((response) => response.statusCode === 200));
    assert.equal(responses[0]?.json().data[0].capabilities.operations[0], "manual_ping");
    assert.equal(responses[1]?.json().data[0].node.ip_address, "192.168.1.8");
    assert.equal(responses[1]?.json().data[0].latest.status, "online");
    assert.equal(responses[2]?.json().data[0].latest.sys_name, "core");
    assert.equal(responses[2]?.json().data[0].util_warning_percent, 80);
    assert.equal(responses[3]?.json().data[0].target_id, targetId);
    assert.equal(responses[4]?.json().data[0].network_nodes.name, "Workstation");
  } finally {
    await server.close();
  }
});

test("local application exposes bounded authoritative Traffic and hop read models", async () => {
  const database: PostgresTransactionalQuery = {
    async rows(sql) {
      if (sql.includes("FROM public.traffic_live_sessions")) return [{ id: "session-1", status: "running" }];
      if (sql.includes("FROM public.traffic_live_snapshots")) return [{ runner_id: "runner-1", captured_at: "2026-09-23T00:00:00Z" }];
      if (sql.includes("pg_total_relation_size")) return [{ storage_mb: "12.5", status: "healthy" }];
      if (sql.includes("FROM public.hop_measurements")) return [{ id: "hop-1", hop_number: 1 }];
      return [];
    },
    async transaction(_signal, action) { return action(this); },
  };
  const server = buildServer({ logger: false, application: {
    token: "frontend-server-token-for-tests-only",
    profiles: new PostgresProfilesRepository(database),
    inventory: new PostgresNetworkInventoryRepository(database),
    traffic: new PostgresTrafficRepository(database),
    hopMeasurements: new PostgresHopMeasurementsRepository(database),
  } });
  const headers = { authorization: "Bearer frontend-server-token-for-tests-only" };
  try {
    assert.equal((await server.inject({ method: "GET", url: "/api/application/traffic-state" })).statusCode, 401);
    const traffic = await server.inject({ method: "GET", url: "/api/application/traffic-state", headers });
    assert.equal(traffic.statusCode, 200);
    assert.equal(traffic.json().data.sessions[0].id, "session-1");
    assert.equal(traffic.json().data.snapshots[0].runner_id, "runner-1");
    assert.equal(traffic.json().data.storage_status.storage_mb, 12.5);
    const hops = await server.inject({ method: "GET", url: "/api/application/hop-measurements?limit=512", headers });
    assert.equal(hops.statusCode, 200);
    assert.equal(hops.json().data[0].hop_number, 1);
  } finally {
    await server.close();
  }
});

test("local target deletion requires a backend-checked exact confirmation", async () => {
  const queries: string[] = [];
  const database: PostgresTransactionalQuery = {
    async rows() { throw new Error("outside transaction"); },
    async transaction(_signal, action) { return action({ async rows(sql) {
      queries.push(sql);
      if (sql.includes("SELECT role,status")) return [{ role: "operator", status: "approved" }];
      if (sql.includes("JOIN public.network_nodes")) return [{ name: "Lab", ip_address: "192.168.1.10" }];
      return [];
    } }); },
  };
  const repository = new PostgresNetworkInventoryRepository(database);
  await assert.rejects(repository.deleteHealthTarget("11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222", "Wrong (192.168.1.10)", new AbortController().signal),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "CONFIRMATION_MISMATCH");
  assert.equal(queries.filter((sql) => sql.includes("DELETE FROM public.network_targets")).length, 0);
});

test("local Health target promotion is bounded, deduplicated, and atomic", async () => {
  const nodeId = "22222222-2222-4222-8222-222222222222";
  const calls: string[] = [];
  let transactions = 0;
  const database: PostgresTransactionalQuery = {
    async rows() { throw new Error("outside transaction"); },
    async transaction(_signal, action) {
      transactions += 1;
      return action({ async rows(sql) {
        calls.push(sql);
        if (sql.includes("SELECT role,status")) return [{ role: "operator", status: "approved" }];
        if (sql.includes("INSERT INTO public.network_targets")) return [{ node_id: nodeId }];
        return [];
      } });
    },
  };
  const repository = new PostgresNetworkInventoryRepository(database);
  const added = await repository.promoteHealthTargets("11111111-1111-4111-8111-111111111111",
    "runner-1", [nodeId], new AbortController().signal);
  assert.deepEqual(added, [nodeId]);
  assert.equal(transactions, 1);
  assert.ok(calls.some((sql) => sql.includes("ON CONFLICT (runner_id,node_id) DO UPDATE SET enabled=true")));
  await assert.rejects(repository.promoteHealthTargets("11111111-1111-4111-8111-111111111111",
    "runner-1", [nodeId,nodeId], new AbortController().signal));
  assert.equal(transactions, 1);
});

test("local fingerprint persistence rejects mismatched IP and secret-shaped keys", async () => {
  const calls: string[] = [];
  const database: PostgresTransactionalQuery = {
    async rows() { throw new Error("outside transaction"); },
    async transaction(_signal, action) { return action({ async rows(sql) {
      calls.push(sql);
      if (sql.includes("SELECT role,status")) return [{ role: "operator", status: "approved" }];
      if (sql.includes("SELECT host(ip_address)")) return [{ ip_address: "192.168.1.10" }];
      return [];
    } }); },
  };
  const repository = new PostgresNetworkInventoryRepository(database);
  await assert.rejects(repository.saveFingerprint("11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    { ip: "192.168.1.11", confidence: "high" }, "2026-09-16T00:00:00Z", new AbortController().signal));
  await assert.rejects(repository.saveFingerprint("11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    { ip: "192.168.1.10", confidence: "high", password: "test-only" },
    "2026-09-16T00:00:00Z", new AbortController().signal));
  assert.equal(calls.filter((sql) => sql.includes("UPDATE public.network_nodes")).length, 0);
});
