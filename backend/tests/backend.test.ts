import assert from "node:assert/strict";
import test from "node:test";

import { BackendConfigurationError, loadBackendConfig } from "../src/config.js";
import {
  BACKEND_SERVICE_NAME,
  REQUEST_BODY_LIMIT_BYTES,
  buildServer,
  createGracefulShutdown,
} from "../src/server.js";

test("GET /healthz returns the bounded service health response", async () => {
  const server = buildServer({ logger: false });
  const response = await server.inject({ method: "GET", url: "/healthz" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok", service: BACKEND_SERVICE_NAME });
  assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
  await server.close();
});

test("unsupported routes return a bounded 404 without implementation details", async () => {
  const server = buildServer({ logger: false });
  const response = await server.inject({ method: "GET", url: "/unsupported?token=do-not-reflect" });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), { error: { code: "NOT_FOUND", message: "Route not found" } });
  assert.ok(response.body.length < 256);
  assert.doesNotMatch(response.body, /token|stack|filesystem|supabase/i);
  await server.close();
});

test("configuration defaults to the private loopback endpoint", () => {
  assert.deepEqual(loadBackendConfig({}), { host: "127.0.0.1", port: 3402 });
});

test("invalid or publicly exposed configuration is rejected safely", () => {
  for (const environment of [
    { HOST: "0.0.0.0" },
    { HOST: "example.internal" },
    { PORT: "0" },
    { PORT: "65536" },
    { PORT: "3402x" },
  ]) {
    assert.throws(
      () => loadBackendConfig(environment),
      (error: unknown) => error instanceof BackendConfigurationError
        && error.code === "BACKEND_CONFIGURATION_INVALID"
        && !JSON.stringify(error).includes(Object.values(environment)[0] ?? "never"),
    );
  }
});

test("health output never reflects configuration or secret-shaped environment values", async () => {
  const environment = {
    HOST: "127.0.0.1",
    PORT: "3402",
    SUPABASE_SERVICE_ROLE_KEY: "test-secret-that-must-not-appear",
  };
  const config = loadBackendConfig(environment);
  const server = buildServer({ logger: false });
  const response = await server.inject({ method: "GET", url: "/healthz" });

  assert.deepEqual(config, { host: "127.0.0.1", port: 3402 });
  assert.doesNotMatch(response.body, /127\.0\.0\.1|3402|supabase|secret|key/i);
  await server.close();
});

test("request body handling remains bounded", async () => {
  const server = buildServer({ logger: false });
  assert.equal(server.initialConfig.bodyLimit, REQUEST_BODY_LIMIT_BYTES);
  const response = await server.inject({
    method: "POST",
    url: "/unsupported",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ value: "x".repeat(REQUEST_BODY_LIMIT_BYTES) }),
  });

  assert.equal(response.statusCode, 413);
  assert.deepEqual(response.json(), {
    error: { code: "PAYLOAD_TOO_LARGE", message: "Request payload is too large" },
  });
  await server.close();
});

test("server starts on loopback and graceful shutdown is idempotent", async () => {
  const server = buildServer({ logger: false });
  const address = await server.listen({ host: "127.0.0.1", port: 0 });
  assert.match(address, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(server.server.listening, true);

  const shutdown = createGracefulShutdown(server);
  const first = shutdown("TEST");
  const second = shutdown("TEST_DUPLICATE");
  assert.equal(first, second);
  await first;
  assert.equal(server.server.listening, false);
});
