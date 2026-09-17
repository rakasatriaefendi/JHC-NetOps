import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolve } from "node:path";

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
  PERSISTENCE_AUTHORITY: "supabase",
  FRONTEND_API_TOKEN: "f".repeat(32),
  APPLICATION_DATABASE_URL: "postgresql://jhc_netops_app:strong-local-password@127.0.0.1:5433/jhc_netops",
  DATABASE_URL: "postgresql://jhc_netops_app:strong-local-password@127.0.0.1:5433/jhc_netops",
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
    frontendApiToken: VALID_ENVIRONMENT.FRONTEND_API_TOKEN,
    persistenceAuthority: "supabase",
    candidateReadOnly: false,
    supabaseUrl: VALID_ENVIRONMENT.SUPABASE_URL,
    supabaseServiceRoleKey: VALID_ENVIRONMENT.SUPABASE_SERVICE_ROLE_KEY,
    applicationDatabaseUrl: VALID_ENVIRONMENT.APPLICATION_DATABASE_URL,
    assets: {
      databaseUrl: VALID_ENVIRONMENT.DATABASE_URL,
      frontendApiToken: VALID_ENVIRONMENT.FRONTEND_API_TOKEN,
      reportBrandingDir: resolve("data/report-branding"),
      medicalDueSoonDays: 30,
      scan: {
        networks: [], helperPath: "/usr/local/libexec/jhc-netops-asset-scan", concurrency: 4,
        hostTimeoutMs: 45_000, discoveryTimeoutMs: 120_000,
      },
    },
  });
});

test("application persistence authority is explicit and rejects missing or unknown modes", () => {
  assert.equal(loadBackendConfig(VALID_ENVIRONMENT).persistenceAuthority, "supabase");
  assert.equal(loadBackendConfig({ ...VALID_ENVIRONMENT, PERSISTENCE_AUTHORITY: "local_postgres" }).persistenceAuthority, "local_postgres");
  const missingAuthority = Object.fromEntries(
    Object.entries(VALID_ENVIRONMENT).filter(([name]) => name !== "PERSISTENCE_AUTHORITY"),
  );
  assert.throws(() => loadBackendConfig(missingAuthority), /PERSISTENCE_AUTHORITY/);
  assert.throws(
    () => loadBackendConfig({ ...VALID_ENVIRONMENT, PERSISTENCE_AUTHORITY: "fallback" }),
    (error: unknown) => error instanceof Error && /PERSISTENCE_AUTHORITY/.test(error.message),
  );
});

test("P13 candidate read-only mode is explicit and cannot use local authority", () => {
  assert.equal(loadBackendConfig({
    ...VALID_ENVIRONMENT,
    P13_CANDIDATE_READ_ONLY: "true",
  }).candidateReadOnly, true);
  assert.equal(loadBackendConfig({
    ...VALID_ENVIRONMENT,
    P13_CANDIDATE_READ_ONLY: "false",
  }).candidateReadOnly, false);
  assert.throws(() => loadBackendConfig({
    ...VALID_ENVIRONMENT,
    P13_CANDIDATE_READ_ONLY: "1",
  }), /P13_CANDIDATE_READ_ONLY/);
  assert.throws(() => loadBackendConfig({
    ...VALID_ENVIRONMENT,
    PERSISTENCE_AUTHORITY: "local_postgres",
    P13_CANDIDATE_READ_ONLY: "true",
  }), /cannot be enabled with local_postgres/);
});

test("candidate mode skips mutating asset startup and read-side synchronization", () => {
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.match(main, /assetRepository && !config\.candidateReadOnly/);
  assert.match(main, /!config\.candidateReadOnly && scanNetworkManager && config\.assets/);
  assert.match(main, /!config\.candidateReadOnly && assetScanController/);
  assert.match(main, /candidateReadOnly: config\.candidateReadOnly/);
});

test("candidate server keeps health readable and blocks mutations before repositories", async () => {
  let repositoryCalls = 0;
  const server = buildServer({
    logger: false,
    candidateReadOnly: true,
    runnerHeartbeat: {
      token: "r".repeat(32),
      repository: {
        async upsertHeartbeat() { repositoryCalls += 1; throw new Error("must not run"); },
        async expireStaleTrafficSessions() { repositoryCalls += 1; },
      },
    },
  });
  try {
    const health = await server.inject({ method: "GET", url: "/healthz" });
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), {
      status: "ok",
      service: BACKEND_SERVICE_NAME,
      candidate_read_only: true,
    });
    const mutation = await server.inject({
      method: "POST",
      url: "/api/runner/heartbeat",
      headers: { authorization: `Bearer ${"r".repeat(32)}` },
      payload: {},
    });
    assert.equal(mutation.statusCode, 503);
    assert.deepEqual(mutation.json(), {
      error: {
        code: "CANDIDATE_READ_ONLY",
        message: "Candidate runtime does not accept mutating requests",
      },
    });
    assert.equal(repositoryCalls, 0);
  } finally {
    await server.close();
  }
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
  assert.equal(configured.assets?.reportBrandingDir, resolve("data/report-branding"));
  assert.equal(configured.assets?.medicalDueSoonDays, 30);

  const medicalThreshold = loadBackendConfig({
    ...VALID_ENVIRONMENT,
    DATABASE_URL: "postgresql://jhc_netops_app:strong-local-password@127.0.0.1:5433/jhc_netops",
    FRONTEND_API_TOKEN: "f".repeat(32),
    MEDICAL_DUE_SOON_DAYS: "45",
  });
  assert.equal(medicalThreshold.assets?.medicalDueSoonDays, 45);

  const branded = loadBackendConfig({
    ...VALID_ENVIRONMENT,
    DATABASE_URL: "postgresql://jhc_netops_app:strong-local-password@127.0.0.1:5433/jhc_netops",
    FRONTEND_API_TOKEN: "f".repeat(32),
    REPORT_BRANDING_DIR: "/var/www/jhc/jhc_noc/shared/branding",
  });
  assert.equal(branded.assets?.reportBrandingDir, resolve("/var/www/jhc/jhc_noc/shared/branding"));

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
    { ...VALID_ENVIRONMENT, DATABASE_URL: "postgresql://jhc_netops_app:password@127.0.0.1:5433/jhc_netops", FRONTEND_API_TOKEN: undefined },
    { ...VALID_ENVIRONMENT, FRONTEND_API_TOKEN: "f".repeat(32), DATABASE_URL: undefined },
    { ...VALID_ENVIRONMENT, DATABASE_URL: "postgresql://jhc_netops_app:password@127.0.0.1:5432/jhc_netops", FRONTEND_API_TOKEN: "f".repeat(32) },
    { ...VALID_ENVIRONMENT, DATABASE_URL: "postgresql://jhc_netops_app:password@127.0.0.1:5433/mercure", FRONTEND_API_TOKEN: "f".repeat(32) },
    { ...VALID_ENVIRONMENT, DATABASE_URL: "postgresql://jhc_netops_app:password@127.0.0.1:5433/montblanc", FRONTEND_API_TOKEN: "f".repeat(32) },
    { ...VALID_ENVIRONMENT, DATABASE_URL: "postgresql://postgres:password@127.0.0.1:5433/jhc_netops", FRONTEND_API_TOKEN: "f".repeat(32) },
    { ...VALID_ENVIRONMENT, DATABASE_URL: "postgresql://jhc_netops_app:password@192.168.1.130:5433/jhc_netops", FRONTEND_API_TOKEN: "f".repeat(32) },
    { ...VALID_ENVIRONMENT, DATABASE_URL: "postgresql://jhc_netops_app:password@127.0.0.1:5433/jhc_netops", FRONTEND_API_TOKEN: "f".repeat(32), ASSET_SCAN_NETWORKS: "8.8.8.0/24" },
    { ...VALID_ENVIRONMENT, DATABASE_URL: "postgresql://jhc_netops_app:password@127.0.0.1:5433/jhc_netops", FRONTEND_API_TOKEN: "f".repeat(32), ASSET_SCAN_CONCURRENCY: "9" },
    { ...VALID_ENVIRONMENT, DATABASE_URL: "postgresql://jhc_netops_app:password@127.0.0.1:5433/jhc_netops", FRONTEND_API_TOKEN: "f".repeat(32), MEDICAL_DUE_SOON_DAYS: "181" },
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
