import assert from "node:assert/strict";
import test from "node:test";

import { BackendClient, loadLocalBackendConfig, managedTelemetryPublishError } from "../src/backend.mjs";

const local = { url: "http://127.0.0.1:3402", token: "t".repeat(32) };

test("runner accepts only explicit local PostgreSQL authority and local backend configuration", () => {
  assert.throws(() => new BackendClient(local, "remote"), /local_postgres/);
  assert.throws(() => new BackendClient(null, "local_postgres"), /Local backend/);
  assert.deepEqual(loadLocalBackendConfig({ LOCAL_BACKEND_URL: local.url, LOCAL_BACKEND_TOKEN: local.token }), local);
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
