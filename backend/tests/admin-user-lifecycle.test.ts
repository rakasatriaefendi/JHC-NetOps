import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { PostgresProfilesRepository, ProfilePersistenceError } from "../src/persistence/profiles.js";
import type { PostgresQuery, PostgresTransactionalQuery } from "../src/persistence/postgres-query.js";
import { PostgresLocalAuthRepository, LocalAuthError } from "../src/local-auth/repository.js";
import { createPasswordRecord } from "../src/local-auth/password.js";
import { PostgresNetworkInventoryRepository } from "../src/persistence/inventory.js";
import { buildServer } from "../src/server.js";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";
const signal = () => new AbortController().signal;
const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const profile = (id: string, role = "viewer", status = "approved") => ({
  id, email: `${id}@example.invalid`, full_name: null, role, status,
  created_at: "2026-10-02T00:00:00Z", approved_at: "2026-10-02T00:00:00Z", approved_by: ACTOR,
  disabled_at: status === "disabled" ? "2026-10-02T01:00:00Z" : null,
  disabled_by: status === "disabled" ? ACTOR : null,
});

class LifecycleDatabase implements PostgresTransactionalQuery {
  profiles = new Map<string, Record<string, unknown>>([[ACTOR, profile(ACTOR, "admin")], [TARGET, profile(TARGET)]]);
  credentials = new Set([ACTOR]);
  calls: { sql: string; values: readonly unknown[] }[] = [];
  history = false;
  countOverride: number | undefined;
  transactions = 0;
  async transaction<T>(transactionSignal: AbortSignal, action: (query: PostgresQuery) => Promise<T>): Promise<T> {
    transactionSignal.throwIfAborted();
    this.transactions += 1;
    return action(this);
  }
  async rows(sql: string, values: readonly unknown[]) {
    this.calls.push({ sql, values });
    const id = String(values[0]);
    if (sql.includes("AS has_history")) return [{ has_history: this.history }];
    if (sql.includes("count(*)")) return [{ count: this.countOverride ?? [...this.profiles.values()].filter((row) =>
      row.id !== id && row.role === "admin" && row.status === "approved" && this.credentials.has(String(row.id))).length }];
    if (sql.includes("SELECT user_id FROM public.local_auth_credentials")) return this.credentials.has(id) ? [{ user_id: id }] : [];
    if (sql.includes("FROM public.profiles WHERE id")) {
      const row = this.profiles.get(id);
      return row ? [row] : [];
    }
    return [];
  }
}

const mutations = (db: LifecycleDatabase) => db.calls.filter(({ sql }) => /^\s*(INSERT|UPDATE|DELETE)\b/.test(sql));
const rejectsCode = (code: ProfilePersistenceError["code"]) => (error: unknown) =>
  error instanceof ProfilePersistenceError && error.code === code;

test("migration 016 guards dedicated PostgreSQL and records only version 16", () => {
  const sql = source("../migrations/016_admin_user_lifecycle.sql");
  for (const guard of ["current_database() <> 'jhc_netops'", "current_setting('port')::integer <> 5433",
    "BETWEEN 160000 AND 169999", "current_setting('data_directory') <> '/var/lib/postgresql/16/jhcnetops'",
    "session_user <> 'postgres'", "version = 15", "max(version)", "SET ROLE jhc_netops_owner", "RESET ROLE;"])
    assert.ok(sql.includes(guard));
  assert.match(sql, /BEGIN;[\s\S]*INSERT INTO public\.application_schema_migrations\(version\) VALUES \(16\);[\s\S]*COMMIT;/);
  assert.match(sql, /inet_server_addr\(\) IS NOT NULL AND host\(inet_server_addr\(\)\) NOT IN \('127\.0\.0\.1', '::1'\)/);
  assert.doesNotMatch(sql, /(?:ALTER|DROP|UPDATE|DELETE FROM)\s+(?:TABLE\s+)?asset\./i);
});

test("migration 016 retains historical requester rows and keeps audit append-only without profile FKs", () => {
  const sql = source("../migrations/016_admin_user_lifecycle.sql");
  assert.match(sql, /profiles_status_check CHECK \(status IN \('pending', 'approved', 'rejected', 'disabled'\)\)/);
  assert.match(sql, /status = 'disabled' AND disabled_at IS NOT NULL/);
  assert.match(sql, /status <> 'disabled' AND disabled_at IS NULL AND disabled_by IS NULL/);
  assert.match(sql, /disabled_by uuid REFERENCES public\.profiles\(id\) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED/);
  for (const table of ["device_inspection_sessions", "network_discovery_sessions"]) {
    const block = sql.slice(sql.indexOf(`ALTER TABLE public.${table}`)).split(";")[0]!;
    assert.match(block, /ALTER COLUMN requested_by DROP NOT NULL/);
    assert.match(block, /FOREIGN KEY \(requested_by\) REFERENCES public\.profiles\(id\) ON DELETE SET NULL/);
  }
  const audit = sql.split("CREATE TABLE public.account_lifecycle_audit (")[1]!.split(");")[0]!;
  assert.match(audit, /actor_id uuid,[\s\S]*target_id uuid NOT NULL/);
  assert.doesNotMatch(audit, /REFERENCES/);
  for (const action of ["access_changed", "account_disabled", "account_reenabled", "account_deleted"]) assert.ok(audit.includes(action));
  for (const column of ["previous_role", "next_role", "previous_status", "next_status"]) assert.match(audit, new RegExp(`${column} text CHECK`));
  assert.match(sql, /REVOKE ALL ON public\.account_lifecycle_audit FROM PUBLIC, jhc_netops_app/);
  const grantStatements = sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\r\n]*/g, "")
    .split(";").map((statement) => statement.trim()).filter((statement) => /^GRANT\b/i.test(statement));
  assert.ok(grantStatements.includes("GRANT SELECT, INSERT ON public.account_lifecycle_audit TO jhc_netops_app"));
  for (const statement of grantStatements) {
    if (/\bON\b[\s\S]*\bpublic\.account_lifecycle_audit\b/i.test(statement)) {
      const privileges = statement.split(/\bON\b/i)[0]!;
      assert.doesNotMatch(privileges, /\b(?:UPDATE|DELETE|ALL)\b/i);
    }
  }
});

test("lifecycle authorizes only approved admins with a Local Auth credential before mutation", async () => {
  for (const [role, status, credential] of [["admin", "pending", true], ["admin", "rejected", true],
    ["admin", "disabled", true], ["operator", "approved", true], ["viewer", "approved", true],
    ["admin", "approved", false]] as const) {
    const db = new LifecycleDatabase();
    db.profiles.set(ACTOR, profile(ACTOR, role, status));
    if (!credential) db.credentials.delete(ACTOR);
    await assert.rejects(new PostgresProfilesRepository(db).disable(ACTOR, TARGET, signal()), rejectsCode("ADMIN_ACCESS_REQUIRED"));
    assert.equal(mutations(db).length, 0);
  }
});

test("self-disable, self-delete and self-demotion are blocked", async () => {
  const db = new LifecycleDatabase();
  const repo = new PostgresProfilesRepository(db);
  await assert.rejects(repo.disable(ACTOR, ACTOR, signal()), rejectsCode("SELF_DISABLE_BLOCKED"));
  await assert.rejects(repo.delete(ACTOR, ACTOR, signal()), rejectsCode("SELF_DELETE_BLOCKED"));
  await assert.rejects(repo.setAccess(ACTOR, ACTOR, "viewer", "active", signal()), rejectsCode("SELF_DEMOTION_BLOCKED"));
  assert.equal(mutations(db).length, 0);
  const casedId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  db.profiles.set(casedId.toUpperCase(), profile(casedId, "admin"));
  db.credentials.add(casedId.toUpperCase());
  await assert.rejects(repo.disable(casedId.toUpperCase(), casedId, signal()), rejectsCode("SELF_DISABLE_BLOCKED"));
  await assert.rejects(repo.delete(casedId.toUpperCase(), casedId, signal()), rejectsCode("SELF_DELETE_BLOCKED"));
});

test("remaining-admin guard counts credentials, rejects zero and runs under serialized lifecycle locks", async () => {
  for (const operation of ["disable", "demote", "suspend", "pending"] as const) {
    const db = new LifecycleDatabase();
    db.profiles.set(TARGET, profile(TARGET, "admin"));
    db.countOverride = 0;
    const repo = new PostgresProfilesRepository(db);
    await assert.rejects(operation === "disable" ? repo.disable(ACTOR, TARGET, signal()) :
      repo.setAccess(ACTOR, TARGET, operation === "demote" ? "operator" : "admin",
        operation === "suspend" ? "suspended" : operation === "pending" ? "pending" : "active", signal()),
    rejectsCode("LAST_LOGIN_CAPABLE_ADMIN_BLOCKED"));
    assert.equal(mutations(db).length, 0);
    const count = db.calls.find(({ sql }) => sql.includes("count(*)"))!;
    assert.match(count.sql, /JOIN public\.local_auth_credentials c ON c\.user_id=p\.id/);
    assert.match(count.sql, /p\.role='admin' AND p\.status='approved' AND p\.id<>\$1::uuid/);
    assert.ok(db.calls[0]!.sql.includes("LOCK TABLE public.profiles IN SHARE ROW EXCLUSIVE MODE"));
    assert.ok(db.calls.some(({ sql }) => /FROM public\.profiles WHERE id=\$1::uuid FOR UPDATE/.test(sql)));
  }
  const db = new LifecycleDatabase();
  db.profiles.set(TARGET, profile(TARGET, "admin")); // Credentialless profile is not a login-capable Admin.
  await new PostgresProfilesRepository(db).disable(ACTOR, TARGET, signal());
  assert.equal(db.credentials.size, 1);
});

test("disable preserves approval/role, revokes all target sessions and appends one audit atomically", async () => {
  const db = new LifecycleDatabase();
  assert.equal(await new PostgresProfilesRepository(db).disable(ACTOR, TARGET, signal()), TARGET);
  const writes = mutations(db);
  assert.equal(db.transactions, 1);
  assert.equal(writes.length, 3);
  assert.match(writes[0]!.sql, /status='disabled',disabled_at=now\(\),disabled_by=\$2::uuid/);
  assert.doesNotMatch(writes[0]!.sql, /approved_|\brole\s*=/);
  assert.match(writes[1]!.sql, /^DELETE FROM public\.local_auth_sessions WHERE user_id=\$1::uuid$/);
  assert.deepEqual(writes[1]!.values, [TARGET]);
  assert.deepEqual(writes[2]!.values, [ACTOR, TARGET, "account_disabled", "viewer", "viewer", "approved", "disabled"]);
});

test("only approved targets can be disabled and generic access cannot change disabled accounts", async () => {
  for (const status of ["pending", "rejected", "disabled"]) {
    const db = new LifecycleDatabase();
    db.profiles.set(TARGET, profile(TARGET, "viewer", status));
    await assert.rejects(new PostgresProfilesRepository(db).disable(ACTOR, TARGET, signal()), rejectsCode("ACCOUNT_NOT_DISABLEABLE"));
    assert.equal(mutations(db).length, 0);
  }
  const db = new LifecycleDatabase();
  db.profiles.set(TARGET, profile(TARGET, "viewer", "disabled"));
  await assert.rejects(new PostgresProfilesRepository(db).setAccess(ACTOR, TARGET, "operator", "active", signal()),
    rejectsCode("ACCOUNT_NOT_REENABLEABLE"));
  assert.equal(mutations(db).length, 0);
});

test("re-enable clears only disable metadata, preserves approval and requires fresh login", async () => {
  const db = new LifecycleDatabase();
  db.profiles.set(TARGET, profile(TARGET, "operator", "disabled"));
  await new PostgresProfilesRepository(db).reenable(ACTOR, TARGET, signal());
  const writes = mutations(db);
  assert.equal(writes.length, 2);
  assert.match(writes[0]!.sql, /status='approved',disabled_at=NULL,disabled_by=NULL/);
  assert.doesNotMatch(writes[0]!.sql, /approved_|\brole\s*=/);
  assert.equal(writes[1]!.values[2], "account_reenabled");
  assert.doesNotMatch(writes.map(({ sql }) => sql).join("\n"), /local_auth_sessions/);
  db.profiles.set(TARGET, profile(TARGET));
  await assert.rejects(new PostgresProfilesRepository(db).reenable(ACTOR, TARGET, signal()), rejectsCode("ACCOUNT_NOT_REENABLEABLE"));
});

test("access changes audit once, preserve approval metadata and true no-op writes nothing", async () => {
  const db = new LifecycleDatabase();
  const repo = new PostgresProfilesRepository(db);
  await repo.setAccess(ACTOR, TARGET, "viewer", "active", signal());
  assert.equal(mutations(db).length, 0);
  await repo.setAccess(ACTOR, TARGET, "operator", "active", signal());
  assert.equal(mutations(db).length, 2);
  assert.equal(mutations(db)[1]!.values[2], "access_changed");
  assert.match(mutations(db)[0]!.sql, /WHEN \$3='approved' AND status='approved' THEN approved_at/);
  for (const [access, status] of [["pending", "pending"], ["suspended", "rejected"]] as const) {
    const fixture = new LifecycleDatabase();
    await new PostgresProfilesRepository(fixture).setAccess(ACTOR, TARGET, "viewer", access, signal());
    assert.equal(mutations(fixture)[0]!.values[2], status);
  }
});

test("permanent delete is pending-only, refuses history and audits before profile deletion", async () => {
  for (const status of ["approved", "rejected", "disabled"]) {
    const db = new LifecycleDatabase();
    db.profiles.set(TARGET, profile(TARGET, "viewer", status));
    await assert.rejects(new PostgresProfilesRepository(db).delete(ACTOR, TARGET, signal()), rejectsCode("ACCOUNT_NOT_DELETABLE"));
    assert.equal(mutations(db).length, 0);
  }
  const db = new LifecycleDatabase();
  db.profiles.set(TARGET, profile(TARGET, "viewer", "pending"));
  db.history = true;
  await assert.rejects(new PostgresProfilesRepository(db).delete(ACTOR, TARGET, signal()), rejectsCode("ACCOUNT_HAS_HISTORY"));
  assert.equal(mutations(db).length, 0);
  const check = db.calls.find(({ sql }) => sql.includes("AS has_history"))!.sql;
  for (const reference of ["device_inspection_sessions WHERE requested_by", "network_discovery_sessions WHERE requested_by",
    "managed_telemetry_targets WHERE created_by", "network_nodes WHERE created_by", "network_targets WHERE created_by",
    "profiles WHERE approved_by", "diagnostic_jobs WHERE requested_by", "traffic_live_sessions WHERE requested_by",
    "network_health_ping_jobs WHERE requested_by"]) assert.ok(check.includes(reference));
  db.history = false;
  await new PostgresProfilesRepository(db).delete(ACTOR, TARGET, signal());
  const writes = mutations(db);
  assert.equal(writes.length, 2);
  assert.match(writes[0]!.sql, /INSERT INTO public\.account_lifecycle_audit/);
  assert.equal(writes[0]!.values[2], "account_deleted");
  assert.match(writes[1]!.sql, /^DELETE FROM public\.profiles WHERE id=\$1::uuid$/);
});

test("UUID validation and missing targets fail without mutation", async () => {
  const db = new LifecycleDatabase();
  const repo = new PostgresProfilesRepository(db);
  for (const action of ["disable", "reenable", "delete"] as const) {
    await assert.rejects(repo[action]("invalid", TARGET, signal()), rejectsCode("INVALID_PROFILE"));
    await assert.rejects(repo[action](ACTOR, "invalid", signal()), rejectsCode("INVALID_PROFILE"));
  }
  db.profiles.delete(TARGET);
  await assert.rejects(repo.disable(ACTOR, TARGET, signal()), rejectsCode("PROFILE_NOT_FOUND"));
  assert.equal(mutations(db).length, 0);
});

test("disabled login verifies password first and session resolution fails closed", async () => {
  const row = { ...profile(TARGET, "viewer", "disabled"), password_record: await createPasswordRecord("fixture-password-1") };
  let transactions = 0;
  const db: PostgresTransactionalQuery = {
    async rows() { return [row]; },
    async transaction() { transactions += 1; throw new Error("disabled login must not create a session"); },
  };
  const repo = new PostgresLocalAuthRepository(db);
  await assert.rejects(repo.login(row.email, "wrong-password", signal()),
    (error: unknown) => error instanceof LocalAuthError && error.code === "INVALID_CREDENTIALS");
  await assert.rejects(repo.login(row.email, "fixture-password-1", signal()),
    (error: unknown) => error instanceof LocalAuthError && error.code === "ACCOUNT_DISABLED");
  await assert.rejects(repo.resolve("A".repeat(43), signal()),
    (error: unknown) => error instanceof LocalAuthError && error.code === "SESSION_INVALID");
  assert.equal(transactions, 0);
});

test("disable racing password verification cannot recreate a session", async () => {
  const row = { ...profile(TARGET), password_record: await createPasswordRecord("fixture-password-1") };
  const calls: string[] = [];
  const db: PostgresTransactionalQuery = {
    async rows() { return [row]; },
    async transaction(transactionSignal, action) {
      return action({ async rows(sql) {
        transactionSignal.throwIfAborted();
        calls.push(sql);
        return sql.includes("FROM public.profiles") ? [{ ...row, status: "disabled" }] : [];
      } });
    },
  };
  await assert.rejects(new PostgresLocalAuthRepository(db).login(row.email, "fixture-password-1", signal()),
    (error: unknown) => error instanceof LocalAuthError && error.code === "ACCOUNT_DISABLED");
  assert.match(calls[0]!, /FOR SHARE/);
  assert.doesNotMatch(calls.join("\n"), /INSERT INTO public\.local_auth_sessions/);
});

test("lifecycle routes enforce bearer auth, exact body keys, actor UUID and DELETE USER confirmation", async () => {
  const db = new LifecycleDatabase();
  const token = "lifecycle-frontend-test-token-only";
  const server = buildServer({ logger: false, application: { token,
    profiles: new PostgresProfilesRepository(db), inventory: new PostgresNetworkInventoryRepository(db) } });
  const headers = { authorization: `Bearer ${token}` };
  try {
    for (const operation of ["disable", "reenable"] as const) {
      const url = `/api/application/profiles/${TARGET}/${operation}`;
      assert.equal((await server.inject({ method: "POST", url, payload: { actor_id: ACTOR } })).statusCode, 401);
      for (const payload of [{ actor_id: ACTOR, role: "admin" }, {}, { actor_id: "invalid" }]) {
        assert.equal((await server.inject({ method: "POST", url, headers, payload })).statusCode, 400);
      }
    }
    const url = `/api/application/profiles/${TARGET}`;
    for (const payload of [{ actor_id: ACTOR, confirmation: "delete user" }, { actor_id: ACTOR },
      { actor_id: ACTOR, confirmation: "DELETE USER", force: true }]) {
      assert.equal((await server.inject({ method: "DELETE", url, headers, payload })).statusCode, 400);
    }
    assert.equal((await server.inject({ method: "DELETE", url, payload: { actor_id: ACTOR, confirmation: "DELETE USER" } })).statusCode, 401);
    assert.equal((await server.inject({ method: "POST", url: `${url}/disable`, headers,
      payload: { actor_id: ACTOR, extra: "x".repeat(2_000) } })).statusCode, 413);
    assert.equal(db.transactions, 0);
    assert.equal((await server.inject({ method: "POST", url: `${url}/disable`, headers, payload: { actor_id: ACTOR } })).statusCode, 200);
    db.profiles.set(TARGET, profile(TARGET, "viewer", "disabled"));
    assert.equal((await server.inject({ method: "POST", url: `${url}/reenable`, headers, payload: { actor_id: ACTOR } })).statusCode, 200);
    db.profiles.set(TARGET, profile(TARGET, "viewer", "pending"));
    assert.equal((await server.inject({ method: "DELETE", url, headers, payload: { actor_id: ACTOR, confirmation: "DELETE USER" } })).statusCode, 200);
    db.history = true;
    const conflict = await server.inject({ method: "DELETE", url, headers, payload: { actor_id: ACTOR, confirmation: "DELETE USER" } });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().error.code, "ACCOUNT_HAS_HISTORY");
    assert.doesNotMatch(conflict.body, /SELECT|postgres|password|credential/i);
    db.credentials.delete(ACTOR);
    assert.equal((await server.inject({ method: "POST", url: `${url}/disable`, headers, payload: { actor_id: ACTOR } })).statusCode, 403);
  } finally { await server.close(); }
});
