import assert from "node:assert/strict";
import test from "node:test";

import { BackendConfigurationError, loadBackendConfig } from "../src/config.js";
import {
  BACKEND_SERVICE_NAME,
  REQUEST_BODY_LIMIT_BYTES,
  buildServer,
  createGracefulShutdown,
} from "../src/server.js";

const VALID_ENVIRONMENT = {
  RUNNER_API_TOKEN: "r".repeat(32),
  SUPABASE_URL: "https://project.example.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "s".repeat(32),
};

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
  assert.deepEqual(loadBackendConfig(VALID_ENVIRONMENT), {
    host: "127.0.0.1",
    port: 3402,
    runnerApiToken: VALID_ENVIRONMENT.RUNNER_API_TOKEN,
    supabaseUrl: VALID_ENVIRONMENT.SUPABASE_URL,
    supabaseServiceRoleKey: VALID_ENVIRONMENT.SUPABASE_SERVICE_ROLE_KEY,
    assets: null,
  });
});

test("asset database configuration is optional, paired, and isolated from PostgreSQL 16/main", () => {
  const configured = loadBackendConfig({
    ...VALID_ENVIRONMENT,
    DATABASE_URL: "postgresql://jhc_netops_app:strong-local-password@127.0.0.1:5433/jhc_netops",
    FRONTEND_API_TOKEN: "f".repeat(32),
  });
  assert.equal(configured.assets?.frontendApiToken, "f".repeat(32));
  assert.match(configured.assets?.databaseUrl ?? "", /127\.0\.0\.1:5433\/jhc_netops$/);
  assert.deepEqual(configured.assets?.scan, {
    networks: [], helperPath: "/usr/local/libexec/jhc-netops-asset-scan", concurrency: 4,
    hostTimeoutMs: 45_000, discoveryTimeoutMs: 120_000,
  });

  const scanner = loadBackendConfig({
    ...VALID_ENVIRONMENT,
    DATABASE_URL: "postgresql://jhc_netops_app:strong-local-password@127.0.0.1:5433/jhc_netops",
    FRONTEND_API_TOKEN: "f".repeat(32),
    ASSET_SCAN_NETWORKS: "192.168.1.0/24,10.20.0.0/22",
    ASSET_SCAN_CONCURRENCY: "8",
  });
  assert.deepEqual(scanner.assets?.scan.networks, ["192.168.1.0/24", "10.20.0.0/22"]);
  assert.equal(scanner.assets?.scan.concurrency, 8);

  for (const environment of [
    { ...VALID_ENVIRONMENT, DATABASE_URL: "postgresql://jhc_netops_app:password@127.0.0.1:5433/jhc_netops" },
    { ...VALID_ENVIRONMENT, FRONTEND_API_TOKEN: "f".repeat(32) },
    { ...VALID_ENVIRONMENT, DATABASE_URL: "postgresql://jhc_netops_app:password@127.0.0.1:5432/jhc_netops", FRONTEND_API_TOKEN: "f".repeat(32) },
    { ...VALID_ENVIRONMENT, DATABASE_URL: "postgresql://jhc_netops_app:password@127.0.0.1:5433/mercure", FRONTEND_API_TOKEN: "f".repeat(32) },
    { ...VALID_ENVIRONMENT, DATABASE_URL: "postgresql://jhc_netops_app:password@127.0.0.1:5433/montblanc", FRONTEND_API_TOKEN: "f".repeat(32) },
    { ...VALID_ENVIRONMENT, DATABASE_URL: "postgresql://postgres:password@127.0.0.1:5433/jhc_netops", FRONTEND_API_TOKEN: "f".repeat(32) },
    { ...VALID_ENVIRONMENT, DATABASE_URL: "postgresql://jhc_netops_app:password@192.168.1.130:5433/jhc_netops", FRONTEND_API_TOKEN: "f".repeat(32) },
    { ...VALID_ENVIRONMENT, DATABASE_URL: "postgresql://jhc_netops_app:password@127.0.0.1:5433/jhc_netops", FRONTEND_API_TOKEN: "f".repeat(32), ASSET_SCAN_NETWORKS: "8.8.8.0/24" },
    { ...VALID_ENVIRONMENT, DATABASE_URL: "postgresql://jhc_netops_app:password@127.0.0.1:5433/jhc_netops", FRONTEND_API_TOKEN: "f".repeat(32), ASSET_SCAN_CONCURRENCY: "9" },
  ]) assert.throws(() => loadBackendConfig(environment), BackendConfigurationError);
});

test("invalid or publicly exposed configuration is rejected safely", () => {
  assert.throws(() => loadBackendConfig({}), BackendConfigurationError);
  for (const environment of [
    { ...VALID_ENVIRONMENT, HOST: "0.0.0.0" },
    { ...VALID_ENVIRONMENT, HOST: "example.internal" },
    { ...VALID_ENVIRONMENT, PORT: "0" },
    { ...VALID_ENVIRONMENT, PORT: "65536" },
    { ...VALID_ENVIRONMENT, PORT: "3402x" },
    { ...VALID_ENVIRONMENT, RUNNER_API_TOKEN: "short" },
    { ...VALID_ENVIRONMENT, SUPABASE_URL: "file:///private/database" },
    { ...VALID_ENVIRONMENT, SUPABASE_URL: "http://public.example.invalid" },
    { ...VALID_ENVIRONMENT, SUPABASE_SERVICE_ROLE_KEY: "short" },
    { ...VALID_ENVIRONMENT, RUNNER_API_TOKEN: "REPLACE_WITH_A_RANDOM_SHARED_TOKEN_OF_AT_LEAST_32_CHARACTERS" },
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
    ...VALID_ENVIRONMENT,
    HOST: "127.0.0.1",
    PORT: "3402",
  };
  const config = loadBackendConfig(environment);
  const server = buildServer({ logger: false });
  const response = await server.inject({ method: "GET", url: "/healthz" });

  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 3402);
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
