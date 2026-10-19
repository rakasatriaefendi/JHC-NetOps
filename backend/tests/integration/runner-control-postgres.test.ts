import assert from "node:assert/strict";
import test from "node:test";
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
import type { WorkKind } from "../../src/runner-work/contract.js";

const PGHOST = process.env.PGHOST ?? "localhost";
const PGPORT = Number(process.env.PGPORT ?? 5432);
const PGDATABASE = process.env.PGDATABASE ?? "jhc_netops";
const PGUSER = process.env.PGUSER ?? "jhc_netops_app";
const PGPASSWORD = process.env.PGPASSWORD ?? "test_password";

const CONTROL_TOKEN = process.env.RUNNER_CONTROL_TOKEN ?? "test-control-token-not-a-real-credential";
const PRESENCE_TOKEN = process.env.PRESENCE_TOKEN ?? "test-presence-token-not-a-real-credential";

const RUNNER_ID = "pg-integration-runner";
const RUNNER = {
  id: RUNNER_ID,
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
  await pool.query("SELECT 1");
  return pool;
}

async function registerTestRunner(pool: Pool): Promise<void> {
  await pool.query(`
    INSERT INTO public.diagnostic_runners (id, display_name, capabilities)
    VALUES ($1, $2, $3::jsonb)
    ON CONFLICT (id) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      capabilities = EXCLUDED.capabilities,
      updated_at = now()
  `, [RUNNER_ID, RUNNER.display_name, JSON.stringify(RUNNER.capabilities)]);
}

async function createApprovedProfile(pool: Pool): Promise<{ id: string; sessionToken: string }> {
  const { randomUUID } = await import("node:crypto");
  const profileId = randomUUID();
  const email = `test-${profileId}@example.com`;
  await pool.query(`
    INSERT INTO public.profiles (id, email, full_name, role, status, approved_at)
    VALUES ($1, $2, $3, 'operator', 'approved', now())
  `, [profileId, email, "Test User"]);
  const { createHash, randomBytes } = await import("node:crypto");
  const token = randomBytes(32).toString("base64url");
  const digest = createHash("sha256").update(token, "utf8").digest();
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  await pool.query(`
    INSERT INTO public.local_auth_credentials (user_id, email, password_record)
    VALUES ($1, $2, 'scrypt$v1$dummy$dummy')
  `, [profileId, email]);
  await pool.query(`
    INSERT INTO public.local_auth_sessions (token_digest, user_id, expires_at)
    VALUES ($1, $2::uuid, $3::timestamptz)
  `, [digest, profileId, expiresAt]);
  return { id: profileId, sessionToken: token };
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
  await registerTestRunner(pool);
  await pingJobsRepository.expireStale(new AbortController().signal);
  return { server, service, runtime, database, pingJobsRepository };
}

const connectControl = (origin: string, token = CONTROL_TOKEN) =>
  new WebSocket(origin.replace("http:", "ws:") + "/api/runner/control", { headers: { authorization: `Bearer ${token}` } });

function waitForMessage(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const handler = (data: Buffer) => {
      const event = JSON.parse(data.toString()) as Record<string, unknown>;
      if (event.type === type) {
        socket.off("message", handler);
        socket.off("close", closeHandler);
        resolve(event);
      }
    };
    const closeHandler = () => {
      socket.off("message", handler);
      reject(new Error("Socket closed"));
    };
    socket.on("message", handler);
    socket.once("close", closeHandler);
  });
}

test("enqueue committed job and subsequent runner claim", { timeout: 15000 }, async () => {
  const pool = await createTestPool();
  try {
    const { server, service, pingJobsRepository } = await buildTestServer(pool);
    const origin = await server.listen({ host: "127.0.0.1", port: 0 });
    const socket = connectControl(origin);
    await once(socket, "open");
    await waitForMessage(socket, "ready");
    socket.send(healthMessage());
    await waitForMessage(socket, "ready");

    const actor = await createApprovedProfile(pool);
    const createResult = await pingJobsRepository.create(actor.id, { targetId: "00000000-0000-0000-0000-000000000000" }, new AbortController().signal);
    assert.ok(createResult);

    service.wake(RUNNER_ID);
    const workAvailable = await waitForMessage(socket, "work_available");
    assert.deepEqual(workAvailable.available, ["manual_ping"]);

    const claimResult = await pingJobsRepository.claim(RUNNER_ID, new AbortController().signal);
    assert.ok(claimResult);
    assert.equal(claimResult.status, "running");

    await server.close();
  } finally {
    await pool.end();
  }
});

test("concurrent atomic claims; only one runner claims a job", { timeout: 15000 }, async () => {
  const pool = await createTestPool();
  try {
    const { pingJobsRepository } = await buildTestServer(pool);
    const actor = await createApprovedProfile(pool);
    await pingJobsRepository.create(actor.id, { targetId: "00000000-0000-0000-0000-000000000000" }, new AbortController().signal);
    await pingJobsRepository.create(actor.id, { targetId: "00000000-0000-0000-0000-000000000001" }, new AbortController().signal);

    const claim1 = pingJobsRepository.claim(RUNNER_ID, new AbortController().signal);
    const claim2 = pingJobsRepository.claim(RUNNER_ID, new AbortController().signal);
    const [result1, result2] = await Promise.all([claim1, claim2]);

    const claimed = [result1, result2].filter(r => r !== null);
    assert.equal(claimed.length, 1, "Only one claim should succeed due to SKIP LOCKED");

    await pool.end();
  } finally {
    await pool.end();
  }
});

test("work priority and durable reconciliation", { timeout: 15000 }, async () => {
  const pool = await createTestPool();
  try {
    const { server, service, pingJobsRepository } = await buildTestServer(pool);
    const origin = await server.listen({ host: "127.0.0.1", port: 0 });
    const socket = connectControl(origin);
    await once(socket, "open");
    await waitForMessage(socket, "ready");
    socket.send(healthMessage());
    await waitForMessage(socket, "ready");

    const actor = await createApprovedProfile(pool);
    await pingJobsRepository.create(actor.id, { targetId: "00000000-0000-0000-0000-000000000000" }, new AbortController().signal);

    await pool.query(`
      INSERT INTO public.traffic_live_sessions (runner_id, requested_by, duration_seconds, capture_scope)
      VALUES ($1, $2::uuid, 300, 'this_device')
    `, [RUNNER_ID, actor.id]);

    await pool.query(`
      INSERT INTO public.network_discovery_sessions (runner_id, requested_by)
      VALUES ($1, $2::uuid)
    `, [RUNNER_ID, actor.id]);

    service.wake(RUNNER_ID);
    const workAvailable = await waitForMessage(socket, "work_available");
    const kinds = workAvailable.available as WorkKind[];
    assert.ok(kinds.includes("manual_ping"));
    assert.ok(kinds.includes("traffic"));
    assert.ok(kinds.includes("discovery"));
    assert.equal(kinds.indexOf("manual_ping"), 0, "manual_ping should be highest priority");

    await server.close();
  } finally {
    await pool.end();
  }
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
    const socket = connectControl(origin);
    await once(socket, "open");
    await waitForMessage(socket, "ready");
    socket.send(healthMessage());
    await waitForMessage(socket, "ready");

    const actor = await createApprovedProfile(pool);
    const createPromise = pingJobsRepository.create(actor.id, { targetId: "00000000-0000-0000-0000-000000000000" }, new AbortController().signal);

    releaseFirstRead!(false);
    await createPromise;

    service.wake(RUNNER_ID);
    const workAvailable = await waitForMessage(socket, "work_available");
    assert.ok((workAvailable.available as WorkKind[]).includes("manual_ping"));

    await server.close();
  } finally {
    await pool.end();
  }
});

test("duplicate wakeup does not duplicate execution", { timeout: 15000 }, async () => {
  const pool = await createTestPool();
  try {
    const { server, service, pingJobsRepository } = await buildTestServer(pool);
    const origin = await server.listen({ host: "127.0.0.1", port: 0 });
    const socket = connectControl(origin);
    await once(socket, "open");
    await waitForMessage(socket, "ready");
    socket.send(healthMessage());
    await waitForMessage(socket, "ready");

    const actor = await createApprovedProfile(pool);
    await pingJobsRepository.create(actor.id, { targetId: "00000000-0000-0000-0000-000000000000" }, new AbortController().signal);

    for (let i = 0; i < 100; i++) {
      service.wake(RUNNER_ID);
    }

    const workAvailable = await waitForMessage(socket, "work_available");
    assert.ok((workAvailable.available as WorkKind[]).includes("manual_ping"));

    const claims = await Promise.all(
      Array(10).fill(null).map(() => pingJobsRepository.claim(RUNNER_ID, new AbortController().signal))
    );
    const successfulClaims = claims.filter(c => c !== null);
    assert.equal(successfulClaims.length, 1, "Only one job should be claimed despite many wakeups");

    await server.close();
  } finally {
    await pool.end();
  }
});

test("connection loss around transaction commit", { timeout: 15000 }, async () => {
  const pool = await createTestPool();
  try {
    const { server, service, pingJobsRepository } = await buildTestServer(pool);
    const origin = await server.listen({ host: "127.0.0.1", port: 0 });
    const socket = connectControl(origin);
    await once(socket, "open");
    await waitForMessage(socket, "ready");
    socket.send(healthMessage());
    await waitForMessage(socket, "ready");

    const actor = await createApprovedProfile(pool);
    await pingJobsRepository.create(actor.id, { targetId: "00000000-0000-0000-0000-000000000000" }, new AbortController().signal);

    service.wake(RUNNER_ID);
    await waitForMessage(socket, "work_available");

    socket.terminate();
    await new Promise(r => setTimeout(r, 100));

    const socket2 = connectControl(origin);
    await once(socket2, "open");
    await waitForMessage(socket2, "ready");
    socket2.send(healthMessage());
    await waitForMessage(socket2, "ready");

    service.wake(RUNNER_ID);
    const workAvailable = await waitForMessage(socket2, "work_available");
    assert.ok((workAvailable.available as WorkKind[]).includes("manual_ping"));

    await server.close();
  } finally {
    await pool.end();
  }
});

test("lease expiration/recovery", { timeout: 15000 }, async () => {
  const pool = await createTestPool();
  try {
    const { pingJobsRepository } = await buildTestServer(pool);
    const actor = await createApprovedProfile(pool);
    await pingJobsRepository.create(actor.id, { targetId: "00000000-0000-0000-0000-000000000000" }, new AbortController().signal);

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

    await pool.end();
  } finally {
    await pool.end();
  }
});

test("temporary database unavailability and recovery", { timeout: 15000 }, async () => {
  const pool = await createTestPool();
  try {
    const { server, service, pingJobsRepository } = await buildTestServer(pool, { reconcileMs: 100 });
    const origin = await server.listen({ host: "127.0.0.1", port: 0 });
    const socket = connectControl(origin);
    await once(socket, "open");
    await waitForMessage(socket, "ready");
    socket.send(healthMessage());
    await waitForMessage(socket, "ready");

    const actor = await createApprovedProfile(pool);
    await pingJobsRepository.create(actor.id, { targetId: "00000000-0000-0000-0000-000000000000" }, new AbortController().signal);

    service.wake(RUNNER_ID);
    await waitForMessage(socket, "work_available");

    await pool.end();
    await new Promise(r => setTimeout(r, 500));

    const pool2 = await createTestPool();
    const { server: server2, service: service2 } =
      await buildTestServer(pool2, { reconcileMs: 100 });
    const origin2 = await server2.listen({ host: "127.0.0.1", port: 0 });
    const socket2 = connectControl(origin2);
    await once(socket2, "open");
    await waitForMessage(socket2, "ready");
    socket2.send(healthMessage());
    await waitForMessage(socket2, "ready");

    service2.wake(RUNNER_ID);
    const workAvailable = await waitForMessage(socket2, "work_available");
    assert.ok((workAvailable.available as WorkKind[]).includes("manual_ping"));

    await server2.close();
    await pool2.end();
  } finally {
    try { await pool.end(); } catch {}
  }
});

test("pending jobs remain recoverable after backend/runner reconnect", { timeout: 15000 }, async () => {
  const pool = await createTestPool();
  try {
    const { server, service, pingJobsRepository } = await buildTestServer(pool);
    const origin = await server.listen({ host: "127.0.0.1", port: 0 });
    const socket = connectControl(origin);
    await once(socket, "open");
    await waitForMessage(socket, "ready");
    socket.send(healthMessage());
    await waitForMessage(socket, "ready");

    const actor = await createApprovedProfile(pool);
    await pingJobsRepository.create(actor.id, { targetId: "00000000-0000-0000-0000-000000000000" }, new AbortController().signal);
    await pingJobsRepository.create(actor.id, { targetId: "00000000-0000-0000-0000-000000000001" }, new AbortController().signal);

    service.wake(RUNNER_ID);
    await waitForMessage(socket, "work_available");

    await server.close();

    const { server: server2, service: service2, pingJobsRepository: pingJobsRepository2 } =
      await buildTestServer(pool);
    const origin2 = await server2.listen({ host: "127.0.0.1", port: 0 });
    const socket2 = connectControl(origin2);
    await once(socket2, "open");
    await waitForMessage(socket2, "ready");
    socket2.send(healthMessage());
    await waitForMessage(socket2, "ready");

    service2.wake(RUNNER_ID);
    const workAvailable = await waitForMessage(socket2, "work_available");
    assert.ok((workAvailable.available as WorkKind[]).includes("manual_ping"));

    const claim = await pingJobsRepository2.claim(RUNNER_ID, new AbortController().signal);
    assert.ok(claim);

    await server2.close();
  } finally {
    await pool.end();
  }
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
    assert.ok(text.includes("STANDBY") || text.includes("ACTIVATING"));

    reader.cancel();
    await new Promise(r => setTimeout(r, 50));

    assert.equal(runtime.snapshot().monitoring, true);

    const pool2 = await createTestPool();
    await pool2.query("DELETE FROM public.local_auth_sessions");
    await pool2.end();

    const response2 = await fetch(`${origin}/api/application/presence`, {
      headers: {
        authorization: `Bearer ${PRESENCE_TOKEN}`,
        "x-netops-session": sessionToken
      }
    });
    assert.equal(response2.status, 401);

    await server.close();
  } finally {
    await pool.end();
  }
});

test("PostgreSQL SKIP LOCKED prevents deadlocks under concurrent claims", { timeout: 20000 }, async () => {
  const pool = await createTestPool();
  try {
    const { pingJobsRepository } = await buildTestServer(pool);
    const actor = await createApprovedProfile(pool);

    for (let i = 0; i < 20; i++) {
      await pingJobsRepository.create(actor.id, { targetId: `00000000-0000-0000-0000-${i.toString().padStart(12, '0')}` }, new AbortController().signal);
    }

    const runners = Array(5).fill(null).map((_, i) => `runner-${i}`);
    for (const r of runners) {
      await pool.query(`
        INSERT INTO public.diagnostic_runners (id, display_name, capabilities)
        VALUES ($1, $2, '{}'::jsonb)
      `, [r, `Runner ${r}`]);
    }

    const claimResults = await Promise.all(
      runners.flatMap(r => Array(4).fill(null).map(() => pingJobsRepository.claim(r, new AbortController().signal)))
    );

    const successfulClaims = claimResults.filter(r => r !== null);
    assert.equal(successfulClaims.length, 20, "All 20 jobs should be claimed exactly once");

    const claimedIds = new Set(successfulClaims.map(c => c.id));
    assert.equal(claimedIds.size, 20, "No duplicate claims");

    await pool.end();
  } finally {
    await pool.end();
  }
});