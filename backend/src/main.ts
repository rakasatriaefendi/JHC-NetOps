import { BackendConfigurationError, loadBackendConfig } from "./config.js";
import { Pool } from "pg";
import { PostgresAssetRepository, ASSET_QUERY_TIMEOUT_MS } from "./assets/repository.js";
import { PostgresAssetChangeRepository } from "./assets/change-repository.js";
import { SupabaseAssetEvidenceSource } from "./assets/evidence.js";
import { BoundedAssetSynchronizer } from "./assets/ingestion.js";
import { AssetScanController } from "./assets/scan-controller.js";
import { PrivilegedNmapExecutor } from "./assets/scan-executor.js";
import { PostgresAssetScanRepository } from "./assets/scan-repository.js";
import { PostgresAssetReportRepository } from "./assets/report-repository.js";
import { LinuxIpRouteAdapter } from "./assets/scan-network-adapter.js";
import { ScanNetworkManager } from "./assets/scan-network-manager.js";
import { PostgresScanNetworkRepository } from "./assets/scan-network-repository.js";
import { SupabaseManagedTelemetryRepository } from "./managed-telemetry/repository.js";
import { SupabaseNetworkHealthRepository } from "./network-health/repository.js";
import { SupabaseTrafficRepository } from "./traffic/repository.js";
import { SupabaseRunnerHeartbeatRepository } from "./runner-heartbeat/repository.js";
import { buildServer, createGracefulShutdown } from "./server.js";
import { FileReportBrandingStore } from "./report-branding/storage.js";
import { PostgresMedicalEquipmentRepository } from "./medical-equipment/repository.js";
import { selectApplicationPersistence } from "./persistence/authority.js";
import { type ApplicationRepositories, type SupabaseApplicationRepositories } from "./persistence/application-repositories.js";
import { PoolPostgresQuery } from "./persistence/postgres-query.js";
import { PostgresProfilesRepository } from "./persistence/profiles.js";
import { PostgresNetworkInventoryRepository } from "./persistence/inventory.js";
import { PostgresNetworkHealthRepository } from "./persistence/network-health.js";
import { PostgresManagedTelemetryRepository } from "./persistence/managed-telemetry.js";
import { PostgresTrafficRepository } from "./persistence/traffic.js";
import { PostgresRunnerHeartbeatRepository } from "./persistence/runner-heartbeat.js";
import { PostgresDiagnosticJobsRepository } from "./persistence/diagnostic-jobs.js";
import { PostgresNetworkDiscoveryRepository } from "./persistence/network-discovery.js";
import { PostgresDeviceInspectionRepository } from "./persistence/device-inspection.js";
import { PostgresNetworkHealthPingJobsRepository } from "./persistence/network-health-ping-jobs.js";
import { PostgresBandwidthMeasurementsRepository } from "./persistence/bandwidth-measurements.js";
import { PostgresHopMeasurementsRepository } from "./persistence/hop-measurements.js";
import { PostgresTrafficMetricsRepository } from "./persistence/traffic-metrics.js";
import { PostgresEventsRepository } from "./persistence/events.js";
import { PostgresOutboxRepository } from "./persistence/outbox.js";
import { PostgresCutoverCanaryRepository } from "./persistence/cutover-canary.js";
import { SupabaseShadowProjector } from "./persistence/shadow-projector.js";
import { LocalRealtimeBroker } from "./realtime/broker.js";
import { PostgresRealtimeListener, postgresRealtimeConnectionFactory } from "./realtime/listener.js";
import { PostgresLocalAuthRepository } from "./local-auth/repository.js";

async function main(): Promise<void> {
  const config = loadBackendConfig();
  const shadowProjector: { current: SupabaseShadowProjector | null } = { current: null };
  const realtimeBroker = new LocalRealtimeBroker();
  const realtimeListener: { current: PostgresRealtimeListener | null } = { current: null };
  const applicationRepositories = selectApplicationPersistence<ApplicationRepositories | SupabaseApplicationRepositories>(config.persistenceAuthority, {
    supabase: () => ({
      heartbeat: new SupabaseRunnerHeartbeatRepository(config.supabaseUrl, config.supabaseServiceRoleKey),
      health: new SupabaseNetworkHealthRepository(config.supabaseUrl, config.supabaseServiceRoleKey),
      traffic: new SupabaseTrafficRepository(config.supabaseUrl, config.supabaseServiceRoleKey),
      telemetry: new SupabaseManagedTelemetryRepository(config.supabaseUrl, config.supabaseServiceRoleKey),
    }),
    localPostgres: () => {
      const appPool = new Pool({
        connectionString: config.applicationDatabaseUrl,
        max: 10,
        connectionTimeoutMillis: 3_000,
        idleTimeoutMillis: 30_000,
        statement_timeout: 15_000,
        query_timeout: 16_000,
        application_name: "jhc-netops-backend-application",
      });
      const query = new PoolPostgresQuery(appPool);
      const outbox = new PostgresOutboxRepository(query);
      const cutoverCanary = new PostgresCutoverCanaryRepository(query);
      const repos = {
        heartbeat: new PostgresRunnerHeartbeatRepository(query),
        health: new PostgresNetworkHealthRepository(query),
        traffic: new PostgresTrafficRepository(query),
        telemetry: new PostgresManagedTelemetryRepository(query),
        diagnosticJobs: new PostgresDiagnosticJobsRepository(query),
        networkDiscovery: new PostgresNetworkDiscoveryRepository(query),
        deviceInspection: new PostgresDeviceInspectionRepository(query),
        pingJobs: new PostgresNetworkHealthPingJobsRepository(query),
        bandwidth: new PostgresBandwidthMeasurementsRepository(query),
        hopMeasurements: new PostgresHopMeasurementsRepository(query),
        trafficMetrics: new PostgresTrafficMetricsRepository(query),
        events: new PostgresEventsRepository(query),
        profiles: new PostgresProfilesRepository(query),
        inventory: new PostgresNetworkInventoryRepository(query),
        outbox,
        cutoverCanary,
        localAuth: new PostgresLocalAuthRepository(query),
        _pool: appPool,
      };
      shadowProjector.current = new SupabaseShadowProjector(outbox, config.supabaseUrl, config.supabaseServiceRoleKey);
      realtimeListener.current = new PostgresRealtimeListener(
        postgresRealtimeConnectionFactory(config.applicationDatabaseUrl),
        realtimeBroker,
      );
      return repos;
    },
  });
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
  const reportBranding = config.assets ? new FileReportBrandingStore(config.assets.reportBrandingDir) : null;
  const assetSynchronizer = assetRepository && !config.candidateReadOnly
    ? new BoundedAssetSynchronizer(
      new SupabaseAssetEvidenceSource(config.supabaseUrl, config.supabaseServiceRoleKey),
      assetRepository,
    )
    : null;
  const scanNetworkManager = assetPool && config.assets
    ? new ScanNetworkManager(new PostgresScanNetworkRepository(assetPool), new LinuxIpRouteAdapter())
    : null;
  if (!config.candidateReadOnly && scanNetworkManager && config.assets) {
    await scanNetworkManager.initialize(config.assets.scan.networks);
  }
  const assetScanController = assetPool && config.assets && scanNetworkManager
    ? new AssetScanController(
      new PostgresAssetScanRepository(assetPool),
      new PrivilegedNmapExecutor(config.assets.scan.helperPath),
      scanNetworkManager,
      config.assets.scan.concurrency,
      config.assets.scan.hostTimeoutMs,
      config.assets.scan.discoveryTimeoutMs,
    )
    : null;
  if (!config.candidateReadOnly && assetScanController) await assetScanController.initialize();
  const appPool = config.persistenceAuthority === "local_postgres" && "_pool" in applicationRepositories
    ? (applicationRepositories as Record<string, unknown>)._pool as Pool
    : null;
  const localRepos = config.persistenceAuthority === "local_postgres" ? applicationRepositories as ApplicationRepositories : null;

  const buildServerOptions: Record<string, unknown> = {
    candidateReadOnly: config.candidateReadOnly,
    runnerHeartbeat: { token: config.runnerApiToken, repository: applicationRepositories.heartbeat },
    networkHealth: { token: config.runnerApiToken, repository: applicationRepositories.health },
    traffic: { token: config.runnerApiToken, repository: applicationRepositories.traffic },
    managedTelemetry: { token: config.runnerApiToken, repository: applicationRepositories.telemetry },
  };

  if (config.assets && assetRepository) {
    buildServerOptions.assets = {
      token: config.assets.frontendApiToken,
      repository: assetRepository,
      ...(assetSynchronizer ? { synchronizer: assetSynchronizer } : {}),
    };
  }
  if (config.assets && assetPool) {
    buildServerOptions.assetChanges = { token: config.assets.frontendApiToken, repository: new PostgresAssetChangeRepository(assetPool) };
    buildServerOptions.assetReport = {
      token: config.assets.frontendApiToken,
      repository: new PostgresAssetReportRepository(assetPool),
      ...(reportBranding ? { branding: reportBranding } : {}),
      ...(assetSynchronizer ? { synchronizer: assetSynchronizer } : {}),
    };
    buildServerOptions.medicalEquipment = {
      token: config.assets.frontendApiToken,
      repository: new PostgresMedicalEquipmentRepository(assetPool),
      dueSoonDays: config.assets.medicalDueSoonDays,
    };
  }
  if (config.assets && assetScanController) {
    buildServerOptions.assetScan = { token: config.assets.frontendApiToken, controller: assetScanController };
  }
  if (config.assets && scanNetworkManager) {
    buildServerOptions.scanNetworks = { token: config.assets.frontendApiToken, manager: scanNetworkManager };
  }
  if (config.assets && reportBranding) {
    buildServerOptions.reportBranding = { token: config.assets.frontendApiToken, store: reportBranding };
  }
  if (localRepos) {
    buildServerOptions.networkDiscovery = {
      token: config.runnerApiToken,
      repository: localRepos.networkDiscovery,
    };
    buildServerOptions.deviceInspection = {
      token: config.runnerApiToken,
      repository: localRepos.deviceInspection,
    };
    buildServerOptions.application = {
      token: config.frontendApiToken,
      profiles: localRepos.profiles,
      inventory: localRepos.inventory,
      diagnosticJobs: localRepos.diagnosticJobs,
      networkDiscovery: localRepos.networkDiscovery,
      deviceInspection: localRepos.deviceInspection,
      pingJobs: localRepos.pingJobs,
      bandwidth: localRepos.bandwidth,
      hopMeasurements: localRepos.hopMeasurements,
      trafficMetrics: localRepos.trafficMetrics,
      events: localRepos.events,
      traffic: localRepos.traffic,
      outbox: localRepos.outbox,
      ...(shadowProjector.current ? { shadowProjector: shadowProjector.current } : {}),
      cutoverCanary: localRepos.cutoverCanary,
    };
    buildServerOptions.realtime = { token: config.frontendApiToken, broker: realtimeBroker };
    buildServerOptions.localAuth = { token: config.frontendApiToken, repository: localRepos.localAuth };
  }

  const server = buildServer(buildServerOptions as Parameters<typeof buildServer>[0]);
  if (assetPool) server.addHook("onClose", async () => {
    try { if (assetScanController) await assetScanController.shutdown(); } finally { await assetPool.end(); }
  });
  if (appPool) server.addHook("onClose", async () => {
    try {
      await realtimeListener.current?.stop();
      realtimeBroker.close();
      await shadowProjector.current?.stop();
    } finally { await appPool.end(); }
  });
  const shutdown = createGracefulShutdown(server);
  const handleSignal = (signal: string) => {
    void shutdown(signal).catch(() => {
      process.stderr.write(`${JSON.stringify({ level: "error", code: "BACKEND_SHUTDOWN_FAILED", message: "Backend failed to stop cleanly" })}\n`);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", () => handleSignal("SIGINT"));
  process.once("SIGTERM", () => handleSignal("SIGTERM"));
  shadowProjector.current?.start();
  realtimeListener.current?.start();
  try { await server.listen({ host: config.host, port: config.port }); }
  catch (error) { await server.close().catch(() => undefined); throw error; }
}

try { await main(); }
catch (error) {
  const configurationFailure = error instanceof BackendConfigurationError;
  process.stderr.write(`${JSON.stringify({ level: "error", code: configurationFailure ? error.code : "BACKEND_STARTUP_FAILED", message: configurationFailure ? error.message : "Backend failed to start" })}\n`);
  process.exitCode = 1;
}
