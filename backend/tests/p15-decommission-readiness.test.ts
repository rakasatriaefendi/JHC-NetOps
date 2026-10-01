import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const SHADOW_TRIGGERS = [
  ["diagnostic_runners", "shadow_diagnostic_runners"],
  ["diagnostic_jobs", "shadow_diagnostic_jobs"],
  ["network_discovery_sessions", "shadow_network_discovery_sessions"],
  ["device_inspection_sessions", "shadow_device_inspection_sessions"],
  ["traffic_live_sessions", "shadow_traffic_live_sessions"],
  ["traffic_live_snapshots", "shadow_traffic_live_snapshots"],
  ["network_targets", "shadow_network_targets"],
  ["network_health_latest", "shadow_network_health_latest"],
  ["network_health_ping_jobs", "shadow_network_health_ping_jobs"],
  ["events", "shadow_events"],
  ["managed_device_latest", "shadow_managed_device_latest"],
  ["managed_interface_latest", "shadow_managed_interface_latest"],
  ["managed_observed_hosts_latest", "shadow_managed_observed_hosts_latest"],
  ["profiles", "shadow_profiles"],
  ["network_nodes", "shadow_network_nodes"],
  ["managed_telemetry_targets", "shadow_managed_telemetry_targets"],
] as const;

test("P15 migration 015 retires exactly the reviewed migration-008 producers", () => {
  const migration008 = source("../migrations/008_application_persistence_outbox.sql");
  const migration015 = source("../migrations/015_retire_shadow_projection.sql");
  const created = [...migration008.matchAll(
    /CREATE TRIGGER (shadow_[a-z_]+) AFTER INSERT OR UPDATE OR DELETE ON public\.([a-z_]+)/g,
  )].map((match) => [match[2], match[1]]);
  const dropped = [...migration015.matchAll(/DROP TRIGGER (shadow_[a-z_]+) ON public\.([a-z_]+);/g)]
    .map((match) => [match[2], match[1]]);

  assert.deepEqual(created, SHADOW_TRIGGERS);
  assert.deepEqual(dropped, SHADOW_TRIGGERS);
  assert.match(migration015, /current_database\(\) <> 'jhc_netops'/);
  assert.match(migration015, /current_setting\('port'\)::integer <> 5433/);
  assert.match(migration015, /host\(inet_server_addr\(\)\) NOT IN \('127\.0\.0\.1', '::1'\)/);
  assert.match(migration015, /current_setting\('server_version_num'\)::integer NOT BETWEEN 160000 AND 169999/);
  assert.match(migration015, /current_setting\('data_directory'\) <> '\/var\/lib\/postgresql\/16\/jhcnetops'/);
  assert.match(migration015, /session_user <> 'postgres'/);
  assert.match(migration015, /to_regclass\('asset\.assets'\) IS NULL/);
  assert.match(migration015, /NOT EXISTS \(SELECT 1 FROM public\.application_schema_migrations WHERE version = 14\)/);
  assert.match(migration015, /SELECT max\(version\) FROM public\.application_schema_migrations\) <> 14/);
  assert.match(migration015, /FULL OUTER JOIN actual USING \(table_name, trigger_name\)/);
  assert.match(migration015, /actual\.function_name <> 'enqueue_realtime_shadow'/);
  assert.match(migration015, /actual\.enabled <> 'O'/);
  assert.match(migration015, /INSERT INTO public\.application_schema_migrations\(version\) VALUES \(15\)/);
});

test("P15 migration 015 preserves history, local realtime, and application data", () => {
  const migration015 = source("../migrations/015_retire_shadow_projection.sql");
  const localMigrationPaths = [
    "../migrations/009_local_realtime_invalidation.sql",
    "../migrations/010_diagnostics_device_inspector_realtime.sql",
    "../migrations/012_fix_local_realtime_control_trigger.sql",
    "../migrations/013_traffic_realtime.sql",
    "../migrations/014_managed_telemetry_realtime.sql",
  ];
  const localTriggerNames = localMigrationPaths.flatMap((path) =>
    [...source(path).matchAll(/CREATE TRIGGER (local_realtime_[a-z_]+)/g)].map((match) => match[1]));

  assert.equal(localTriggerNames.length, 11);
  for (const triggerName of localTriggerNames) {
    assert.doesNotMatch(migration015, new RegExp(`DROP TRIGGER ${triggerName}\\b`));
  }
  assert.doesNotMatch(migration015, /\b(?:DELETE FROM|TRUNCATE|DROP TABLE|ALTER TABLE|UPDATE|PURGE)\b/i);
  assert.doesNotMatch(migration015, /DROP FUNCTION|DROP SEQUENCE/i);
  assert.match(migration015, /to_regclass\('public\.realtime_outbox'\) IS NULL/);
  assert.match(migration015, /to_regclass\('public\.realtime_projection_watermarks'\) IS NULL/);
  assert.match(migration015, /to_regprocedure\('public\.enqueue_realtime_shadow\(\)'\) IS NULL/);
  assert.doesNotMatch(migration015, /asset\.[a-z_]+\s*(?:INSERT|UPDATE|DELETE|DROP|TRUNCATE)/i);
});

test("P15 local runtime retires the projector while retaining PostgreSQL realtime and explicit compatibility", () => {
  const main = source("../src/main.ts");
  const config = source("../src/config.ts");
  const server = source("../src/server.ts");
  const route = source("../src/persistence/route.ts");
  const supabaseRest = source("../src/supabase-rest.ts");
  const localFactory = main.slice(main.indexOf("localPostgres: () => {"), main.indexOf("const localRepos"));

  assert.doesNotMatch(main, /SupabaseShadowProjector|shadowProjector|shadowSupabase/);
  assert.doesNotMatch(localFactory, /requireSupabaseRuntimeConfig|supabaseUrl|supabaseServiceRoleKey/);
  assert.match(main, /supabase: \(\) => \{\s*const supabase = requireSupabaseRuntimeConfig\(config\)/);
  assert.match(config, /needsSupabaseApplicationCompatibility = persistenceAuthority === "supabase"/);
  assert.match(main, /realtimeListener\.current = new PostgresRealtimeListener/);
  assert.match(main, /await realtimeListener\.current\?\.stop\(\)/);
  assert.match(main, /realtimeListener\.current\?\.start\(\)/);
  assert.match(main, /outbox: localRepos\.outbox/);
  assert.match(route, /\.\.\.await options\.outbox!\.getHealth\(AbortSignal\.timeout\(7_000\)\)/);
  assert.match(route, /projector: \{ status: "retired", active: false \}/);

  const healthStart = server.indexOf('server.get("/healthz"');
  const healthEnd = server.indexOf("if (options.runnerHeartbeat)", healthStart);
  assert.ok(healthStart >= 0 && healthEnd > healthStart);
  assert.doesNotMatch(server.slice(healthStart, healthEnd), /projector|outbox|supabase/i);
  assert.match(supabaseRest, /authority: PersistenceAuthority/);
  assert.doesNotMatch(supabaseRest, /:\s*"supabase"\s*\)/);
});

test("P15 keeps PostgreSQL application reads, writes, and local Asset evidence wired", () => {
  const main = source("../src/main.ts");
  const evidence = source("../src/assets/evidence.ts");
  assert.match(main, /new PostgresAssetRepository\(assetPool\)/);
  assert.match(main, /new PostgresAssetChangeRepository\(assetPool\)/);
  for (const repository of [
    "PostgresRunnerHeartbeatRepository", "PostgresNetworkHealthRepository", "PostgresTrafficRepository",
    "PostgresManagedTelemetryRepository", "PostgresDiagnosticJobsRepository", "PostgresNetworkDiscoveryRepository",
    "PostgresDeviceInspectionRepository", "PostgresNetworkHealthPingJobsRepository",
  ]) {
    assert.match(main, new RegExp(`new ${repository}\\(query\\)`));
  }
  assert.match(main, /localRepos\s*\? new PostgresAssetEvidenceSource\(localRepos\.inventory\)/);
  assert.match(main, /new SupabaseAssetEvidenceSource\(supabase\.url, supabase\.serviceRoleKey\)/);
  assert.match(evidence, /class PostgresAssetEvidenceSource/);
  assert.match(evidence, /listNodes\(signal\)/);
  assert.match(evidence, /listHealthTargets\(signal\)/);
  assert.match(evidence, /listManagedTargets\(signal\)/);
  assert.match(evidence, /listManagedObservedHosts\(undefined, signal\)/);
});
