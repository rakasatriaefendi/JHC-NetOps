import assert from "node:assert/strict";
import test from "node:test";

import { BackendClient, loadLocalBackendConfig, managedTelemetryPublishError } from "../src/backend.mjs";

const local = { url: "http://127.0.0.1:3402", token: "t".repeat(32) };

test("work wait uses the same local runner bearer, exact identity, and shutdown signal", async (t) => {
  const shutdown = new AbortController();
  t.mock.method(globalThis, "fetch", async (input, options) => {
    assert.equal(String(input), `${local.url}/api/runner/work/wait`);
    assert.equal(options.headers.Authorization, `Bearer ${local.token}`);
    assert.deepEqual(JSON.parse(options.body), { runner_id: "it-lt8", wait_seconds: 60 });
    shutdown.abort(); assert.equal(options.signal.aborted, true);
    return Response.json({ data: { runner_id: "it-lt8", available: [], timed_out: true } });
  });
  const result = await new BackendClient(local, "local_postgres").waitForWork("it-lt8", shutdown.signal);
  assert.equal(result.timed_out, true);
});

test("only 404/405 indicate legacy support; 401/503 and malformed responses fail closed", async (t) => {
  let response;
  t.mock.method(globalThis, "fetch", async () => response);
  const client = new BackendClient(local, "local_postgres");
  for (const status of [404, 405]) {
    response = new Response("", { status });
    assert.deepEqual(await client.waitForWork("it-lt8"), { supported: false });
  }
  for (const status of [401, 403, 503]) {
    response = new Response("private response must not escape", { status });
    await assert.rejects(client.waitForWork("it-lt8"), new RegExp(`HTTP ${status}`));
  }
  for (const data of [
    { runner_id: "other", available: ["traffic"], timed_out: false },
    { runner_id: "it-lt8", available: ["traffic", "traffic"], timed_out: false },
    { runner_id: "it-lt8", available: ["arbitrary"], timed_out: false },
    { runner_id: "it-lt8", available: [], timed_out: false },
  ]) {
    response = Response.json({ data });
    await assert.rejects(client.waitForWork("it-lt8"), /Invalid work wait response/);
  }
});

test("runner accepts only explicit local PostgreSQL authority and local backend configuration", () => {
  assert.throws(() => new BackendClient(local, "remote"), /local_postgres/);
  assert.throws(() => new BackendClient(null, "local_postgres"), /Local backend/);
  assert.deepEqual(loadLocalBackendConfig({ LOCAL_BACKEND_URL: local.url, LOCAL_BACKEND_TOKEN: local.token }), local);
});

test("older work-wait backend negotiates the 10s body without weakening authentication", async (t) => {
  const bodies = [];
  const deadlines = [];
  t.mock.method(AbortSignal, "timeout", (ms) => { deadlines.push(ms); return new AbortController().signal; });
  t.mock.method(globalThis, "fetch", async (_input, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${local.token}`);
    const body = JSON.parse(options.body); bodies.push(body);
    if (body.wait_seconds) return Response.json({ error: { code: "INVALID_WORK_WAIT" } }, { status: 400 });
    return Response.json({ data: { runner_id: "it-lt8", available: [], timed_out: true } });
  });
  const client = new BackendClient(local, "local_postgres");
  await client.waitForWork("it-lt8"); await client.waitForWork("it-lt8");
  assert.deepEqual(bodies, [{ runner_id: "it-lt8", wait_seconds: 60 }, { runner_id: "it-lt8" }, { runner_id: "it-lt8" }]);
  assert.deepEqual(deadlines, [70_000, 20_000, 20_000]);
});

test("arbitrary 400 is not treated as quiet-wait compatibility", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls += 1; return Response.json({ error: { code: "OTHER" } }, { status: 400 }); });
  await assert.rejects(new BackendClient(local, "local_postgres").waitForWork("it-lt8"), /HTTP 400/);
  assert.equal(calls, 1);
});

test("only fresh, validated, runner-bound heartbeat hints suppress empty assignment GETs", async (t) => {
  let data = { id: "it-lt8", monitoring_assignments: { health: false, telemetry: false } };
  t.mock.method(globalThis, "fetch", async () => Response.json({ data }));
  const client = new BackendClient(local, "local_postgres");
  assert.equal(client.monitoringIdle("health"), false);
  await client.heartbeat({ id: "it-lt8" });
  const received = client.assignmentHint.receivedAt;
  assert.equal(client.monitoringIdle("health", received + 60_000), true);
  assert.equal(client.monitoringIdle("telemetry", received + 120_000), true);
  assert.equal(client.monitoringIdle("health", received + 120_001), false);
  assert.equal(client.monitoringIdle("health", received - 1), false);
  data = { id: "it-lt8", monitoring_assignments: { health: true, telemetry: true } };
  await client.heartbeat({ id: "it-lt8" }); assert.equal(client.monitoringIdle("health"), false);
  data = { id: "other", monitoring_assignments: { health: false, telemetry: false } };
  await client.heartbeat({ id: "it-lt8" }); assert.equal(client.monitoringIdle("health"), false);
  data = { id: "it-lt8" };
  await client.heartbeat({ id: "it-lt8" }); assert.equal(client.monitoringIdle("telemetry"), false);
});

test("all recurring and on-demand runner operations use loopback local routes", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (input, options) => {
    requests.push({ url: String(input), options });
    return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const client = new BackendClient(local, "local_postgres");
  await client.heartbeat({ id: "runner" });
  await client.healthTargets("runner");
  await client.claimTraffic("runner");
  await client.managedTelemetryTargets("runner");
  await client.claimDiscovery("runner");
  await client.claimInspection("runner");
  assert.deepEqual(requests.map(({ url }) => new URL(url).pathname), [
    "/api/runner/heartbeat", "/api/runner/network-health", "/api/runner/traffic",
    "/api/runner/managed-telemetry", "/api/runner/network-discovery", "/api/runner/device-inspector",
  ]);
  assert.ok(requests.every(({ url }) => new URL(url).hostname === "127.0.0.1"));
  assert.ok(requests.every(({ options }) => options.headers.Authorization === `Bearer ${local.token}`));
});

test("local failure never falls back to another transport", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls += 1; return new Response("{}", { status: 503 }); });
  const client = new BackendClient(local, "local_postgres");
  await assert.rejects(client.claimTraffic("runner"), /HTTP 503/);
  assert.equal(calls, 1);
});

test("managed telemetry publish errors retain bounded safe diagnostics", () => {
  const error = managedTelemetryPublishError(400, { error: { code: "PAYLOAD_INVALID", message: "Managed telemetry payload is invalid" } });
  assert.equal(error.status, 400);
  assert.doesNotMatch(error.message, /token|password|community/i);
});
