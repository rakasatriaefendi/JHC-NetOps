import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildServer } from "../src/server.js";
import { RunnerWorkService, WorkWaitLimit, type WorkClock } from "../src/runner-work/service.js";
import { PostgresRunnerWorkRepository, RunnerNotRegistered, type RunnerWorkRepository } from "../src/runner-work/repository.js";
import { workRunner, type WorkKind } from "../src/runner-work/contract.js";
import type { PostgresQuery, PostgresTransactionalQuery } from "../src/persistence/postgres-query.js";

const TOKEN = "runner-work-test-token-not-a-secret";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const flush = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); await new Promise<void>((resolve) => setImmediate(resolve)); };
class Clock implements WorkClock {
  time = 0;
  next = 0;
  tasks = new Map<number, { at: number; fn: () => void }>();
  now = () => this.time;
  setTimeout = (fn: () => void, ms: number) => { const id = ++this.next; this.tasks.set(id, { at: this.time + ms, fn }); return id; };
  clearTimeout = (id: unknown) => { if (typeof id === "number") this.tasks.delete(id); };
  async advance(ms: number) {
    const end = this.time + ms;
    for (;;) {
      const next = [...this.tasks].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      this.time = next[1].at; this.tasks.delete(next[0]); next[1].fn(); await flush();
    }
    this.time = end; await flush();
  }
}
class Repository implements RunnerWorkRepository {
  queues = new Map<string, readonly WorkKind[]>();
  checks: string[] = [];
  recoveries = 0;
  private checked!: () => void;
  readonly firstCheck = new Promise<void>((resolve) => { this.checked = resolve; });
  async available(id: string, signal: AbortSignal) {
    signal.throwIfAborted(); this.checks.push(id); this.checked();
    return this.queues.get(id) ?? [];
  }
  async recover(signal: AbortSignal) { signal.throwIfAborted(); this.recoveries += 1; }
}

test("work contract accepts exactly one bounded runner id", () => {
  assert.equal(workRunner({ runner_id: "it-lt8" }), "it-lt8");
  assert.equal(workRunner({ runner_id: "it-lt8", wait_seconds: 60 }), "it-lt8");
  for (const input of [null, [], {}, { runner_id: "../other" }, { runner_id: "a".repeat(65) },
    { runner_id: "it-lt8", token: "extra" }, { runner_id: "it-lt8", wait_seconds: 59 },
    { runner_id: "it-lt8", wait_seconds: 120 }, { runner_id: "it-lt8", wait_seconds: "60" }]) assert.equal(workRunner(input), null);
});

test("quiet HTTP wait stays open for 60s, rechecks queues every 10s and repeats without claims", async () => {
  const clock = new Clock(); const repository = new Repository(); const service = new RunnerWorkService(repository, clock);
  const server = buildServer({ logger: false, runnerWork: { token: TOKEN, service } });
  let requests = 0;
  server.addHook("onRequest", async () => { requests += 1; });
  try {
    await server.ready();
    const check = repository.available.bind(repository);
    for (let minute = 0; minute < 3; minute += 1) {
      const expectedChecks = repository.checks.length;
      let entered!: () => void;
      const registered = new Promise<void>((resolve) => { entered = resolve; });
      repository.available = async (id, signal) => { const result = await check(id, signal); entered(); return result; };
      const response = server.inject({ method: "POST", url: "/api/runner/work/wait", headers: AUTH,
        payload: { runner_id: "it-lt8", wait_seconds: 60 } }).then((value) => value);
      // Wait for the actual repository call, not elapsed wall-clock time.
      await registered; await flush();
      assert.equal(service.waiterCount, 1);
      await clock.advance(59_999); assert.equal(service.waiterCount, 1);
      await clock.advance(1);
      const result = await response;
      assert.equal(result.statusCode, 200); assert.equal(result.json().data.timed_out, true);
      assert.equal(repository.checks.length - expectedChecks, 7);
    }
    assert.equal(requests, 3); assert.equal(repository.recoveries, 19);
  } finally { await server.close(); }
});

test("quiet wait detects a lost Ping hint within 10s, before the 30s lease", async () => {
  const clock = new Clock(); const repository = new Repository(); const service = new RunnerWorkService(repository, clock);
  const waiting = service.wait("a", new AbortController().signal, 60_000); await repository.firstCheck; await flush();
  await clock.advance(1_000); repository.queues.set("a", ["manual_ping"]);
  await clock.advance(9_000);
  assert.deepEqual((await waiting).available, ["manual_ping"]);
  assert.equal(clock.time, 10_000); await service.stop();
});

test("all interactive work kinds wake quiet waits promptly after a committed hint", async () => {
  for (const kind of ["manual_ping", "traffic", "discovery", "device_inspector"] as const) {
    const clock = new Clock(); const repository = new Repository(); const service = new RunnerWorkService(repository, clock);
    const waiting = service.wait("a", new AbortController().signal, 60_000); await repository.firstCheck; await flush();
    await clock.advance(1_000);
    repository.queues.set("a", [kind]); service.wake("a"); await flush();
    assert.deepEqual((await waiting).available, [kind]); assert.equal(clock.time, 1_000);
    await service.stop();
  }
});

test("quiet wait still releases promptly on cancellation and restart sees durable work", async () => {
  const repository = new Repository(); const service = new RunnerWorkService(repository);
  const cancel = new AbortController(); const waiting = service.wait("a", cancel.signal, 60_000);
  const rejected = assert.rejects(waiting); await repository.firstCheck;
  cancel.abort(); await rejected; assert.equal(service.waiterCount, 0); await service.stop();
  repository.queues.set("a", ["discovery"]);
  const restarted = new RunnerWorkService(repository);
  assert.deepEqual((await restarted.wait("a", new AbortController().signal, 60_000)).available, ["discovery"]);
  await restarted.stop();
});

test("Traffic, Discovery prepare/start and Inspector routes wake quiet waits only after commit", async () => {
  const paths = [
    { method: "POST", url: "/api/application/traffic-live-sessions", kind: "traffic" },
    { method: "POST", url: "/api/application/network-discovery", kind: "discovery" },
    { method: "PATCH", url: "/api/application/network-discovery/:runnerId", kind: "discovery" },
    { method: "POST", url: "/api/application/device-inspection", kind: "device_inspector" },
  ] as const;
  for (const path of paths) {
    const clock = new Clock(); const repository = new Repository(); const service = new RunnerWorkService(repository, clock);
    const server = buildServer({ logger: false, runnerWork: { token: TOKEN, service } });
    let commit!: () => void;
    const committed = new Promise<void>((resolve) => { commit = resolve; });
    server.route({ method: path.method, url: path.url, handler: async (_request, reply) => {
      await committed; repository.queues.set("it-lt8", [path.kind]); return reply.code(200).send({ data: {} });
    } });
    try {
      await server.ready();
      const waiting = server.inject({ method: "POST", url: "/api/runner/work/wait", headers: AUTH,
        payload: { runner_id: "it-lt8", wait_seconds: 60 } }).then((response) => response);
      await repository.firstCheck; await flush();
      const enqueue = server.inject({ method: path.method, url: path.url.replace(":runnerId", "it-lt8"),
        payload: { input: { runner_id: "it-lt8" } } }).then((response) => response);
      await flush(); assert.equal(repository.checks.length, 1);
      commit(); await enqueue; await clock.advance(100);
      assert.deepEqual((await waiting).json().data.available, [path.kind]);
    } finally { await server.close(); }
  }
});

test("actual work route requires bearer auth, exact body, and registered identity", async () => {
  const repository = new Repository();
  repository.available = async () => { throw new RunnerNotRegistered(); };
  const service = new RunnerWorkService(repository);
  const server = buildServer({ logger: false, runnerWork: { token: TOKEN, service } });
  try {
    assert.equal((await server.inject({ method: "POST", url: "/api/runner/work/wait", payload: { runner_id: "it-lt8" } })).statusCode, 401);
    assert.equal((await server.inject({ method: "POST", url: "/api/runner/work/wait", headers: AUTH,
      payload: { runner_id: "it-lt8", arbitrary: true } })).statusCode, 400);
    assert.equal((await server.inject({ method: "POST", url: "/api/runner/work/wait", headers: AUTH,
      payload: { runner_id: "it-lt8" } })).statusCode, 403);
    assert.equal((await server.inject({ method: "POST", url: "/api/runner/work/wait", headers: AUTH,
      payload: { runner_id: "x".repeat(300) } })).statusCode, 413);
    assert.equal(service.waiterCount, 0);
  } finally { await server.close(); }
});

test("actual route waits 10s and returns empty timeout without claiming anything", async () => {
  const clock = new Clock(); const repository = new Repository();
  const service = new RunnerWorkService(repository, clock);
  const server = buildServer({ logger: false, runnerWork: { token: TOKEN, service } });
  try {
    await server.ready();
    let finished = false;
    const response = server.inject({ method: "POST", url: "/api/runner/work/wait", headers: AUTH,
      payload: { runner_id: "it-lt8" } }).then((value) => { finished = true; return value; });
    await Promise.race([repository.firstCheck, response.then((result) => {
      assert.ok(repository.checks.length > 0, `wait ended before registration: HTTP ${result.statusCode}`);
    })]);
    await flush(); assert.equal(service.waiterCount, 1);
    await clock.advance(9_999); assert.equal(finished, false);
    await clock.advance(1);
    const result = await response;
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.json().data, { runner_id: "it-lt8", available: [], timed_out: true });
    assert.deepEqual(repository.checks, ["it-lt8", "it-lt8"]);
    assert.equal(service.waiterCount, 0);
  } finally { await server.close(); }
});

test("real HTTP wait overrides only its socket timeout and releases capacity on client disconnect", async () => {
  const repository = new Repository(); const service = new RunnerWorkService(repository);
  const server = buildServer({ logger: false, runnerWork: { token: TOKEN, service } });
  let entered!: () => void;
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  server.addHook("preHandler", async (request, reply) => {
    if (request.routeOptions.url === "/api/runner/work/wait") {
      const socket = reply.raw.socket;
      repository.available = async () => { assert.equal(socket?.timeout, 0); entered(); return []; };
    }
  });
  const cancel = new AbortController();
  try {
    await server.listen({ host: "127.0.0.1", port: 0 });
    const address = server.server.address(); assert.ok(address && typeof address !== "string");
    assert.equal(server.server.timeout, 5_000);
    const rejected = assert.rejects(fetch(`http://127.0.0.1:${address.port}/api/runner/work/wait`, {
      method: "POST", headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ runner_id: "it-lt8" }), signal: cancel.signal,
    }));
    await reading; assert.equal(service.waiterCount, 1);
    cancel.abort(); await rejected;
    for (let i = 0; i < 100 && service.waiterCount; i += 1) await flush();
    assert.equal(service.waiterCount, 0); assert.equal(server.server.timeout, 5_000);
  } finally { cancel.abort(); await server.close(); }
});

test("backend shutdown ends pending actual-route waits with bounded unavailable response", async () => {
  const clock = new Clock(); const repository = new Repository(); const service = new RunnerWorkService(repository, clock);
  const server = buildServer({ logger: false, runnerWork: { token: TOKEN, service } });
  await server.ready();
  const waiting = server.inject({ method: "POST", url: "/api/runner/work/wait", headers: AUTH,
    payload: { runner_id: "it-lt8" } }).then((response) => response);
  await Promise.race([repository.firstCheck, waiting.then((result) => {
    assert.ok(repository.checks.length > 0, `wait ended before registration: HTTP ${result.statusCode}`);
  })]);
  await flush(); assert.equal(service.waiterCount, 1);
  await server.close();
  assert.equal((await waiting).statusCode, 503); assert.equal(service.waiterCount, 0);
});

test("successful committed enqueue wakes an actual waiting route; failed enqueue does not", async () => {
  const clock = new Clock(); const repository = new Repository(); const service = new RunnerWorkService(repository, clock);
  const server = buildServer({ logger: false, runnerWork: { token: TOKEN, service } });
  let commit!: () => void;
  const committed = new Promise<void>((resolve) => { commit = resolve; });
  let fail = true;
  server.post("/api/application/ping-jobs", async (_request, reply) => {
    if (fail) return reply.code(409).send({ error: { code: "RUNNER_BUSY" } });
    await committed; repository.queues.set("it-lt8", ["manual_ping"]);
    return reply.code(201).send({ data: {} });
  });
  try {
    await server.ready();
    let finished = false;
    const waiting = server.inject({ method: "POST", url: "/api/runner/work/wait", headers: AUTH,
      payload: { runner_id: "it-lt8" } }).then((value) => { finished = true; return value; });
    await Promise.race([repository.firstCheck, waiting.then((result) => {
      assert.ok(repository.checks.length > 0, `wait ended before registration: HTTP ${result.statusCode}`);
    })]);
    await flush();
    await server.inject({ method: "POST", url: "/api/application/ping-jobs" });
    assert.equal(finished, false); assert.equal(repository.checks.length, 1);
    fail = false;
    const enqueue = server.inject({ method: "POST", url: "/api/application/ping-jobs" }).then((value) => value);
    await flush(); assert.equal(finished, false); assert.equal(repository.checks.length, 1);
    commit(); await enqueue; await flush(); await clock.advance(100);
    assert.deepEqual((await waiting).json().data.available, ["manual_ping"]);
  } finally { await server.close(); }
});

test("durable queue covers lost pre-subscription hints and backend restart", async () => {
  const repository = new Repository(); repository.queues.set("a", ["traffic"]);
  for (let restart = 0; restart < 2; restart += 1) {
    const service = new RunnerWorkService(repository); service.wake();
    assert.deepEqual((await service.wait("a", new AbortController().signal)).available, ["traffic"]);
    await service.stop();
  }
});

test("enqueue during initial durable check cannot be missed", async () => {
  const clock = new Clock(); const repository = new Repository(); const service = new RunnerWorkService(repository, clock);
  let finish!: () => void;
  const checked = new Promise<void>((resolve) => { finish = resolve; });
  let first = true;
  repository.available = async () => {
    if (first) { first = false; await checked; return []; }
    return ["discovery"];
  };
  const waiting = service.wait("a", new AbortController().signal);
  service.wake(); finish(); await flush(); await clock.advance(100);
  assert.deepEqual((await waiting).available, ["discovery"]);
  await service.stop();
});

test("separate runners, per-runner/global limits, cancellation and shutdown clean all waiters", async () => {
  const clock = new Clock(); const repository = new Repository(); const service = new RunnerWorkService(repository, clock, 10_000, 2);
  const cancel = new AbortController();
  const a = service.wait("a", cancel.signal); const aRejected = assert.rejects(a);
  const b = service.wait("b", new AbortController().signal);
  await assert.rejects(service.wait("a", new AbortController().signal), WorkWaitLimit);
  await assert.rejects(service.wait("c", new AbortController().signal), WorkWaitLimit);
  await flush(); repository.queues.set("b", ["device_inspector"]); service.wake(); await clock.advance(100);
  assert.deepEqual((await b).available, ["device_inspector"]);
  assert.equal(service.waiterCount, 1);
  cancel.abort(); await aRejected; assert.equal(service.waiterCount, 0);
  const c = service.wait("c", new AbortController().signal); const cRejected = assert.rejects(c);
  await service.stop(); await cRejected;
  assert.equal(service.waiterCount, 0); assert.equal(clock.tasks.size, 0);
});

test("runner-specific hints do not wake unrelated runner waits", async () => {
  const clock = new Clock(); const repository = new Repository(); const service = new RunnerWorkService(repository, clock);
  const cancel = new AbortController(); const a = service.wait("a", cancel.signal); const rejected = assert.rejects(a);
  const b = service.wait("b", new AbortController().signal); await flush();
  repository.queues.set("b", ["traffic"]); service.wake("b"); await clock.advance(100);
  assert.deepEqual((await b).available, ["traffic"]);
  assert.equal(repository.checks.filter((id) => id === "a").length, 1);
  cancel.abort(); await rejected; await service.stop();
});

test("missed wakeup during wait is recovered by final durable check, not empty claims", async () => {
  const clock = new Clock(); const repository = new Repository(); const service = new RunnerWorkService(repository, clock);
  const waiting = service.wait("a", new AbortController().signal); await flush();
  repository.queues.set("a", ["traffic"]); // no wake (e.g. another backend instance)
  await clock.advance(10_000);
  const result = await waiting; assert.equal(result.timed_out, false); assert.deepEqual(result.available, ["traffic"]);
  await service.stop();
});

test("wake bursts are coalesced and query failures release capacity", async () => {
  const clock = new Clock(); const repository = new Repository(); const service = new RunnerWorkService(repository, clock);
  const cancel = new AbortController(); const waiting = service.wait("a", cancel.signal); const rejected = assert.rejects(waiting);
  await flush();
  for (let i = 0; i < 100; i += 1) service.wake();
  await flush(); await clock.advance(100);
  assert.equal(repository.checks.length, 2);
  cancel.abort(); await rejected;
  repository.available = async () => { throw new Error("private database details"); };
  await assert.rejects(service.wait("a", new AbortController().signal));
  assert.equal(service.waiterCount, 0); await service.stop();
});

test("client cancellation releases a waiter even if database transport has not settled", async () => {
  const repository = new Repository();
  repository.available = async () => new Promise<readonly WorkKind[]>(() => {});
  const service = new RunnerWorkService(repository);
  const cancel = new AbortController();
  const waiting = service.wait("a", cancel.signal); const rejected = assert.rejects(waiting);
  cancel.abort(); await rejected;
  assert.equal(service.waiterCount, 0); await service.stop();
});

test("recovery runs on startup and every 10s without any runner, is single-flight and stops cleanly", async () => {
  const clock = new Clock(); const repository = new Repository(); const service = new RunnerWorkService(repository, clock);
  service.start(() => assert.fail("unexpected maintenance failure"));
  await flush(); assert.equal(repository.recoveries, 1);
  await clock.advance(30_000); assert.equal(repository.recoveries, 4);
  assert.equal(service.waiterCount, 0); assert.equal(clock.tasks.size, 1);
  await service.stop(); assert.equal(clock.tasks.size, 0);
});

test("recovery failure retries only on bounded maintenance cadence", async () => {
  const clock = new Clock(); const repository = new Repository(); let failures = 0;
  repository.recover = async () => { repository.recoveries += 1; throw new Error("private"); };
  const service = new RunnerWorkService(repository, clock);
  service.start(() => { failures += 1; }); await flush();
  await clock.advance(9_999); assert.equal(failures, 1);
  await clock.advance(1); assert.equal(failures, 2);
  await service.stop();
});

test("slow recovery cannot overlap and shutdown waits for its cancelled transaction cleanup", async () => {
  const clock = new Clock(); const repository = new Repository();
  let finish!: () => void;
  const cleanup = new Promise<void>((resolve) => { finish = resolve; });
  const signals: AbortSignal[] = [];
  repository.recover = async (signal) => {
    repository.recoveries += 1; signals.push(signal);
    await cleanup;
  };
  const service = new RunnerWorkService(repository, clock);
  service.start(() => assert.fail("unexpected failure"));
  await clock.advance(30_000);
  assert.equal(repository.recoveries, 1); assert.equal(clock.tasks.size, 0);
  const stopped = service.stop(); assert.equal(signals[0]?.aborted, true);
  finish(); await stopped; assert.equal(clock.tasks.size, 0);
});

class Database implements PostgresTransactionalQuery {
  transactions = 0;
  openTransactions = 0;
  work = { manual_ping: true, traffic: true, discovery: true, device_inspector: true };
  calls: { sql: string; values: readonly unknown[] }[] = [];
  async transaction<T>(signal: AbortSignal, action: (query: PostgresQuery) => Promise<T>): Promise<T> {
    signal.throwIfAborted(); this.transactions += 1; this.openTransactions += 1;
    try { return await action(this); } finally { this.openTransactions -= 1; }
  }
  async rows(sql: string, values: readonly unknown[]) {
    this.calls.push({ sql, values });
    if (sql.includes("FROM public.diagnostic_runners r")) return [this.work];
    return [];
  }
}
test("repository checks exact runner, ordered work kinds and bounded lease recovery without claiming", async () => {
  const database = new Database(); const repository = new PostgresRunnerWorkRepository(database);
  const signal = new AbortController().signal;
  assert.deepEqual(await repository.available("a", signal), ["manual_ping", "traffic", "discovery", "device_inspector"]);
  const read = database.calls.find((call) => call.sql.includes("FROM public.diagnostic_runners r"));
  assert.ok(read); assert.deepEqual(read.values, ["a"]);
  assert.match(read.sql, /WHERE r\.id=\$1/);
  assert.doesNotMatch(read.sql, /UPDATE|FOR UPDATE|INSERT|DELETE/);
  await repository.recover(signal);
  const recovery = database.calls.find((call) => call.sql.includes("WITH ping AS")); assert.ok(recovery);
  assert.equal([...recovery.sql.matchAll(/LIMIT 100 FOR UPDATE SKIP LOCKED/g)].length, 4);
  for (const table of ["network_health_ping_jobs", "traffic_live_sessions", "network_discovery_sessions", "device_inspection_sessions"]) {
    assert.match(recovery.sql, new RegExp(`UPDATE public\\.${table}`));
  }
  assert.match(recovery.sql, /status IN \('queued','running'\) AND expires_at < now\(\)/);
  assert.match(recovery.sql, /interval '10 minutes'/);
  assert.match(recovery.sql, /interval '30 seconds'/);
  assert.match(recovery.sql, /interval '45 seconds'/);
  assert.match(recovery.sql, /MANUAL_PING_TARGET_UNAVAILABLE/);
  assert.match(recovery.sql, /SESSION_ORPHANED/);
  assert.equal(database.transactions, 2);
  assert.equal(database.calls.filter((call) => call.sql.includes("set_config('statement_timeout','3000',true)")).length, 2);
});

test("work wait holds no repository transaction between durable queue checks", async () => {
  const clock = new Clock(); const database = new Database();
  database.work = { manual_ping: false, traffic: false, discovery: false, device_inspector: false };
  const service = new RunnerWorkService(new PostgresRunnerWorkRepository(database), clock);
  const cancel = new AbortController(); const waiting = service.wait("a", cancel.signal); const rejected = assert.rejects(waiting);
  await flush(); assert.equal(database.openTransactions, 0); assert.equal(database.transactions, 1);
  await clock.advance(9_999); assert.equal(database.openTransactions, 0);
  cancel.abort(); await rejected; await service.stop();
});

test("heartbeat assignment query is enabled-only, runner-scoped and contains no credential material", async () => {
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const database: PostgresTransactionalQuery = {
    async rows(sql, values) {
      calls.push({ sql, values });
      return sql.includes("AS health") ? [{ health: false, telemetry: true }] : [];
    },
    async transaction<T>(_signal: AbortSignal, action: (query: PostgresQuery) => Promise<T>) {
      _signal.throwIfAborted(); return action(database);
    },
  };
  const result = await new PostgresRunnerWorkRepository(database).assignments("it-lt8", new AbortController().signal);
  assert.deepEqual(result, { health: false, telemetry: true });
  const query = calls.find((call) => call.sql.includes("AS health")); assert.ok(query);
  assert.deepEqual(query.values, ["it-lt8"]);
  assert.equal([...query.sql.matchAll(/runner_id=\$1 AND enabled=true/g)].length, 2);
  assert.doesNotMatch(query.sql, /UPDATE|INSERT|DELETE|credential|password|community/i);
});

test("D2A source and read-only candidate protections remain present", () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  assert.match(source("../src/main.ts"), /!config\.candidateReadOnly \? \{ runnerWork:/);
  const traffic = source("../../frontend/components/traffic/traffic-live-page.tsx");
  assert.match(traffic, /startTrafficRefresh/); assert.match(traffic, /confirmMutation/);
  assert.doesNotMatch(traffic, /getTrafficRunnersAction|refreshRunners/);
});

test("read-only candidate cannot start work recovery even if work options are supplied", async () => {
  const repository = new Repository(); const service = new RunnerWorkService(repository);
  const server = buildServer({ logger: false, candidateReadOnly: true, runnerWork: { token: TOKEN, service } });
  try {
    await server.ready();
    assert.equal(repository.recoveries, 0);
    assert.equal((await server.inject({ method: "GET", url: "/healthz" })).statusCode, 200);
    assert.equal((await server.inject({ method: "POST", url: "/api/runner/work/wait", headers: AUTH,
      payload: { runner_id: "it-lt8" } })).statusCode, 503);
    assert.equal(repository.checks.length, 0);
  } finally { await service.stop(); await server.close(); }
});
