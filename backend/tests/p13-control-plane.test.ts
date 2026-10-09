import assert from "node:assert/strict";
import test from "node:test";

import { PostgresDiagnosticJobsRepository } from "../src/persistence/diagnostic-jobs.js";
import { PostgresDeviceInspectionRepository } from "../src/persistence/device-inspection.js";
import { PostgresNetworkDiscoveryRepository } from "../src/persistence/network-discovery.js";
import { PostgresNetworkHealthPingJobsRepository } from "../src/persistence/network-health-ping-jobs.js";
import { PostgresNetworkHealthRepository } from "../src/persistence/network-health.js";
import type { PostgresQuery, PostgresTransactionalQuery } from "../src/persistence/postgres-query.js";
import { PostgresTrafficRepository } from "../src/persistence/traffic.js";

const ACTOR = "10000000-0000-4000-8000-000000000001";
const TARGET = "20000000-0000-4000-8000-000000000002";
const SESSION = "30000000-0000-4000-8000-000000000003";
const RUNNER = "runner-test";
const signal = () => new AbortController().signal;

test("local diagnostic preflight and creation derive trusted target evidence inside transactions", async () => {
  const database = new ControlDatabase();
  const repository = new PostgresDiagnosticJobsRepository(database);
  database.preflight = null;
  const queued = await repository.requestPreflight(ACTOR, RUNNER, "kali-lab", signal());
  assert.equal(queued.status, "queued");
  assert.ok(database.calls.some(({ sql }) => sql.includes("UPDATE public.diagnostic_runners SET preflight")));

  database.preflight = completedPreflight();
  const job = await repository.create(ACTOR, {
    runnerId: RUNNER, sourceLabel: "IT Room", targetId: "kali-lab", durationSeconds: 5,
  }, signal());
  assert.equal(job.target_host, "192.168.1.219");
  const insert = database.calls.find(({ sql }) => sql.includes("INSERT INTO public.diagnostic_jobs"));
  assert.ok(insert);
  assert.deepEqual(insert.values.slice(0, 10), [RUNNER, ACTOR, "IT Room", "kali-lab", "Kali Lab",
    "192.168.1.219", 5201, "wifi", 5, "lan"]);
  assert.equal(database.transactions, 2);
});

test("local Manual Ping resolves the enabled target runner and never accepts a browser runner", async () => {
  const database = new ControlDatabase();
  const row = await new PostgresNetworkHealthPingJobsRepository(database)
    .create(ACTOR, { targetId: TARGET }, signal());
  assert.equal(row.runner_id, RUNNER);
  const insert = database.calls.find(({ sql }) => sql.includes("INSERT INTO public.network_health_ping_jobs"));
  assert.ok(insert);
  assert.deepEqual(insert.values, [TARGET, RUNNER, ACTOR]);
  assert.match(insert.sql, /interval '30 seconds'/);
});

test("local Manual Ping claim excludes expired jobs and terminal mutations bind runner and job", async () => {
  const database = new ControlDatabase();
  const repository = new PostgresNetworkHealthPingJobsRepository(database);
  const now = new Date().toISOString();
  await repository.claim(RUNNER, signal());
  await repository.complete(SESSION, RUNNER, now, { ok: true, latency_ms: 2 }, signal());
  await repository.fail(SESSION, RUNNER, now, "MANUAL_PING_FAILED", signal());
  const claim = database.calls.find(({ sql }) => sql.includes("FOR UPDATE SKIP LOCKED") && sql.includes("network_health_ping_jobs"));
  const complete = database.calls.find(({ sql }) => sql.includes("status='completed'") && sql.includes("result=$4::jsonb"));
  const fail = database.calls.find(({ sql }) => sql.includes("status='failed'") && sql.includes("error_code=$4"));
  assert.ok(claim);
  assert.match(claim.sql, /runner_id=\$1 AND status='queued' AND expires_at >= now\(\)/);
  assert.ok(complete);
  assert.match(complete.sql, /id=\$1::uuid AND runner_id=\$2 AND status='running' AND expires_at >= \$3::timestamptz/);
  assert.ok(fail);
  assert.match(fail.sql, /id=\$1::uuid AND runner_id=\$2 AND status='running'/);
  const expiry = database.calls.find(({ sql }) => sql.includes("expires_at < now()"));
  assert.ok(expiry);
  assert.match(expiry.sql, /status='failed', completed_at=now\(\)/);
  assert.match(expiry.sql, /error_code='MANUAL_PING_TARGET_UNAVAILABLE'/, "retain the existing schema's bounded expiry code");
});

test("Manual Ping rejects a busy Traffic runner before queuing, without changing serial execution", async () => {
  const database = new ControlDatabase();
  database.trafficBusy = true;
  await assert.rejects(new PostgresNetworkHealthPingJobsRepository(database)
    .create(ACTOR, { targetId: TARGET }, signal()), { code: "RUNNER_BUSY" });
  assert.equal(database.calls.some(({ sql }) => sql.includes("INSERT INTO public.network_health_ping_jobs")), false);
  const busy = database.calls.find(({ sql }) => sql.includes(" AS traffic,"));
  assert.ok(busy);
  assert.match(busy.sql, /traffic_live_sessions WHERE runner_id=\$1 AND status IN \('queued','running','stopping'\)/);
});

test("Manual Ping rejects a stale runner before queuing with RUNNER_OFFLINE", async () => {
  const database = new ControlDatabase();
  database.runnerSeenAt = new Date(Date.now() - 121_000);
  await assert.rejects(new PostgresNetworkHealthPingJobsRepository(database)
    .create(ACTOR, { targetId: TARGET }, signal()), { code: "RUNNER_OFFLINE" });
  assert.equal(database.calls.some(({ sql }) => sql.includes("INSERT INTO public.network_health_ping_jobs")), false);
});

test("the runner Health route preserves the same lease/expiry and runner binding as the application repository", async () => {
  const database = new ControlDatabase();
  const repository = new PostgresNetworkHealthRepository(database);
  await repository.claimManualPing(RUNNER, signal());
  await repository.completeManualPing(SESSION, RUNNER, new Date().toISOString(), { ok: true, latency_ms: 2 }, signal());
  const expiry = database.calls.find(({ sql }) => sql.includes("expires_at < now()"));
  const claim = database.calls.find(({ sql }) => sql.includes("FOR UPDATE SKIP LOCKED"));
  const complete = database.calls.find(({ sql }) => sql.includes("status='completed'"));
  assert.ok(expiry && claim && complete);
  assert.match(expiry.sql, /error_code='MANUAL_PING_TARGET_UNAVAILABLE'/);
  assert.match(expiry.sql, /completed_at=now\(\)/, "completion timestamp distinguishes persisted expiry without schema changes");
  assert.match(claim.sql, /runner_id=\$1 AND status='queued' AND expires_at >= now\(\)/);
  assert.match(complete.sql, /id=\$1::uuid AND runner_id=\$2 AND status='running' AND expires_at >= \$3::timestamptz/);
});

test("local Discovery prepare and start preserve the prepared session lifecycle", async () => {
  const database = new ControlDatabase();
  const repository = new PostgresNetworkDiscoveryRepository(database);
  const prepared = await repository.create(ACTOR, { runnerId: RUNNER }, signal());
  assert.equal(prepared.status, "queued");
  const started = await repository.start(ACTOR, RUNNER, SESSION, signal());
  assert.equal(started.phase, "scan");
  const start = database.calls.find(({ sql }) =>
    sql.includes("UPDATE public.network_discovery_sessions SET status='queued',phase='scan'"));
  assert.ok(start);
  assert.match(start.sql, /session_id=\$2::uuid AND status IN \('idle','completed','failed'\)/);
  assert.deepEqual(start.values, [RUNNER, SESSION]);
});

test("local Discovery runner mutations enforce runner, session, status, and phase", async () => {
  const database = new ControlDatabase();
  const repository = new PostgresNetworkDiscoveryRepository(database);
  await repository.claim(RUNNER, new Date().toISOString(), signal());
  await repository.contextReady(RUNNER, SESSION, {
    connection_type: "wifi", interface_alias: "Wi-Fi", local_ipv4: "192.168.1.67",
    subnet_cidr: "192.168.1.0/24", total_hosts: 254,
  }, new Date().toISOString(), signal());
  await repository.complete(RUNNER, SESSION, 254, new Date().toISOString(), signal());
  const claim = database.calls.find(({ sql }) => sql.includes("FOR UPDATE SKIP LOCKED"));
  const context = database.calls.find(({ sql }) => sql.includes("status='idle',completed_at"));
  const complete = database.calls.find(({ sql }) => sql.includes("status='completed',scanned_hosts"));
  assert.ok(claim);
  assert.match(claim.sql, /runner_id=\$1[\s\S]*status='queued'/);
  assert.ok(context);
  assert.match(context.sql, /runner_id=\$1 AND session_id=\$2::uuid AND status='running' AND phase='prepare'/);
  assert.deepEqual(context.values.slice(0, 2), [RUNNER, SESSION]);
  assert.ok(complete);
  assert.match(complete.sql, /runner_id=\$1 AND session_id=\$2::uuid AND status='running' AND phase='scan'/);
});

test("local Device Inspector derives inventory authorization and does not accept a caller source", async () => {
  const database = new ControlDatabase();
  const row = await new PostgresDeviceInspectionRepository(database).create(ACTOR, {
    runnerId: RUNNER, targetIp: "192.168.1.50",
  }, signal());
  assert.equal(row.authorization_source, "inventory");
  const insert = database.calls.find(({ sql }) => sql.includes("INSERT INTO public.device_inspection_sessions"));
  assert.ok(insert);
  assert.deepEqual(insert.values, [RUNNER, ACTOR, "192.168.1.50", "inventory"]);
});

test("local Device Inspector runner lifecycle binds runner, inspection, status, and target", async () => {
  const database = new ControlDatabase();
  const repository = new PostgresDeviceInspectionRepository(database);
  const now = new Date().toISOString();
  const claimed = await repository.claim(RUNNER, now, signal());
  assert.equal(claimed?.status, "running");
  await repository.updateStage(RUNNER, SESSION, "identity", now, signal());
  await repository.complete(RUNNER, SESSION, {
    ip: "192.168.1.50", confidence: "medium", likely_device_type: "server",
    capabilities: [], evidence: [],
  }, now, signal());
  const claim = database.calls.find(({ sql }) => sql.includes("UPDATE public.device_inspection_sessions AS session"));
  const stage = database.calls.find(({ sql }) => sql.includes("SET stage=$3"));
  const complete = database.calls.find(({ sql }) => sql.includes("status='completed',stage='complete'"));
  assert.ok(claim);
  assert.match(claim.sql, /runner_id=\$1[\s\S]*status='queued'[\s\S]*FOR UPDATE SKIP LOCKED/);
  assert.ok(stage);
  assert.match(stage.sql, /runner_id=\$1 AND inspection_id=\$2::uuid AND status='running'/);
  assert.ok(complete);
  assert.match(complete.sql, /inspection_id=\$2::uuid AND status='running' AND target_ip=\$4::inet/);
  assert.deepEqual(complete.values.slice(0, 2), [RUNNER, SESSION]);
});

test("Discovery remains busy only while a Device Inspection is active", async () => {
  const database = new ControlDatabase();
  const repository = new PostgresNetworkDiscoveryRepository(database);
  database.inspectionBusy = true;
  await assert.rejects(repository.start(ACTOR, RUNNER, SESSION, signal()),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "RUNNER_BUSY");
  database.inspectionBusy = false;
  const started = await repository.start(ACTOR, RUNNER, SESSION, signal());
  assert.equal(started.status, "queued");
});

test("local Traffic create and stop use the actor, runner capability, bounds, and transactional lifecycle", async () => {
  const database = new ControlDatabase();
  const repository = new PostgresTrafficRepository(database);
  const created = await repository.createSession(ACTOR, RUNNER, 300, signal());
  assert.equal(created.status, "queued");
  const insert = database.calls.find(({ sql }) => sql.includes("INSERT INTO public.traffic_live_sessions"));
  assert.ok(insert);
  assert.deepEqual(insert.values, [RUNNER, ACTOR, 300]);
  const stopped = await repository.stopSession(ACTOR, SESSION, signal());
  assert.equal(stopped?.status, "completed");
  assert.equal(database.transactions, 2);
});

test("local control-plane rejects an unapproved actor before a domain write", async () => {
  const database = new ControlDatabase();
  database.profileStatus = "pending";
  await assert.rejects(
    new PostgresNetworkHealthPingJobsRepository(database).create(ACTOR, { targetId: TARGET }, signal()),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error &&
      error.code === "OPERATION_NOT_AUTHORIZED",
  );
  assert.equal(database.calls.some(({ sql }) => sql.includes("INSERT INTO public.network_health_ping_jobs")), false);
});

class ControlDatabase implements PostgresTransactionalQuery {
  readonly calls: { sql: string; values: readonly unknown[] }[] = [];
  transactions = 0;
  profileStatus = "approved";
  preflight: Record<string, unknown> | null = completedPreflight();
  inspectionBusy = false;
  trafficBusy = false;
  runnerSeenAt = new Date();

  async rows(sql: string, values: readonly unknown[]): Promise<readonly Record<string, unknown>[]> {
    this.calls.push({ sql, values });
    if (sql.includes("SELECT role,status FROM public.profiles")) {
      return [{ role: "operator", status: this.profileStatus }];
    }
    if (sql.includes("FROM public.diagnostic_runners WHERE id")) return [this.runner()];
    if (sql.includes("UPDATE public.diagnostic_runners SET preflight")) {
      return [{ preflight: JSON.parse(String(values[1])) as Record<string, unknown> }];
    }
    if (sql.includes("SELECT id,runner_id FROM public.network_targets")) return [{ id: TARGET, runner_id: RUNNER }];
    if (sql.includes("SELECT id FROM public.network_nodes")) return [{ id: TARGET }];
    if (sql.includes(" AS diagnostic") || sql.includes(" AS traffic,")) {
      return [{ diagnostic: false, traffic: this.trafficBusy, discovery: false, inspection: this.inspectionBusy }];
    }
    if (sql.includes("SELECT * FROM public.network_discovery_sessions") && sql.includes("status IN ('queued','running')")) return [];
    if (sql.includes("pg_total_relation_size")) return [{ status: "healthy" }];
    if (sql.includes("INSERT INTO public.diagnostic_jobs")) {
      return [{ id: SESSION, target_host: values[5], status: "queued" }];
    }
    if (sql.includes("INSERT INTO public.network_health_ping_jobs")) {
      return [{ id: SESSION, runner_id: values[1], status: "queued" }];
    }
    if (sql.includes("INSERT INTO public.network_discovery_sessions")) {
      return [{ runner_id: RUNNER, session_id: SESSION, status: "queued", phase: "prepare" }];
    }
    if (sql.includes("UPDATE public.network_discovery_sessions SET status='queued',phase='scan'")) {
      return [{ runner_id: RUNNER, session_id: SESSION, status: "queued", phase: "scan" }];
    }
    if (sql.includes("INSERT INTO public.device_inspection_sessions")) {
      return [{ runner_id: RUNNER, inspection_id: SESSION, status: "queued", authorization_source: values[3] }];
    }
    if (sql.includes("UPDATE public.device_inspection_sessions AS session")) {
      return [{ runner_id: RUNNER, inspection_id: SESSION, target_ip: "192.168.1.50", status: "running" }];
    }
    if (sql.includes("UPDATE public.device_inspection_sessions SET stage=$3")) {
      return [{ runner_id: RUNNER, inspection_id: SESSION, status: "running", stage: values[2] }];
    }
    if (sql.includes("UPDATE public.device_inspection_sessions SET") && sql.includes("status='completed'")) {
      return [{ runner_id: RUNNER, inspection_id: SESSION, status: "completed" }];
    }
    if (sql.includes("INSERT INTO public.traffic_live_sessions")) {
      return [{ id: SESSION, runner_id: RUNNER, status: "queued" }];
    }
    if (sql.includes("UPDATE public.traffic_live_sessions SET") && sql.includes("status='completed'")) {
      return [{ id: SESSION, status: "completed" }];
    }
    return [];
  }

  async transaction<T>(_signal: AbortSignal, action: (query: PostgresQuery) => Promise<T>): Promise<T> {
    this.transactions += 1;
    return action(this);
  }

  private runner(): Record<string, unknown> {
    return {
      id: RUNNER,
      last_seen_at: this.runnerSeenAt,
      health_status: "online",
      preflight: this.preflight,
      capabilities: {
        source_locations: ["IT Room"],
        targets: [{ id: "kali-lab", label: "Kali Lab", host: "192.168.1.219", iperf_port: 5201,
          environment: "lan" }],
        durations: [5, 10],
        traffic_durations_seconds: [300, 600, 900, 1800],
        operations: ["bandwidth_and_path", "traffic_live", "network_discovery", "device_inspect", "manual_ping"],
        device_inspector: { available: true },
      },
    };
  }
}

function completedPreflight(): Record<string, unknown> {
  return {
    request_id: SESSION,
    target_id: "kali-lab",
    status: "completed",
    requested_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    network_context: { connection_type: "wifi", local_ipv4: "192.168.1.10" },
    route_context: { route_type: "on_link" },
    checks: { iperf: { ready: true, port: 5201 } },
  };
}
