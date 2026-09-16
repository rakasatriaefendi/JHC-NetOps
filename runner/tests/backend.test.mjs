import assert from "node:assert/strict";
import test from "node:test";

import {
  BackendClient,
  exposeLocalBackendToWsl,
  loadLocalBackendConfig,
  loadLocalHeartbeatConfig,
  managedTelemetryPublishDiagnostic,
  managedTelemetryPublishError,
} from "../src/backend.mjs";

const DEVICE = { target_id: "11111111-1111-4111-8111-111111111111", status: "connected" };
const LOCAL_TOKEN = "local-runner-token-for-tests-only";
const HEARTBEAT = { id: "runner-test", display_name: "Runner Test" };

test("local heartbeat config sends heartbeat only to the authenticated loopback route", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify({ data: { id: "runner-test" } }), { status: 200 });
  });
  const local = loadLocalHeartbeatConfig({
    LOCAL_BACKEND_URL: "http://127.0.0.1:3402/",
    LOCAL_BACKEND_TOKEN: LOCAL_TOKEN,
  });
  const client = new BackendClient("https://example.invalid", "test-service-key", local);
  assert.deepEqual(await client.heartbeat(HEARTBEAT), { id: "runner-test" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://127.0.0.1:3402/api/runner/heartbeat");
  assert.equal(requests[0].options.headers.Authorization, `Bearer ${LOCAL_TOKEN}`);
  assert.equal("apikey" in requests[0].options.headers, false);
  assert.deepEqual(JSON.parse(requests[0].options.body), { runner: HEARTBEAT });
});

test("missing local config preserves the existing Supabase Edge heartbeat", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify({ data: { id: "runner-test" } }), { status: 200 });
  });
  assert.equal(loadLocalHeartbeatConfig({}), null);
  const client = new BackendClient("https://example.invalid", "test-service-key");
  await client.heartbeat(HEARTBEAT);
  assert.equal(requests[0].url, "https://example.invalid/functions/v1/diagnostic-jobs");
  assert.equal(requests[0].options.headers.apikey, "test-service-key");
  assert.deepEqual(JSON.parse(requests[0].options.body), { action: "runner_heartbeat", runner: HEARTBEAT });
});

test("local heartbeat failure does not fall back to a duplicate Supabase write", async (t) => {
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ error: { code: "HEARTBEAT_PERSISTENCE_FAILED" } }), { status: 500 });
  });
  const client = new BackendClient("https://example.invalid", "test-service-key", {
    url: "http://127.0.0.1:3402",
    token: LOCAL_TOKEN,
  });
  await assert.rejects(client.heartbeat(HEARTBEAT), /Local heartbeat request failed with HTTP 500/);
  assert.deepEqual(urls, ["http://127.0.0.1:3402/api/runner/heartbeat"]);
});

test("local backend moves only recurring operations and retains low-frequency Edge paths", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body), headers: options.headers });
    return new Response(JSON.stringify({ data: null }), { status: 200 });
  });
  const client = new BackendClient("https://example.invalid", "test-service-key", {
    url: "http://127.0.0.1:3402",
    token: LOCAL_TOKEN,
  });
  await client.claim("runner-test");
  await client.claimManualPing("runner-test");
  await client.claimTraffic("runner-test");
  await client.healthTargets("runner-test");
  await client.publishHealth("runner-test", [], []);
  await client.claimDiscovery("runner-test");
  await client.claimInspection("runner-test");
  await client.managedTelemetryTargets("runner-test");
  await client.publishManagedTelemetry("runner-test", DEVICE, [], []);
  assert.deepEqual(requests.map(({ url }) => url), [
    "https://example.invalid/functions/v1/diagnostic-jobs",
    "https://example.invalid/functions/v1/network-health",
    "http://127.0.0.1:3402/api/runner/traffic",
    "http://127.0.0.1:3402/api/runner/network-health",
    "http://127.0.0.1:3402/api/runner/network-health",
    "https://example.invalid/functions/v1/network-discovery",
    "https://example.invalid/functions/v1/device-inspector",
    "http://127.0.0.1:3402/api/runner/managed-telemetry",
    "http://127.0.0.1:3402/api/runner/managed-telemetry",
  ]);
  for (const request of requests.slice(2, 5).concat(requests.slice(7))) {
    assert.equal("apikey" in request.headers, false);
    assert.equal(request.headers.Authorization, `Bearer ${LOCAL_TOKEN}`);
  }
});

test("empty local config is a controlled recurring-data-plane Edge rollback mode", async (t) => {
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ data: null }), { status: 200 });
  });
  const client = new BackendClient("https://example.invalid", "test-service-key");
  await client.healthTargets("runner-test");
  await client.claimTraffic("runner-test");
  await client.managedTelemetryTargets("runner-test");
  assert.deepEqual(urls, [
    "https://example.invalid/functions/v1/network-health",
    "https://example.invalid/functions/v1/traffic-live",
    "https://example.invalid/functions/v1/managed-telemetry",
  ]);
});

test("local authority blocks legacy Edge control-plane mutations before fetch", async (t) => {
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ data: null }), { status: 200 });
  });
  const client = new BackendClient("https://example.invalid", "test-service-key", {
    url: "http://127.0.0.1:3402", token: LOCAL_TOKEN,
  }, "local_postgres");
  for (const action of [
    () => client.claim("runner-test"),
    () => client.claimManualPing("runner-test"),
    () => client.claimDiscovery("runner-test"),
    () => client.claimInspection("runner-test"),
  ]) {
    await assert.rejects(action(), /Legacy Supabase application mutation is blocked/);
  }
  assert.deepEqual(urls, []);
  await client.heartbeat(HEARTBEAT);
  assert.deepEqual(urls, ["http://127.0.0.1:3402/api/runner/heartbeat"]);
});

test("local authority cannot fall back to recurring Edge endpoint", async (t) => {
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url) => { urls.push(String(url)); return new Response("{}", { status: 200 }); });
  const client = new BackendClient("https://example.invalid", "test-service-key", null, "local_postgres");
  await assert.rejects(client.healthTargets("runner-test"), /Legacy Supabase application mutation is blocked/);
  assert.deepEqual(urls, []);
  assert.throws(() => new BackendClient("https://example.invalid", "test-service-key", null, "unknown"),
    /Persistence authority is invalid/);
});

test("local recurring failure never falls back to the Edge Function", async (t) => {
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ error: { code: "TRAFFIC_PERSISTENCE_FAILED", message: "Traffic request failed" } }), { status: 500 });
  });
  const client = new BackendClient("https://example.invalid", "test-service-key", { url: "http://127.0.0.1:3402", token: LOCAL_TOKEN });
  await assert.rejects(client.claimTraffic("runner-test"), /Local Traffic backend request failed with HTTP 500/);
  assert.deepEqual(urls, ["http://127.0.0.1:3402/api/runner/traffic"]);
});

test("Windows runner exposes local Traffic settings to WSL without replacing existing WSLENV", () => {
  const environment = { WSLENV: "EXISTING/u" };
  const config = loadLocalBackendConfig({ LOCAL_BACKEND_URL: "http://localhost:3402", LOCAL_BACKEND_TOKEN: LOCAL_TOKEN });
  exposeLocalBackendToWsl(config, environment, "win32");
  assert.equal(environment.LOCAL_BACKEND_URL, "http://localhost:3402");
  assert.equal(environment.LOCAL_BACKEND_TOKEN, LOCAL_TOKEN);
  assert.equal(environment.WSLENV, "EXISTING/u:LOCAL_BACKEND_URL:LOCAL_BACKEND_TOKEN");
  exposeLocalBackendToWsl(config, environment, "win32");
  assert.equal(environment.WSLENV, "EXISTING/u:LOCAL_BACKEND_URL:LOCAL_BACKEND_TOKEN");
});

test("local heartbeat configuration rejects partial, unsafe, and public endpoints", () => {
  for (const environment of [
    { LOCAL_BACKEND_URL: "http://127.0.0.1:3402" },
    { LOCAL_BACKEND_TOKEN: LOCAL_TOKEN },
    { LOCAL_BACKEND_URL: "https://public.example", LOCAL_BACKEND_TOKEN: LOCAL_TOKEN },
    { LOCAL_BACKEND_URL: "http://127.0.0.1:3402/path", LOCAL_BACKEND_TOKEN: LOCAL_TOKEN },
    { LOCAL_BACKEND_URL: "http://127.0.0.1:3402", LOCAL_BACKEND_TOKEN: "short" },
  ]) {
    assert.throws(() => loadLocalHeartbeatConfig(environment), /Local heartbeat configuration is invalid/);
  }
});

test("managed telemetry publish success remains unchanged", async (t) => {
  let request = null;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    request = JSON.parse(options.body);
    return new Response(JSON.stringify({ data: { devices: 1, interfaces: 0, events: 0 } }), { status: 200 });
  });
  const client = new BackendClient("https://example.invalid", "test-service-key");
  const result = await client.publishManagedTelemetry("runner-test", DEVICE, [], []);
  assert.deepEqual(result, { devices: 1, interfaces: 0, events: 0 });
  assert.deepEqual(request, { action: "publish", runner_id: "runner-test", device: DEVICE, interfaces: [], transitions: [], observed_hosts: [] });
});

test("manual ping backend methods use the existing network-health transport with bounded fields", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ data: null }), { status: 200 });
  });
  const client = new BackendClient("https://example.invalid", "test-service-key");
  const pingId = "11111111-1111-4111-8111-111111111111";
  await client.claimManualPing("runner-test");
  await client.completeManualPing("runner-test", pingId, { ok: true, latency_ms: 4 });
  await client.failManualPing("runner-test", pingId, "MANUAL_PING_FAILED");
  assert.deepEqual(requests, [
    { action: "claim_manual_ping", runner_id: "runner-test" },
    { action: "complete_manual_ping", runner_id: "runner-test", ping_id: pingId, result: { ok: true, latency_ms: 4 } },
    { action: "fail_manual_ping", runner_id: "runner-test", ping_id: pingId, error_code: "MANUAL_PING_FAILED" },
  ]);
});

test("managed telemetry 4xx preserves bounded safe status and backend code", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    code: "INTERFACE_PAYLOAD_INVALID",
    error: "Managed telemetry interface payload is invalid",
  }), { status: 400 }));
  const client = new BackendClient("https://example.invalid", "test-service-key");
  await assert.rejects(
    client.publishManagedTelemetry("runner-test", DEVICE, [], []),
    (error) => {
      assert.equal(error.code, "MANAGED_TELEMETRY_PUBLISH_FAILED");
      assert.equal(error.status, 400);
      assert.equal(error.backendCode, "INTERFACE_PAYLOAD_INVALID");
      assert.equal(error.backendMessage, "Managed telemetry interface payload is invalid");
      return true;
    },
  );
});

test("managed telemetry 5xx preserves bounded safe status and category", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    category: "device_upsert_failed",
    error: "Latest managed device state could not be stored",
  }), { status: 500 }));
  const client = new BackendClient("https://example.invalid", "test-service-key");
  await assert.rejects(
    client.publishManagedTelemetry("runner-test", DEVICE, [], []),
    (error) => error.status === 500 && error.backendCode === "device_upsert_failed",
  );
});

test("arbitrary response content is not surfaced", () => {
  const error = managedTelemetryPublishError(400, {
    error: "arbitrary raw backend response",
    debug: { request_body: DEVICE, stack: "private internals" },
  });
  const diagnostic = managedTelemetryPublishDiagnostic(error);
  assert.equal(diagnostic, "code=MANAGED_TELEMETRY_PUBLISH_FAILED status=400");
  assert.doesNotMatch(error.message, /arbitrary|request_body|private internals/);
  assert.equal("payload" in error, false);
});

test("secret-shaped backend content is not surfaced", () => {
  const error = managedTelemetryPublishError(403, {
    code: "COMMUNITY_SECRET_INVALID",
    error: "community=private-value authorization=Bearer private-token",
  });
  const diagnostic = managedTelemetryPublishDiagnostic(error);
  assert.equal(diagnostic, "code=MANAGED_TELEMETRY_PUBLISH_FAILED status=403");
  assert.doesNotMatch(`${error.message} ${diagnostic}`, /private-value|private-token|community|authorization|bearer/i);
});
