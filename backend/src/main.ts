import { BackendConfigurationError, loadBackendConfig } from "./config.js";
import { Pool } from "pg";
import { PostgresAssetRepository, ASSET_QUERY_TIMEOUT_MS } from "./assets/repository.js";
import { SupabaseAssetEvidenceSource } from "./assets/evidence.js";
import { BoundedAssetSynchronizer } from "./assets/ingestion.js";
import { SupabaseManagedTelemetryRepository } from "./managed-telemetry/repository.js";
import { SupabaseNetworkHealthRepository } from "./network-health/repository.js";
import { SupabaseTrafficRepository } from "./traffic/repository.js";
import { buildServer, createGracefulShutdown } from "./server.js";
import { SupabaseRunnerHeartbeatRepository } from "./runner-heartbeat/repository.js";

async function main(): Promise<void> {
  const config = loadBackendConfig();
  const heartbeatRepository = new SupabaseRunnerHeartbeatRepository(
    config.supabaseUrl,
    config.supabaseServiceRoleKey,
  );
  const healthRepository = new SupabaseNetworkHealthRepository(config.supabaseUrl, config.supabaseServiceRoleKey);
  const trafficRepository = new SupabaseTrafficRepository(config.supabaseUrl, config.supabaseServiceRoleKey);
  const telemetryRepository = new SupabaseManagedTelemetryRepository(config.supabaseUrl, config.supabaseServiceRoleKey);
  const assetPool = config.assets ? new Pool({
    connectionString: config.assets.databaseUrl,
    max: 5,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: ASSET_QUERY_TIMEOUT_MS,
    query_timeout: ASSET_QUERY_TIMEOUT_MS + 1_000,
    application_name: "jhc-netops-backend-assets",
  }) : null;
  const assetRepository = assetPool ? new PostgresAssetRepository(assetPool) : null;
  const assetSynchronizer = assetRepository
    ? new BoundedAssetSynchronizer(
      new SupabaseAssetEvidenceSource(config.supabaseUrl, config.supabaseServiceRoleKey),
      assetRepository,
    )
    : null;
  const server = buildServer({
    ...(config.assets && assetRepository ? {
      assets: {
        token: config.assets.frontendApiToken,
        repository: assetRepository,
        ...(assetSynchronizer ? { synchronizer: assetSynchronizer } : {}),
      },
    } : {}),
    runnerHeartbeat: { token: config.runnerApiToken, repository: heartbeatRepository },
    networkHealth: { token: config.runnerApiToken, repository: healthRepository },
    traffic: { token: config.runnerApiToken, repository: trafficRepository },
    managedTelemetry: { token: config.runnerApiToken, repository: telemetryRepository },
  });
  if (assetPool) server.addHook("onClose", async () => assetPool.end());
  const shutdown = createGracefulShutdown(server);
  const handleSignal = (signal: string) => {
    void shutdown(signal).catch(() => {
      process.stderr.write(`${JSON.stringify({
        level: "error",
        code: "BACKEND_SHUTDOWN_FAILED",
        message: "Backend failed to stop cleanly",
      })}\n`);
      process.exitCode = 1;
    });
  };

  process.once("SIGINT", () => handleSignal("SIGINT"));
  process.once("SIGTERM", () => handleSignal("SIGTERM"));

  try {
    await server.listen({ host: config.host, port: config.port });
  } catch (error) {
    await server.close().catch(() => undefined);
    throw error;
  }
}

try {
  await main();
} catch (error) {
  const configurationFailure = error instanceof BackendConfigurationError;
  process.stderr.write(`${JSON.stringify({
    level: "error",
    code: configurationFailure ? error.code : "BACKEND_STARTUP_FAILED",
    message: configurationFailure ? error.message : "Backend failed to start",
  })}\n`);
  process.exitCode = 1;
}
