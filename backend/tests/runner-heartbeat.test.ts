import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type {
  RunnerHeartbeatRepository,
  RunnerHeartbeatRow,
  StoredRunnerHeartbeat,
} from "../src/runner-heartbeat/repository.js";
import { RUNNER_HEARTBEAT_BODY_LIMIT_BYTES } from "../src/runner-heartbeat/route.js";
import { buildServer } from "../src/server.js";

const TOKEN = "local-runner-token-for-tests-only";
const AUTHORIZATION = { authorization: `Bearer ${TOKEN}` };
const NOW = new Date("2026-09-07T01:02:03.000Z");

function heartbeat(overrides: Record<string, unknown> = {}) {
  return {
    runner: {
      id: "raka-local-wsl",
      display_name: "Raka Local WSL Runner",
      health_status: "online",
      health_error_code: null,
      capabilities: {
        source_locations: ["Ruang IT"],
        targets: [{
          id: "kali-lab",
          label: "Kali VM Server",
          host: "192.168.188.219",
          iperf_port: 5201,
          environment: "lan",
        }],
        durations: [5, 10],
        traffic_durations_seconds: [300, 600],
        operations: ["device_inspect", "network_discovery", "traffic_live", "bandwidth_and_path"],
        snmp_telemetry: { enabled: false },
      },
      ...overrides,
    },
  };
}

class FakeHeartbeatRepository implements RunnerHeartbeatRepository {
  rows: RunnerHeartbeatRow[] = [];
  recoveredRunnerIds: string[] = [];

  async upsertHeartbeat(row: RunnerHeartbeatRow): Promise<StoredRunnerHeartbeat> {
    this.rows.push(row);
    return {
      id: row.id,
      last_seen_at: row.last_seen_at,
      health_status: row.health_status,
      health_error_code: row.health_error_code,
    };
  }

  async expireStaleTrafficSessions(runnerId: string): Promise<void> {
    this.recoveredRunnerIds.push(runnerId);
  }
}

function serverWith(repository = new FakeHeartbeatRepository()) {
  return {
    repository,
    server: buildServer({
      logger: false,
      runnerHeartbeat: { token: TOKEN, repository, now: () => NOW },
    }),
  };
}

test("valid authenticated heartbeat is normalized, persisted, recovered, and returned", async () => {
  const { repository, server } = serverWith();
  const response = await server.inject({
    method: "POST",
    url: "/api/runner/heartbeat",
    headers: AUTHORIZATION,
    payload: heartbeat(),
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    data: {
      id: "raka-local-wsl",
      last_seen_at: NOW.toISOString(),
      health_status: "online",
      health_error_code: null,
    },
  });
  assert.equal(repository.rows.length, 1);
  assert.deepEqual(repository.rows[0], {
    id: "raka-local-wsl",
    display_name: "Raka Local WSL Runner",
    health_status: "online",
    health_error_code: null,
    capabilities: {
      source_locations: ["Ruang IT"],
      targets: [{
        id: "kali-lab",
        label: "Kali VM Server",
        host: "192.168.188.219",
        iperf_port: 5201,
        environment: "lan",
      }],
      durations: [5, 10],
      traffic_durations_seconds: [300, 600],
      operations: ["bandwidth_and_path", "traffic_live", "network_discovery", "device_inspect"],
      snmp_telemetry: { enabled: false },
    },
    last_seen_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  });
  assert.deepEqual(repository.recoveredRunnerIds, ["raka-local-wsl"]);
  await server.close();
});

test("missing and invalid bearer tokens are unauthorized before payload validation", async () => {
  const { repository, server } = serverWith();
  for (const headers of [{}, { authorization: "Bearer wrong-token-that-is-long-enough" }]) {
    const response = await server.inject({
      method: "POST",
      url: "/api/runner/heartbeat",
      headers,
      payload: { runner: { secret: "must-not-be-reflected" } },
    });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), {
      error: { code: "UNAUTHORIZED", message: "Runner authentication required" },
    });
    assert.doesNotMatch(response.body, /must-not-be-reflected|wrong-token/);
  }
  assert.equal(repository.rows.length, 0);
  await server.close();
});

test("malformed heartbeat and unexpected fields are rejected without persistence", async () => {
  const { repository, server } = serverWith();
  const malformed = await server.inject({
    method: "POST",
    url: "/api/runner/heartbeat",
    headers: AUTHORIZATION,
    payload: heartbeat({ health_status: "unknown" }),
  });
  const unexpected = await server.inject({
    method: "POST",
    url: "/api/runner/heartbeat",
    headers: AUTHORIZATION,
    payload: { ...heartbeat(), unexpected: true },
  });
  const unexpectedCapability = heartbeat();
  Object.assign(unexpectedCapability.runner.capabilities, { plaintext_secret: "do-not-reflect" });
  const capability = await server.inject({
    method: "POST",
    url: "/api/runner/heartbeat",
    headers: AUTHORIZATION,
    payload: unexpectedCapability,
  });

  assert.equal(malformed.statusCode, 400);
  assert.equal(unexpected.statusCode, 400);
  assert.equal(capability.statusCode, 400);
  assert.doesNotMatch(capability.body, /do-not-reflect|plaintext_secret/);
  assert.equal(repository.rows.length, 0);
  await server.close();
});

test("current Device Inspector and SNMP capability shapes remain accepted", async () => {
  const { repository, server } = serverWith();
  const payload = heartbeat();
  Object.assign(payload.runner.capabilities, {
    device_inspector: {
      schema_version: 1,
      available: true,
      probe_engine: "python_socket",
      python_version: "3.12.13",
      required: { python_socket: true },
      collectors: { tcp_connect: true, http_metadata: true, tls_metadata: true },
      optional: { openssl: true },
      available_but_unused: { nmap: true },
      optional_not_required: { curl: true },
    },
    snmp_telemetry: {
      enabled: true,
      max_concurrent: 2,
      poll_intervals_seconds: [30, 60],
      versions: ["3", "2c"],
      credential_profiles: ["monitoring-readonly-v3"],
    },
  });
  const response = await server.inject({
    method: "POST",
    url: "/api/runner/heartbeat",
    headers: AUTHORIZATION,
    payload,
  });

  assert.equal(response.statusCode, 200);
  assert.equal(repository.rows[0]?.capabilities.device_inspector?.required.python_socket, true);
  assert.deepEqual(repository.rows[0]?.capabilities.snmp_telemetry, {
    enabled: true,
    max_concurrent: 2,
    poll_intervals_seconds: [30, 60],
    versions: ["3", "2c"],
    credential_profiles: ["monitoring-readonly-v3"],
  });
  await server.close();
});

test("heartbeat request body is bounded below the global backend limit", async () => {
  const { repository, server } = serverWith();
  const response = await server.inject({
    method: "POST",
    url: "/api/runner/heartbeat",
    headers: { ...AUTHORIZATION, "content-type": "application/json" },
    payload: JSON.stringify({ runner: { padding: "x".repeat(RUNNER_HEARTBEAT_BODY_LIMIT_BYTES) } }),
  });
  assert.equal(response.statusCode, 413);
  assert.deepEqual(response.json(), {
    error: { code: "PAYLOAD_TOO_LARGE", message: "Request payload is too large" },
  });
  assert.equal(repository.rows.length, 0);
  await server.close();
});

test("persistence failures return and log only bounded categories", async () => {
  const repository: RunnerHeartbeatRepository = {
    async upsertHeartbeat() {
      throw new Error("authorization=Bearer leaked-token service_role=leaked-key");
    },
    async expireStaleTrafficSessions() {},
  };
  const server = buildServer({
    logger: false,
    runnerHeartbeat: { token: TOKEN, repository, now: () => NOW },
  });
  const response = await server.inject({
    method: "POST",
    url: "/api/runner/heartbeat",
    headers: AUTHORIZATION,
    payload: heartbeat(),
  });
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json(), {
    error: { code: "HEARTBEAT_PERSISTENCE_FAILED", message: "Runner heartbeat could not be stored" },
  });
  assert.doesNotMatch(response.body, /leaked-token|leaked-key|authorization|service_role/i);
  const routeSource = readFileSync(
    new URL("../src/runner-heartbeat/route.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(routeSource, /request\.body.*log|error\.message.*log/);
  await server.close();
});
