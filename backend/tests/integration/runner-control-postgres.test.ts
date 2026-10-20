import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { once } from "node:events";
import { WebSocket } from "ws";
import { buildServer } from "../../src/server.js";
import { MonitoringRuntime } from "../../src/runner-control/runtime.js";
import { RunnerWorkService } from "../../src/runner-work/service.js";
import { PostgresRunnerWorkRepository } from "../../src/runner-work/repository.js";
import { PostgresRunnerHeartbeatRepository } from "../../src/persistence/runner-heartbeat.js";
import { PostgresNetworkHealthPingJobsRepository } from "../../src/persistence/network-health-ping-jobs.js";
import { PostgresLocalAuthRepository } from "../../src/local-auth/repository.js";
import { PoolPostgresQuery } from "../../src/persistence/postgres-query.js";
import { createPasswordRecord } from "../../src/local-auth/password.js";
import type { WorkKind } from "../../src/runner-work/contract.js";

const PGHOST = process.env.PGHOST ?? "localhost";
const PGPORT = Number(process.env.PGPORT ?? 5432);
const PGDATABASE = process.env.PGDATABASE ?? "jhc_netops";
const PGUSER = process.env.PGUSER ?? "jhc_netops_app";
const PGPASSWORD = process.env.PGPASSWORD ?? "test_password";

const CONTROL_TOKEN = process.env.RUNNER_CONTROL_TOKEN ?? "test-control-token-not-a-real-credential";
const PRESENCE_TOKEN = process.env.PRESENCE_TOKEN ?? "test-presence-token-not-a-real-credential";

let RUNNER_ID = "";
let RUNNER = {
  id: "",
  display_name: "PG Integration Runner",
  health_status: "online",
  health_error_code: null,
  capabilities: {
    source_locations: [],
    targets: [],
    durations: [5],
    traffic_durations_seconds: [300],
    operations: ["bandwidth_and_path", "traffic_live", "network_discovery", "device_inspect", "manual_ping"],
    snmp_telemetry: { enabled: false }
  }
};

const pools = new Set<Pool>();
const servers = new Set<ReturnType<typeof buildServer>>();
const sockets = new Set<WebSocket>();
const inboxes = new WeakMap<WebSocket, Record<string, unknown>[]>();
const createdProfiles = new Set<string>();
const createdNodes = new Set<string>();
const createdRunners = new Set<string>();
const subnet = randomBytes(2);
let nextHost = 1;

test.beforeEach(() => {
  RUNNER_ID = `pg-integration-${randomUUID()}`;
  RUNNER = { ...RUNNER, id: RUNNER_ID };
});

test.afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  await Promise.allSettled([...servers].map((server) => server.close()));
  let cleanupError: unknown;
  if (createdRunners.size || createdProfiles.size || createdNodes.size) {
    const cleanup = new Pool({ host: PGHOST, port: PGPORT, database: PGDATABASE,
      user: PGUSER, password: PGPASSWORD, max: 1, connectionTimeoutMillis: 5_000,
      statement_timeout: 3_000, query_timeout: 5_000 });
    try {
      const runners = [...createdRunners];
      const profiles = [...createdProfiles];
      for (const table of ["network_health_ping_jobs", "traffic_live_sessions", "network_discovery_sessions", "device_inspection_sessions", "network_targets"]) {
        await cleanup.query(`DELETE FROM public.${table} WHERE runner_id = ANY($1::text[])`, [runners]);
      }
      await cleanup.query("DELETE FROM public.network_nodes WHERE id = ANY($1::uuid[])", [[...createdNodes]]);
      await cleanup.query("DELETE FROM public.diagnostic_runners WHERE id = ANY($1::text[])", [runners]);
      await cleanup.query("DELETE FROM public.profiles WHERE id = ANY($1::uuid[])", [profiles]);
    } catch (error) { cleanupError = error; }
    finally { await cleanup.end(); }
  }
  await Promise.allSettled([...pools].map((pool) => pool.end()));
  sockets.clear(); servers.clear(); pools.clear();
  createdProfiles.clear(); createdNodes.clear(); createdRunners.clear();
  if (cleanupError) throw cleanupError;
});

async function createTestPool(): Promise<Pool> {
  const pool = new Pool({
    host: PGHOST,
    port: PGPORT,
    database: PGDATABASE,
    user: PGUSER,
    password: PGPASSWORD,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
  });
  pools.add(pool);
  await pool.query("SELECT 1");
  return pool;
}

async function registerTestRunner(pool: Pool, runnerId = RUNNER_ID): Promise<void> {
  await pool.query(`
    INSERT INTO public.diagnostic_runners (id, display_name, capabilities, health_status, last_seen_at)
    VALUES ($1, $2, $3::jsonb, 'online', now())
    ON CONFLICT (id) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      capabilities = EXCLUDED.capabilities,
      health_status = EXCLUDED.health_status,
      last_seen_at = EXCLUDED.last_seen_at,
      updated_at = now()
  `, [runnerId, RUNNER.display_name, JSON.stringify(RUNNER.capabilities)]);
  createdRunners.add(runnerId);
}

async function createApprovedProfile(pool: Pool): Promise<{ id: string; sessionToken: string }> {
  const profileId = randomUUID();
  const email = `test-${profileId}@example.com`;
  await pool.query(`
    INSERT INTO public.profiles (id, email, full_name, role, status, approved_at)
    VALUES ($1, $2, $3, 'operator', 'approved', now())
  `, [profileId, email, "Test User"]);
  createdProfiles.add(profileId);
  const token = randomBytes(32).toString("base64url");
  const digest = createHash("sha256").update(token, "utf8").digest();
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  await pool.query(`
    INSERT INTO public.local_auth_credentials (user_id, email, password_record)
    VALUES ($1, $2, $3)
  `, [profileId, email, await createPasswordRecord("fixture-password-1")]);
  await pool.query(`
    INSERT INTO public.local_auth_sessions (token_digest, user_id, expires_at)
    VALUES ($1, $2::uuid, $3::timestamptz)
  `, [digest, profileId, expiresAt]);
  return { id: profileId, sessionToken: token };
}

async function createPingTarget(pool: Pool, actorId: string, runnerId = RUNNER_ID): Promise<string> {
  const nodeId = randomUUID();
  const targetId = randomUUID();
  const ip = `10.${subnet[0]!}.${subnet[1]!}.${nextHost++}`;
  await pool.query(`INSERT INTO public.network_nodes (id, ip_address, name, created_by)
    VALUES ($1::uuid, $2::inet, 'PG integration fixture', $3::uuid)`, [nodeId, ip, actorId]);
  createdNodes.add(nodeId);
  await pool.query(`INSERT INTO public.network_targets (id, node_id, runner_id, created_by)
    VALUES ($1::uuid, $2::uuid, $3, $4::uuid)`, [targetId, nodeId, runnerId, actorId]);
  return targetId;
}

function healthMessage(runner = RUNNER, ready = true, busy = false, policyRevision = 0) {
  return JSON.stringify({ type: "health", runner, ready, busy, policy_revision: policyRevision });
}

async function buildTestServer(pool: Pool, options: {
  runtime?: MonitoringRuntime;
  reconcileMs?: number;
  busy?: (signal: AbortSignal) => Promise<boolean>;
} = {}) {
  const database = new PoolPostgresQuery(pool);
  const workRepository = new PostgresRunnerWorkRepository(database);
  const heartbeatRepository = new PostgresRunnerHeartbeatRepository(database);
  const pingJobsRepository = new PostgresNetworkHealthPingJobsRepository(database);
  const authRepository = new PostgresLocalAuthRepository(database);
  const runtime = options.runtime ?? new MonitoringRuntime(0);
  const service = new RunnerWorkService(workRepository);
  const server = buildServer({
    logger: false,
    runnerWork: { token: CONTROL_TOKEN, service },
    runnerControl: {
      token: CONTROL_TOKEN,
      service,
      work: workRepository,
      runtime,
      busy: options.busy ?? (async (signal: AbortSignal) => workRepository.busy(signal)),
      reconcileMs: options.reconcileMs ?? 10000,
      heartbeat: heartbeatRepository
    },
    presence: {
      token: PRESENCE_TOKEN,
      runtime,
      checkMs: 10,
      session: async (token, signal) => authRepository.approvedPresence(token, signal)
    }
  });
  servers.add(server);
  await registerTestRunner(pool);
  await pingJobsRepository.expireStale(new AbortController().signal);
  return { server, service, runtime, database, pingJobsRepository };
}

const connectControl = (origin: string, token = CONTROL_TOKEN) => {
  const socket = new WebSocket(origin.replace("http:", "ws:") + "/api/runner/control", { headers: { authorization: `Bearer ${token}` } });
  const inbox: Record<string, unknown>[] = [];
  inboxes.set(socket, inbox);
  socket.on("message", (data) => {
    try {
      const event = JSON.parse(data.toString()) as Record<string, unknown>;
      inbox.push(event);
      if (inbox.length > 32) inbox.shift();
    } catch { /* waitForMessage reports malformed frames when observed */ }
  });
  sockets.add(socket);
  return socket;
};

function waitForMessage(socket: WebSocket, type: string,
  predicate: (event: Record<string, unknown>) => boolean = () => true): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const inbox = inboxes.get(socket);
    if (!inbox) { reject(new Error("Control inbox missing")); return; }
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", handler);
      socket.off("close", closeHandler);
      socket.off("error", errorHandler);
    };
    const handler = () => {
      const index = inbox.findIndex((event) => event.type === type && predicate(event));
      if (index >= 0) {
        const [event] = inbox.splice(index, 1);
        cleanup();
        resolve(event!);
      }
    };
    const closeHandler = (code: number, reason: Buffer) => {
      cleanup();
      const safeReason = /^[A-Z_]{1,32}$/.test(reason.toString()) ? reason.toString() : "UNSPECIFIED";
      reject(new Error(`Control socket closed code=${code} reason=${safeReason} awaiting=${type}`));
    };
    const errorHandler = () => { cleanup(); reject(new Error(`Control socket error awaiting=${type}`)); };
    const timeout = setTimeout(() => { cleanup(); reject(new Error(`Control frame missing: ${type}`)); }, 8_000);
    socket.on("message", handler);
    socket.once("close", closeHandler);
    socket.once("error", errorHandler);
    handler();
    if (socket.readyState === WebSocket.CLOSED && inbox.every((event) => event.type !== type)) {
      cleanup(); reject(new Error(`Control socket already closed awaiting=${type}`));
    }
  });
}

function waitForWork(socket: WebSocket): Promise<Record<string, unknown>> {
  return waitForMessage(socket, "work_available", (event) =>
    Array.isArray(event.available) && event.available.includes("manual_ping"));
}

async function connectReady(origin: string): Promise<WebSocket> {
  const socket = connectControl(origin);
  await once(socket, "open");
  const ready = waitForMessage(socket, "ready");
  socket.send(healthMessage());
  await ready;
  return socket;
}

test("enqueue committed job and subsequent runner claim", { timeout: 15000 }, async () => {
  const pool = await createTestPool();
  try {
    const { server, service, pingJobsRepository } = await buildTestServer(pool);
    const origin = await server.listen({ host: "127.0.0.1", port: 0 });
    const socket = await connectReady(origin);

    const actor = await createApprovedProfile(pool);
    const targetId = await createPingTarget(pool, actor.id);
    const createResult = await pingJobsRepository.create(actor.id, { targetId }, new AbortController().signal);
    assert.ok(createResult);

    const workNotice = waitForWork(socket);
    service.wake(RUNNER_ID);
    const workAvailable = await workNotice;
    assert.deepEqual(workAvailable.available, ["manual_ping"]);

    const claimResult = await pingJobsRepository.claim(RUNNER_ID, new AbortController().signal);
    assert.ok(claimResult);
    assert.equal(claimResult.status, "running");

  } finally { /* afterEach owns socket/server/pool and fixture cleanup */ }
});

test("concurrent atomic claims; only one runner claims a job", { timeout: 15000 }, async () => {
  const pool = await createTestPool();
  try {
    const { pingJobsRepository } = await buildTestServer(pool);
    const actor = await createApprovedProfile(pool);
    const targetId = await createPingTarget(pool, actor.id);
    await pingJobsRepository.create(actor.id, { targetId }, new AbortController().signal);

    const claim1 = pingJobsRepository.claim(RUNNER_ID, new AbortController().signal);
    const claim2 = pingJobsRepository.claim(RUNNER_ID, new AbortController().signal);
    const [result1, result2] = await Promise.all([claim1, claim2]);

    const claimed = [result1, result2].filter(r => r !== null);
    assert.equal(claimed.length, 1, "One queued job can be claimed only once");

  } finally { /* afterEach owns resource cleanup */ }
});

test("work priority and durable reconciliation", { timeout: 15000 }, async () => {
  const pool = await createTestPool();
  try {
    const { server, service, pingJobsRepository } = await buildTestServer(pool);
    const origin = await server.listen({ host: "127.0.0.1", port: 0 });
    const socket = await connectReady(origin);

    const actor = await createApprovedProfile(pool);
    const targetId = await createPingTarget(pool, actor.id);
    await pingJobsRepository.create(actor.id, { targetId }, new AbortController().signal);

    await pool.query(`
      INSERT INTO public.traffic_live_sessions (runner_id, requested_by, duration_seconds, capture_scope)
      VALUES ($1, $2::uuid, 300, 'this_device')
    `, [RUNNER_ID, actor.id]);

    await pool.query(`
      INSERT INTO public.network_discovery_sessions (runner_id, requested_by)
      VALUES ($1, $2::uuid)
    `, [RUNNER_ID, actor.id]);

    const workNotice = waitForWork(socket);
    service.wake(RUNNER_ID);
    const workAvailable = await workNotice;
    const kinds = workAvailable.available as WorkKind[];
    assert.ok(kinds.includes("manual_ping"));
    assert.ok(kinds.includes("traffic"));
    assert.ok(kinds.includes("discovery"));
    assert.equal(kinds.indexOf("manual_ping"), 0, "manual_ping should be highest priority");

  } finally { /* afterEach owns resource cleanup */ }
});

test("enqueue during busy reconciliation", { timeout: 15000 }, async () => {
  const pool = await createTestPool();
  try {
    let reads = 0;
    let releaseFirstRead: (value: boolean) => void;
    const firstReadPromise = new Promise<boolean>(resolve => { releaseFirstRead = resolve; });

    const { server, service, pingJobsRepository } = await buildTestServer(pool, {
      reconcileMs: 50,
      runtime: new MonitoringRuntime(0),
      busy: async () => {
        reads++;
        if (reads === 1) {
          await firstReadPromise;
        }
        return reads > 1;
      }
    });

    const origin = await server.listen({ host: "127.0.0.1", port: 0 });
    const socket = await connectReady(origin);

    const actor = await createApprovedProfile(pool);
    const targetId = await createPingTarget(pool, actor.id);
    const createPromise = pingJobsRepository.create(actor.id, { targetId }, new AbortController().signal);

    releaseFirstRead!(false);
    await createPromise;

    const workNotice = waitForWork(socket);
    service.wake(RUNNER_ID);
    const workAvailable = await workNotice;
    assert.ok((workAvailable.available as WorkKind[]).includes("manual_ping"));

  } finally { /* afterEach owns resource cleanup */ }
});

test("duplicate wakeup does not duplicate execution", { timeout: 15000 }, async () => {
  const pool = await createTestPool();
  try {
    const { server, service, pingJobsRepository } = await buildTestServer(pool);
    const origin = await server.listen({ host: "127.0.0.1", port: 0 });
    const socket = await connectReady(origin);

    const actor = await createApprovedProfile(pool);
    const targetId = await createPingTarget(pool, actor.id);
    await pingJobsRepository.create(actor.id, { targetId }, new AbortController().signal);

    const workNotice = waitForWork(socket);
    for (let i = 0; i < 100; i++) {
      service.wake(RUNNER_ID);
    }

    const workAvailable = await workNotice;
    assert.ok((workAvailable.available as WorkKind[]).includes("manual_ping"));

    const claims = await Promise.all(
      Array(10).fill(null).map(() => pingJobsRepository.claim(RUNNER_ID, new AbortController().signal))
    );
    const successfulClaims = claims.filter(c => c !== null);
    assert.equal(successfulClaims.length, 1, "Only one job should be claimed despite many wakeups");

  } finally { /* afterEach owns resource cleanup */ }
});

test("connection loss around transaction commit", { timeout: 15000 }, async () => {
  const pool = await createTestPool();
  try {
    const { server, service, pingJobsRepository } = await buildTestServer(pool);
    const origin = await server.listen({ host: "127.0.0.1", port: 0 });
    const socket = await connectReady(origin);

    const actor = await createApprovedProfile(pool);
    const targetId = await createPingTarget(pool, actor.id);
    await pingJobsRepository.create(actor.id, { targetId }, new AbortController().signal);

    const firstNotice = waitForWork(socket);
    service.wake(RUNNER_ID);
    await firstNotice;

    const disconnected = once(socket, "close");
    socket.terminate();
    await disconnected;

    const socket2 = await connectReady(origin);

    const secondNotice = waitForWork(socket2);
    service.wake(RUNNER_ID);
    const workAvailable = await secondNotice;
    assert.ok((workAvailable.available as WorkKind[]).includes("manual_ping"));

  } finally { /* afterEach owns resource cleanup */ }
});

test("lease expiration/recovery", { timeout: 15000 }, async () => {
  const pool = await createTestPool();
  try {
    const { pingJobsRepository } = await buildTestServer(pool);
    const actor = await createApprovedProfile(pool);
    const targetId = await createPingTarget(pool, actor.id);
    await pingJobsRepository.create(actor.id, { targetId }, new AbortController().signal);

    const claim = await pingJobsRepository.claim(RUNNER_ID, new AbortController().signal);
    assert.ok(claim);
    const jobId: string = claim.id as string;

    await pool.query(`
      UPDATE public.network_health_ping_jobs
      SET expires_at = now() - interval '1 minute', updated_at = now()
      WHERE id = $1::uuid
    `, [jobId]);

    await pingJobsRepository.expireStale(new AbortController().signal);

    const expired = await pingJobsRepository.get(jobId, new AbortController().signal);
    assert.ok(expired);
    assert.equal(expired.status, "failed");
    assert.equal(expired.error_code, "MANUAL_PING_TARGET_UNAVAILABLE");

  } finally { /* afterEach owns resource cleanup */ }
});

test("temporary database unavailability and recovery", { timeout: 15000 }, async () => {
  const pool = await createTestPool();
  try {
    const { server, service, pingJobsRepository } = await buildTestServer(pool, { reconcileMs: 100 });
    const origin = await server.listen({ host: "127.0.0.1", port: 0 });
    const socket = await connectReady(origin);

    const actor = await createApprovedProfile(pool);
    const targetId = await createPingTarget(pool, actor.id);
    await pingJobsRepository.create(actor.id, { targetId }, new AbortController().signal);

    const firstNotice = waitForWork(socket);
    service.wake(RUNNER_ID);
    await firstNotice;

    const closed = once(socket, "close");
    await pool.end();
    service.wake(RUNNER_ID);
    assert.equal((await closed)[0], 1011, "A database failure closes control without losing durable work");

    const pool2 = await createTestPool();
    const { server: server2, service: service2 } =
      await buildTestServer(pool2, { reconcileMs: 100 });
    const origin2 = await server2.listen({ host: "127.0.0.1", port: 0 });
    const socket2 = await connectReady(origin2);

    const secondNotice = waitForWork(socket2);
    service2.wake(RUNNER_ID);
    const workAvailable = await secondNotice;
    assert.ok((workAvailable.available as WorkKind[]).includes("manual_ping"));

  } finally { /* afterEach owns resource cleanup, including the ended pool */ }
});

test("pending jobs remain recoverable after backend/runner reconnect", { timeout: 15000 }, async () => {
  const pool = await createTestPool();
  try {
    const { server, service, pingJobsRepository } = await buildTestServer(pool);
    const origin = await server.listen({ host: "127.0.0.1", port: 0 });
    const socket = await connectReady(origin);

    const actor = await createApprovedProfile(pool);
    const targetId = await createPingTarget(pool, actor.id);
    const otherTargetId = await createPingTarget(pool, actor.id);
    await pingJobsRepository.create(actor.id, { targetId }, new AbortController().signal);
    await pingJobsRepository.create(actor.id, { targetId: otherTargetId }, new AbortController().signal);

    const firstNotice = waitForWork(socket);
    service.wake(RUNNER_ID);
    await firstNotice;

    await server.close();

    const { server: server2, service: service2, pingJobsRepository: pingJobsRepository2 } =
      await buildTestServer(pool);
    const origin2 = await server2.listen({ host: "127.0.0.1", port: 0 });
    const socket2 = await connectReady(origin2);

    const secondNotice = waitForWork(socket2);
    service2.wake(RUNNER_ID);
    const workAvailable = await secondNotice;
    assert.ok((workAvailable.available as WorkKind[]).includes("manual_ping"));

    const claim = await pingJobsRepository2.claim(RUNNER_ID, new AbortController().signal);
    assert.ok(claim);

  } finally { /* afterEach owns resource cleanup */ }
});

test("relevant session and presence persistence assumptions", { timeout: 15000 }, async () => {
  const pool = await createTestPool();
  try {
    const { server, runtime } = await buildTestServer(pool);
    const origin = await server.listen({ host: "127.0.0.1", port: 0 });

    const { sessionToken } = await createApprovedProfile(pool);

    const response = await fetch(`${origin}/api/application/presence`, {
      headers: {
        authorization: `Bearer ${PRESENCE_TOKEN}`,
        "x-netops-session": sessionToken
      }
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");

    const reader = response.body?.getReader();
    assert.ok(reader);

    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    assert.match(text, /event: runtime/);
    assert.match(text, /"monitoring":true/);
    assert.match(text, /"state":"DEGRADED"/, "Without a control socket, presence must not claim ACTIVE");

    assert.equal(runtime.snapshot().monitoring, true);
    await reader.cancel();

    const pool2 = await createTestPool();
    const digest = createHash("sha256").update(sessionToken, "utf8").digest();
    await pool2.query("DELETE FROM public.local_auth_sessions WHERE token_digest=$1", [digest]);

    const response2 = await fetch(`${origin}/api/application/presence`, {
      headers: {
        authorization: `Bearer ${PRESENCE_TOKEN}`,
        "x-netops-session": sessionToken
      }
    });
    assert.equal(response2.status, 401);

  } finally { /* afterEach owns resource cleanup */ }
});

test("PostgreSQL SKIP LOCKED prevents deadlocks under concurrent claims", { timeout: 20000 }, async () => {
  const pool = await createTestPool();
  try {
    const { pingJobsRepository } = await buildTestServer(pool);
    const actor = await createApprovedProfile(pool);

    const runners = Array.from({ length: 5 }, (_, i) => `pg-claim-${i}-${randomUUID()}`);
    for (const r of runners) {
      await registerTestRunner(pool, r);
      for (let i = 0; i < 4; i++) {
        const targetId = await createPingTarget(pool, actor.id, r);
        await pingJobsRepository.create(actor.id, { targetId }, new AbortController().signal);
      }
    }

    const claimResults = await Promise.all(
      runners.flatMap(r => Array(4).fill(null).map(() => pingJobsRepository.claim(r, new AbortController().signal)))
    );

    const successfulClaims = claimResults.filter(r => r !== null);
    assert.equal(successfulClaims.length, 20, "All 20 jobs should be claimed exactly once");

    const claimedIds = new Set(successfulClaims.map(c => c.id));
    assert.equal(claimedIds.size, 20, "No duplicate claims");

  } finally { /* afterEach owns resource cleanup */ }
});
