import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parseEnrollmentArguments } from "../scripts/enroll-local-auth.js";
import { createPasswordRecord, verifyPasswordRecord } from "../src/local-auth/password.js";
import { LocalAuthError, PostgresLocalAuthRepository } from "../src/local-auth/repository.js";
import type { PostgresQuery, PostgresTransactionalQuery } from "../src/persistence/postgres-query.js";
import { buildServer } from "../src/server.js";

const migration = readFileSync(fileURLToPath(new URL("../migrations/011_local_auth.sql", import.meta.url)), "utf8");
const enrollmentScript = readFileSync(fileURLToPath(new URL("../scripts/enroll-local-auth.ts", import.meta.url)), "utf8");
const authRepository = readFileSync(fileURLToPath(new URL("../src/local-auth/repository.ts", import.meta.url)), "utf8");

test("migration 011 adds only local credential and session storage after migration 010", () => {
  assert.deepEqual([...migration.matchAll(/CREATE TABLE public\.([a-z_]+)/g)].map((match) => match[1]),
    ["local_auth_credentials", "local_auth_sessions"]);
  assert.match(migration, /version = 10/);
  assert.match(migration, /VALUES \(11\)/);
  assert.match(migration, /REFERENCES public\.profiles\(id\)/);
  assert.doesNotMatch(migration, /\b(?:role|status)\s+text\b/);
  assert.doesNotMatch(migration, /(?:ALTER|DROP|INSERT INTO|UPDATE|DELETE FROM)\s+(?:TABLE\s+)?(?:asset|realtime_outbox)/i);
});

test("scrypt records are salted, versioned, and verified without retaining plaintext", async () => {
  const password = "fixture-password-1";
  const first = await createPasswordRecord(password);
  const second = await createPasswordRecord(password);
  assert.match(first, /^scrypt\$v1\$16384\$8\$1\$/);
  assert.notEqual(first, second);
  assert.doesNotMatch(first, /fixture-password/);
  assert.equal(await verifyPasswordRecord(password, first), true);
  assert.equal(await verifyPasswordRecord("different-password", first), false);
  assert.equal(await verifyPasswordRecord(password, `${first}tampered`), false);
});

test("registration creates one pending viewer profile and stores only a password record and session digest", async () => {
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const profile = { id: "11111111-1111-4111-8111-111111111111", email: "user@example.test", full_name: "Test User",
    role: "viewer", status: "pending", created_at: new Date("2026-09-28T00:00:00Z"), approved_at: null, approved_by: null };
  const database: PostgresTransactionalQuery = {
    async rows() { throw new Error("outside transaction"); },
    async transaction(_signal, action) {
      const query: PostgresQuery = { async rows(sql, values) {
        calls.push({ sql, values });
        return sql.includes("RETURNING id,email") ? [profile] : [];
      } };
      return action(query);
    },
  };
  const result = await new PostgresLocalAuthRepository(database).register(
    "USER@example.test", "fixture-password-1", "Test User", new AbortController().signal,
  );
  assert.equal(result.profile.status, "pending");
  assert.equal(result.profile.role, "viewer");
  assert.match(result.token, /^[A-Za-z0-9_-]{43}$/);
  const credential = calls.find(({ sql }) => sql.includes("INSERT INTO public.local_auth_credentials"));
  const session = calls.find(({ sql }) => sql.includes("INSERT INTO public.local_auth_sessions"));
  assert.ok(credential && session);
  assert.match(String(credential.values[2]), /^scrypt\$v1\$/);
  assert.doesNotMatch(String(credential.values[2]), /fixture-password/);
  assert.ok(Buffer.isBuffer(session.values[0]));
  assert.notEqual(String(session.values[0]), result.token);
});

test("registration refuses to claim an existing profile by email", async () => {
  const database: PostgresTransactionalQuery = {
    async rows() { throw new Error("outside transaction"); },
    async transaction(_signal, action) {
      return action({ async rows(sql) {
        return sql.includes("FROM public.profiles WHERE lower(email)") ? [{ id: "existing" }] : [];
      } });
    },
  };
  await assert.rejects(
    new PostgresLocalAuthRepository(database).register("admin@example.test", "fixture-password-1", "Admin User",
      new AbortController().signal),
    (error: unknown) => error instanceof LocalAuthError && error.code === "ACCOUNT_ENROLLMENT_REQUIRED",
  );
});

test("login verifies the scrypt record and creates a fresh opaque session", async () => {
  const passwordRecord = await createPasswordRecord("fixture-password-1");
  let transactions = 0;
  const profile = { id: "11111111-1111-4111-8111-111111111111", email: "user@example.test", full_name: null,
    role: "viewer", status: "pending", created_at: new Date("2026-09-28T00:00:00Z"), approved_at: null, approved_by: null,
    password_record: passwordRecord };
  const database: PostgresTransactionalQuery = {
    async rows() { return [profile]; },
    async transaction(_signal, action) {
      transactions += 1;
      return action({ async rows() { return []; } });
    },
  };
  const repository = new PostgresLocalAuthRepository(database);
  await assert.rejects(repository.login("user@example.test", "wrong-password", new AbortController().signal),
    (error: unknown) => error instanceof LocalAuthError && error.code === "INVALID_CREDENTIALS");
  assert.equal(transactions, 0);
  const session = await repository.login("user@example.test", "fixture-password-1", new AbortController().signal);
  assert.match(session.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(session.profile.status, "pending");
  assert.equal(transactions, 1);
});

test("session resolution is expiry-gated and logout deletes only the token digest", async () => {
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const profile = { id: "11111111-1111-4111-8111-111111111111", email: "user@example.test", full_name: null,
    role: "operator", status: "approved", created_at: new Date("2026-09-28T00:00:00Z"), approved_at: null, approved_by: null };
  const database: PostgresTransactionalQuery = {
    async rows(sql, values) { calls.push({ sql, values }); return sql.includes("JOIN public.profiles") ? [profile] : []; },
    async transaction() { throw new Error("unused"); },
  };
  const repository = new PostgresLocalAuthRepository(database);
  const token = "A".repeat(43);
  assert.equal((await repository.resolve(token, new AbortController().signal)).status, "approved");
  await repository.logout(token, new AbortController().signal);
  assert.match(calls[0]!.sql, /s\.expires_at > now\(\)/);
  assert.match(calls[1]!.sql, /DELETE FROM public\.local_auth_sessions WHERE token_digest=\$1/);
  assert.ok(Buffer.isBuffer(calls[0]!.values[0]) && Buffer.isBuffer(calls[1]!.values[0]));
  assert.deepEqual(calls[0]!.values[0], calls[1]!.values[0]);
  assert.notEqual(String(calls[0]!.values[0]), token);
});

test("local auth routes require the server-only frontend bearer before repository work", async () => {
  let queries = 0;
  const database: PostgresTransactionalQuery = {
    async rows() { queries += 1; return []; },
    async transaction(_signal, action) { return action(this); },
  };
  const server = buildServer({ logger: false, localAuth: {
    token: "frontend-server-token-for-local-auth-tests",
    repository: new PostgresLocalAuthRepository(database),
  } });
  try {
    const unauthorized = await server.inject({ method: "POST", url: "/api/auth/login",
      payload: { email: "user@example.test", password: "fixture-password-1" } });
    assert.equal(unauthorized.statusCode, 401);
    const malformed = await server.inject({ method: "POST", url: "/api/auth/login",
      headers: { authorization: "Bearer frontend-server-token-for-local-auth-tests" },
      payload: { email: "user@example.test", password: "fixture-password-1", role: "admin" } });
    assert.equal(malformed.statusCode, 400);
    assert.equal(queries, 0);
  } finally {
    await server.close();
  }
});

test("operator enrollment arguments require exact UUID and email with a separate rotate flag", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  assert.deepEqual(parseEnrollmentArguments(["--profile-id", id, "--email", "Admin@Example.test"]),
    { profileId: id, email: "admin@example.test", rotate: false });
  assert.deepEqual(parseEnrollmentArguments(["--rotate", "--profile-id", id, "--email", "admin@example.test"]),
    { profileId: id, email: "admin@example.test", rotate: true });
  assert.throws(() => parseEnrollmentArguments(["--email", "admin@example.test"]));
  assert.throws(() => parseEnrollmentArguments(["--profile-id", "not-a-uuid", "--email", "admin@example.test"]));
  assert.throws(() => parseEnrollmentArguments(["--profile-id", id, "--email", "admin@example.test", "--password", "secret"]));
});

test("operator enrollment rejects a missing profile before credential mutation", async () => {
  const sql: string[] = [];
  const repository = new PostgresLocalAuthRepository(transactionalDatabase(async (statement) => {
    sql.push(statement);
    return [];
  }));
  await assert.rejects(repository.enrollExistingCredential(
    "11111111-1111-4111-8111-111111111111", "admin@example.test", "fixture-password-1", false,
    new AbortController().signal,
  ), (error: unknown) => error instanceof LocalAuthError && error.code === "PROFILE_NOT_FOUND");
  assert.equal(sql.length, 1);
  assert.match(sql[0]!, /^SELECT id,email FROM public\.profiles/);
});

test("operator enrollment rejects an expected-email mismatch without credential mutation", async () => {
  const sql: string[] = [];
  const repository = new PostgresLocalAuthRepository(transactionalDatabase(async (statement) => {
    sql.push(statement);
    return statement.includes("FROM public.profiles")
      ? [{ id: "11111111-1111-4111-8111-111111111111", email: "different@example.test" }]
      : [];
  }));
  await assert.rejects(repository.enrollExistingCredential(
    "11111111-1111-4111-8111-111111111111", "admin@example.test", "fixture-password-1", false,
    new AbortController().signal,
  ), (error: unknown) => error instanceof LocalAuthError && error.code === "PROFILE_EMAIL_MISMATCH");
  assert.equal(sql.length, 1);
  assert.doesNotMatch(sql.join("\n"), /(?:INSERT|UPDATE) public\.local_auth_credentials/);
});

test("operator enrollment creates only a credential for the exact existing profile", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const repository = new PostgresLocalAuthRepository(transactionalDatabase(async (sql, values) => {
    calls.push({ sql, values });
    return sql.includes("FROM public.profiles") ? [{ id, email: "admin@example.test" }] : [];
  }));
  assert.equal(await repository.enrollExistingCredential(id, "admin@example.test", "fixture-password-1", false,
    new AbortController().signal), "created");
  assert.equal(calls.length, 3);
  assert.match(calls[0]!.sql, /^SELECT id,email FROM public\.profiles .* FOR UPDATE$/);
  assert.match(calls[1]!.sql, /^\s*SELECT user_id,email FROM public\.local_auth_credentials[\s\S]*FOR UPDATE\s*$/);
  const mutations = calls.filter(({ sql }) => /^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(sql));
  assert.equal(mutations.length, 1);
  assert.match(mutations[0]!.sql, /INSERT INTO public\.local_auth_credentials/);
  assert.doesNotMatch(mutations[0]!.sql,
    /public\.profiles|public\.local_auth_sessions|\brole\b|\bstatus\b|approved_/i);
  assert.equal(mutations[0]!.values[0], id);
  assert.equal(mutations[0]!.values[1], "admin@example.test");
  assert.match(String(mutations[0]!.values[2]), /^scrypt\$v1\$/);
  assert.doesNotMatch(String(mutations[0]!.values[2]), /fixture-password/);
});

test("existing credential requires rotate and rotation changes only the credential record", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const repository = new PostgresLocalAuthRepository(transactionalDatabase(async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes("FROM public.profiles")) return [{ id, email: "admin@example.test", role: "admin", status: "approved" }];
    if (sql.includes("SELECT user_id,email FROM public.local_auth_credentials")) return [{ user_id: id, email: "admin@example.test" }];
    return [];
  }));
  await assert.rejects(repository.enrollExistingCredential(id, "admin@example.test", "fixture-password-1", false,
    new AbortController().signal),
  (error: unknown) => error instanceof LocalAuthError && error.code === "CREDENTIAL_EXISTS");
  assert.equal(calls.filter(({ sql }) => /UPDATE public\.local_auth_credentials/.test(sql)).length, 0);
  calls.length = 0;
  assert.equal(await repository.enrollExistingCredential(id, "admin@example.test", "fixture-password-2", true,
    new AbortController().signal), "rotated");
  assert.equal(calls.length, 3);
  assert.match(calls[0]!.sql, /^SELECT id,email FROM public\.profiles .* FOR UPDATE$/);
  assert.match(calls[1]!.sql, /^\s*SELECT user_id,email FROM public\.local_auth_credentials[\s\S]*FOR UPDATE\s*$/);
  const mutations = calls.filter(({ sql }) => /^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(sql));
  assert.equal(mutations.length, 1);
  assert.match(mutations[0]!.sql, /UPDATE public\.local_auth_credentials/);
  assert.doesNotMatch(mutations[0]!.sql,
    /public\.profiles|public\.local_auth_sessions|\brole\b|\bstatus\b|approved_/i);
  assert.match(String(mutations[0]!.values[2]), /^scrypt\$v1\$/);
  assert.doesNotMatch(String(mutations[0]!.values[2]), /fixture-password/);
});

test("operator CLI accepts password only through a hidden interactive TTY and logs no secret material", () => {
  assert.match(enrollmentScript, /process\.stdin\.isTTY/);
  assert.match(enrollmentScript, /process\.stdout\.isTTY/);
  assert.match(enrollmentScript, /process\.stdin\.setRawMode\(true\)/);
  assert.match(enrollmentScript, /process\.stdin\.setRawMode\(false\)/);
  assert.doesNotMatch(enrollmentScript, /--password|password_record|console\.(?:log|error)/);
  assert.match(authRepository, /createPasswordRecord\(password\)/);
  assert.doesNotMatch(authRepository, /UPDATE public\.profiles/);
});

function transactionalDatabase(rows: PostgresQuery["rows"]): PostgresTransactionalQuery {
  return {
    async rows() { throw new Error("outside transaction"); },
    async transaction(_signal, action) { return action({ rows }); },
  };
}
