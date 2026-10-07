import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PostgresProfilesRepository, ProfilePersistenceError } from "../src/persistence/profiles.js";
import { PostgresNetworkInventoryRepository } from "../src/persistence/inventory.js";
import type { PostgresQuery, PostgresTransactionalQuery } from "../src/persistence/postgres-query.js";
import { buildServer } from "../src/server.js";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const signal = () => new AbortController().signal;
const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const row = (id: string, role = "viewer", status = "approved") => ({
  id, email: `${id}@example.invalid`, full_name: "Previous name", role, status,
  created_at: "2026-10-07T00:00:00Z", approved_at: "2026-10-07T00:00:00Z", approved_by: OTHER,
  disabled_at: null, disabled_by: null,
});

class ProfileDatabase implements PostgresTransactionalQuery {
  profiles = new Map<string, Record<string, unknown>>([[USER, row(USER)], [OTHER, row(OTHER)]]);
  calls: { sql: string; values: readonly unknown[] }[] = [];
  transactions = 0;
  async transaction<T>(transactionSignal: AbortSignal, operation: (query: PostgresQuery) => Promise<T>): Promise<T> {
    transactionSignal.throwIfAborted();
    this.transactions += 1;
    return operation(this);
  }
  async rows(sql: string, values: readonly unknown[], querySignal: AbortSignal): Promise<readonly Record<string, unknown>[]> {
    querySignal.throwIfAborted();
    this.calls.push({ sql, values });
    const current = this.profiles.get(String(values[0]));
    if (sql.includes("FROM public.profiles WHERE id=")) return current ? [{ ...current }] : [];
    if (sql.startsWith("UPDATE public.profiles SET full_name=")) {
      if (!current || current.status !== "approved") return [];
      const updated = { ...current, full_name: values[1] };
      this.profiles.set(String(values[0]), updated);
      return [updated];
    }
    throw new Error("Unexpected SQL in self-profile test");
  }
}
const writes = (db: ProfileDatabase) => db.calls.filter(({ sql }) => /^\s*(INSERT|UPDATE|DELETE)\b/.test(sql));
const errorCode = (code: ProfilePersistenceError["code"]) => (error: unknown) => error instanceof ProfilePersistenceError && error.code === code;

test("approved users of every role can change only their own existing full_name, without audit/auth mutations", async () => {
  for (const role of ["viewer", "operator", "admin"]) {
    const db = new ProfileDatabase();
    const before = row(USER, role);
    db.profiles.set(USER, before);
    const result = await new PostgresProfilesRepository(db).setOwnName(USER, "  New display name  ", signal());
    assert.equal(result.changed, true);
    assert.deepEqual(result.profile, { ...before, full_name: "New display name" });
    assert.deepEqual(db.profiles.get(OTHER), row(OTHER));
    assert.equal(db.transactions, 1);
    assert.match(db.calls[0]!.sql, /WHERE id=\$1::uuid FOR UPDATE/);
    assert.equal(writes(db).length, 1);
    assert.match(writes(db)[0]!.sql, /SET full_name=\$2\s+WHERE id=\$1::uuid AND status='approved'/);
    assert.deepEqual(writes(db)[0]!.values, [USER, "New display name"]);
    assert.doesNotMatch(db.calls.map(({ sql }) => sql).join("\n"), /INSERT|DELETE|local_auth|account_lifecycle_audit|administrative_audit|SET role|SET status|SET email/);
  }
});

test("self-profile no-op returns changed=false and issues no UPDATE", async () => {
  const db = new ProfileDatabase();
  const result = await new PostgresProfilesRepository(db).setOwnName(USER, " Previous name ", signal());
  assert.equal(result.changed, false);
  assert.equal(writes(db).length, 0);
});

test("invalid names/UUIDs, missing profiles and non-approved profiles fail without mutation", async () => {
  const db = new ProfileDatabase();
  const repo = new PostgresProfilesRepository(db);
  for (const name of ["", "   ", "x".repeat(201), "name\n", "na\u0000me", "na\u0085me", "<b>Name</b>"]) {
    await assert.rejects(repo.setOwnName(USER, name, signal()), errorCode("INVALID_PROFILE"));
  }
  await assert.rejects(repo.setOwnName("not-a-uuid", "Name", signal()), errorCode("INVALID_PROFILE"));
  assert.equal(db.transactions, 0);
  for (const status of ["pending", "rejected", "disabled"]) {
    db.profiles.set(USER, row(USER, "viewer", status));
    await assert.rejects(repo.setOwnName(USER, "Name", signal()), errorCode("PROFILE_ACCESS_REQUIRED"));
  }
  db.profiles.delete(USER);
  await assert.rejects(repo.setOwnName(USER, "Name", signal()), errorCode("PROFILE_NOT_FOUND"));
  assert.equal(writes(db).length, 0);
});

test("self-profile preserves the existing 200-character bound and accepts a trimmed maximum-length name", async () => {
  const db = new ProfileDatabase();
  assert.equal((await new PostgresProfilesRepository(db).setOwnName(USER, ` ${"a".repeat(200)} `, signal())).profile.full_name, "a".repeat(200));
  const schema = source("../migrations/007_application_persistence.sql");
  assert.match(schema, /CREATE TABLE public\.profiles \([\s\S]*?full_name text/);
});

test("self-profile route requires the trusted frontend bearer, exact name/actor body, approved identity and bounded input", async () => {
  const db = new ProfileDatabase();
  const token = "self-profile-frontend-fixture-token-only";
  const server = buildServer({ logger: false, application: { token,
    profiles: new PostgresProfilesRepository(db), inventory: new PostgresNetworkInventoryRepository(db) } });
  const url = "/api/application/profiles/self/name";
  const headers = { authorization: `Bearer ${token}` };
  const payload = { actor_id: USER, full_name: "New name" };
  try {
    assert.equal((await server.inject({ method: "PATCH", url, payload })).statusCode, 401);
    for (const extra of ["target_id", "user_id", "role", "status", "email"]) {
      assert.equal((await server.inject({ method: "PATCH", url, headers, payload: { ...payload, [extra]: OTHER } })).statusCode, 400);
    }
    for (const invalid of [{ full_name: "Name" }, { actor_id: USER }, { ...payload, actor_id: "invalid" }, { ...payload, full_name: null }]) {
      assert.equal((await server.inject({ method: "PATCH", url, headers, payload: invalid })).statusCode, 400);
    }
    assert.equal((await server.inject({ method: "PATCH", url, headers, payload: { ...payload, full_name: "x".repeat(3_000) } })).statusCode, 413);
    assert.equal(db.transactions, 0);
    const saved = await server.inject({ method: "PATCH", url, headers, payload });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json<{ data: { changed: boolean } }>().data.changed, true);
    assert.match(String(saved.headers["cache-control"]), /no-store/);
    const unchanged = await server.inject({ method: "PATCH", url, headers, payload });
    assert.equal(unchanged.json<{ data: { changed: boolean } }>().data.changed, false);
    db.profiles.set(USER, row(USER, "viewer", "disabled"));
    const rejected = await server.inject({ method: "PATCH", url, headers, payload });
    assert.equal(rejected.statusCode, 403);
    assert.doesNotMatch(rejected.body, /UPDATE|SELECT|postgres|Bearer/);
    assert.equal(writes(db).length, 1);
  } finally { await server.close(); }
});
