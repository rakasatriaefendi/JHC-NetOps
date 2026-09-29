import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("P15 guard: shadow projection has an explicit non-blocking local lifecycle", () => {
  const main = source("../src/main.ts");
  const config = source("../src/config.ts");
  const server = source("../src/server.ts");
  const projector = source("../src/persistence/shadow-projector.ts");

  assert.match(config, /const supabaseUrl = parseSupabaseUrl\(environment\.SUPABASE_URL\)/);
  assert.match(config, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(main, /shadowProjector\.current = new SupabaseShadowProjector\(outbox, config\.supabaseUrl, config\.supabaseServiceRoleKey\)/);
  assert.match(main, /shadowProjector\.current\?\.start\(\);\s*realtimeListener\.current\?\.start\(\);\s*try \{ await server\.listen/);
  assert.doesNotMatch(main, /await shadowProjector\.current\?\.start\(\)/);
  assert.match(main, /await shadowProjector\.current\?\.stop\(\)/);

  const healthStart = server.indexOf('server.get("/healthz"');
  const healthEnd = server.indexOf("if (options.runnerHeartbeat)", healthStart);
  assert.ok(healthStart >= 0 && healthEnd > healthStart);
  assert.doesNotMatch(server.slice(healthStart, healthEnd), /shadowProjector|outbox|supabase/i);
  assert.match(projector, /catch \(error\) \{\s*batchFailed = true;\s*if \(!signal\.aborted\) \{\s*this\.consecutiveBatchFailures/);
});

test("P15 guard: every transactional shadow producer has one allowlisted consumer target", () => {
  const migration = source("../migrations/008_application_persistence_outbox.sql");
  const projector = source("../src/persistence/shadow-projector.ts");
  const triggeredTables = [...migration.matchAll(
    /CREATE TRIGGER\s+\S+\s+AFTER INSERT OR UPDATE OR DELETE ON public\.([a-z_]+)/g,
  )].map((match) => match[1]).sort();
  const allowlistedTables = [...projector.matchAll(/\bentry\("([a-z_]+)"/g)]
    .map((match) => match[1]).sort();

  assert.deepEqual(triggeredTables, [
    "device_inspection_sessions",
    "diagnostic_jobs",
    "diagnostic_runners",
    "events",
    "managed_device_latest",
    "managed_interface_latest",
    "managed_observed_hosts_latest",
    "managed_telemetry_targets",
    "network_discovery_sessions",
    "network_health_latest",
    "network_health_ping_jobs",
    "network_nodes",
    "network_targets",
    "profiles",
    "traffic_live_sessions",
    "traffic_live_snapshots",
  ]);
  assert.deepEqual(allowlistedTables, triggeredTables);
  assert.match(migration, /INSERT INTO public\.realtime_outbox/);
});
