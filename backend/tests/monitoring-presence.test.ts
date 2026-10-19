import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildServer } from "../src/server.js";
import { MonitoringRuntime } from "../src/runner-control/runtime.js";
import { PostgresLocalAuthRepository } from "../src/local-auth/repository.js";
import type { PostgresTransactionalQuery } from "../src/persistence/postgres-query.js";

test("presence requires frontend bearer AND approved unexpired session, releases on disconnect/revocation", async () => {
  const runtime = new MonitoringRuntime(0);
  runtime.connection(1); runtime.evidence(false, true, false);
  let valid = true;
  const token = "p".repeat(43);
  const server = buildServer({ logger: false, presence: { token: "frontend-test", runtime, checkMs: 10,
    session: async (value) => {
      if (!valid || ![token, "q".repeat(43)].includes(value)) throw new Error("Session invalid");
      return { expires_at: new Date(Date.now() + 60_000).toISOString() };
    } } });
  const origin = await server.listen({ host: "127.0.0.1", port: 0 });
  const headers = { authorization: "Bearer frontend-test", "x-netops-session": token };
  try {
    assert.equal((await fetch(origin + "/api/application/presence")).status, 401);
    assert.equal((await fetch(origin + "/api/application/presence", { headers: { authorization: headers.authorization } })).status, 401);
    const first = await fetch(origin + "/api/application/presence", { headers });
    const second = await fetch(origin + "/api/application/presence", { headers });
    const anotherUser = await fetch(origin + "/api/application/presence", { headers: { ...headers, "x-netops-session": "q".repeat(43) } });
    assert.equal(first.status, 200); assert.equal(runtime.snapshot().state, "ACTIVATING");
    runtime.evidence(false, true, false); // Simulate the runner's current-policy ready acknowledgement.
    assert.equal(runtime.snapshot().state, "ACTIVE");
    await first.body!.cancel();
    assert.equal(runtime.snapshot().monitoring, true, "another tab retains presence");
    await second.body!.cancel();
    assert.equal(runtime.snapshot().monitoring, true, "another approved user independently retains presence");
    valid = false; // logout/disable/expiry is checked server-side, not browser activity
    await anotherUser.text();
    assert.equal(runtime.snapshot().state, "DRAINING");
    runtime.evidence(false, false, false); // Paused worker confirms all buffers drained.
    assert.equal(runtime.snapshot().state, "STANDBY");
    assert.equal((await fetch(origin + "/api/application/presence", { headers })).status, 401);
  } finally { await server.close(); }
});

test("presence repository proves canonical approved profile and session expiry without writes", async () => {
  const statements: string[] = [];
  let exists = true;
  const query: PostgresTransactionalQuery = {
    rows: async (sql) => { statements.push(sql); return exists ? [{ expires_at: new Date(Date.now() + 60_000) }] : []; },
    transaction: async () => { throw new Error("Presence must be read-only"); },
  };
  const repository = new PostgresLocalAuthRepository(query);
  assert.ok((await repository.approvedPresence("p".repeat(43), new AbortController().signal)).expires_at);
  exists = false;
  await assert.rejects(repository.approvedPresence("p".repeat(43), new AbortController().signal));
  await assert.rejects(repository.approvedPresence("invalid", new AbortController().signal));
  for (const sql of statements) {
    assert.match(sql, /JOIN public\.profiles/); assert.match(sql, /p\.status='approved'/);
    assert.match(sql, /s\.expires_at > now\(\)/); assert.match(sql, /s\.token_digest=\$1/);
    assert.doesNotMatch(sql, /\b(?:UPDATE|INSERT|DELETE)\b/i);
  }
});

test("automatic scan audit: only explicit manual start, evidence synchronization has no background timer", () => {
  const read = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");
  const ingestion = read("../src/assets/ingestion.ts");
  assert.doesNotMatch(ingestion, /setInterval|setTimeout/);
  assert.match(read("../src/assets/scan-route.ts"), /controller\.start\(validated\.value/);
  assert.match(read("../src/main.ts"), /assetScanController\?\.hasActiveWork/);
});
