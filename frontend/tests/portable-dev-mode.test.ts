import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createRequire } from "node:module";

// Properly typed server-only mock for Node Module
const require = createRequire(import.meta.url);
const mockModule: NodeModule = {
  exports: {},
  filename: "server-only",
  id: "server-only",
  loaded: true,
  parent: null,
  paths: [],
  require: require,
  children: [],
  isPreloading: false,
  path: "server-only",
};
require.cache[require.resolve("server-only")] = mockModule;

const { managedTelemetryFixture, PORTABLE_TARGET_ID } = await import("../lib/managed-telemetry-fixtures.ts");
const { loadObservedHostsData, loadSnmpWorkspaceData } = await import("../lib/managed-telemetry-source.ts");
const { portableDevConfig, portableDevMode } = await import("../lib/portable-dev-mode.ts");

const fakeSupabase = {} as SupabaseClient;

test("portable fixture mode is off by default and cannot activate in production", () => {
  assert.deepEqual(portableDevConfig({}), { enabled: false, scenario: null });
  assert.equal(portableDevMode({ NODE_ENV: "development" }), false);
  assert.equal(portableDevMode({ NODE_ENV: "production", PORTABLE_DEV_MODE: "true" }), false);
  assert.equal(portableDevMode({ NODE_ENV: "production", PORTABLE_DEV_MODE: "true", PORTABLE_DEV_SCENARIO: "healthy" }), false);
});

test("portable fixture mode requires explicit development opt-in and an allowlisted scenario", () => {
  assert.deepEqual(portableDevConfig({ NODE_ENV: "development", PORTABLE_DEV_MODE: "true" }), {
    enabled: true,
    scenario: "healthy",
  });
  assert.deepEqual(portableDevConfig({
    NODE_ENV: "development",
    PORTABLE_DEV_MODE: "TRUE",
    PORTABLE_DEV_SCENARIO: "partial",
  }), { enabled: true, scenario: "partial" });
  assert.throws(() => portableDevConfig({
    NODE_ENV: "development",
    PORTABLE_DEV_MODE: "true",
    PORTABLE_DEV_SCENARIO: "arbitrary",
  }), /PORTABLE_DEV_SCENARIO_INVALID/);
});

test("default workspace path remains the existing production loaders", async () => {
  const calls: string[] = [];
  const result = await loadSnmpWorkspaceData(fakeSupabase, { NODE_ENV: "development" }, {
    loadNodes: async () => {
      calls.push("nodes");
      return { data: [], error: false };
    },
    loadRunners: async () => {
      calls.push("runners");
      return { data: [], error: null };
    },
    loadTelemetry: async () => {
      calls.push("telemetry");
      return { data: [], interfaces: [], observedHosts: [], error: false };
    },
    loadObservedHosts: async () => {
      calls.push("observed");
      return { target: null, observedHosts: [], error: false };
    },
  });
  assert.deepEqual(calls.sort(), ["nodes", "runners", "telemetry"]);
  assert.equal(result.portable.enabled, false);
});

test("fixture workspace bypasses every production loader and cannot publish", async () => {
  let calls = 0;
  const unexpected = async () => {
    calls += 1;
    throw new Error("production loader must not run");
  };
  const result = await loadSnmpWorkspaceData(fakeSupabase, {
    NODE_ENV: "development",
    PORTABLE_DEV_MODE: "true",
    PORTABLE_DEV_SCENARIO: "healthy",
  }, {
    loadNodes: unexpected,
    loadRunners: unexpected,
    loadTelemetry: unexpected,
    loadObservedHosts: unexpected,
  });
  assert.equal(calls, 0);
  assert.equal(result.portable.enabled, true);
  assert.equal(result.telemetry.data[0]?.id, PORTABLE_TARGET_ID);

  const source = readFileSync(new URL("../lib/managed-telemetry-source.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /publishManagedTelemetry|functions\.invoke|managed-telemetry.*POST/i);
  const action = readFileSync(new URL("../app/actions/snmp.ts", import.meta.url), "utf8");
  assert.match(action, /if \(portableDevMode\(\)\)/);
  assert.match(action, /portable-read-only/);
});

test("fixture observed-host route bypasses Supabase and exposes only its deterministic target", async () => {
  let calls = 0;
  const environment = { NODE_ENV: "development", PORTABLE_DEV_MODE: "true", PORTABLE_DEV_SCENARIO: "healthy" };
  const found = await loadObservedHostsData(fakeSupabase, PORTABLE_TARGET_ID, environment, async () => {
    calls += 1;
    throw new Error("production loader must not run");
  });
  const missing = await loadObservedHostsData(fakeSupabase, "65000000-0000-4000-8000-000000000099", environment, async () => {
    calls += 1;
    throw new Error("production loader must not run");
  });
  assert.equal(calls, 0);
  assert.equal(found.target?.id, PORTABLE_TARGET_ID);
  assert.ok(found.observedHosts.length > 0);
  assert.equal(missing.target, null);
  assert.deepEqual(missing.observedHosts, []);
});

test("healthy fixture reuses normalized managed telemetry contracts", () => {
  const fixture = managedTelemetryFixture("healthy");
  const target = fixture.targets[0];
  assert.match(target.id, /^[0-9a-f-]{36}$/i);
  assert.equal(target.latest?.target_id, target.id);
  assert.equal(target.latest?.status, "connected");
  assert.equal(target.latest?.observed_hosts_status, "available");
  assert.ok(fixture.interfaces.some((row) => row.is_physical));
  assert.ok(fixture.interfaces.some((row) => !row.is_physical));
  for (const row of fixture.interfaces) {
    assert.equal(row.target_id, target.id);
    assert.ok(Number.isSafeInteger(row.if_index));
    assert.ok(row.rx_util_percent === null || row.rx_util_percent >= 0 && row.rx_util_percent <= 100);
    assert.ok(row.tx_util_percent === null || row.tx_util_percent >= 0 && row.tx_util_percent <= 100);
  }
});

test("Observed LAN Hosts fixture is deterministic across naming and freshness semantics", () => {
  const first = managedTelemetryFixture("healthy").observedHosts;
  const second = managedTelemetryFixture("healthy").observedHosts;
  assert.deepEqual(first, second);
  assert.ok(first.some((host) => host.netbios_name));
  assert.ok(first.some((host) => !host.netbios_name && !host.network_nodes));
  assert.ok(first.some((host) => host.status === "current"));
  assert.ok(first.some((host) => host.status === "stale"));
  assert.ok(first.some((host) => host.mac_address === null));
  assert.ok(first.every((host) => host.target_id === PORTABLE_TARGET_ID));
});

test("alert/recovery fixture uses the existing normalized event contract", () => {
  const events = managedTelemetryFixture("alert_recovery").events;
  assert.deepEqual(events.map((event) => event.raw_context.kind), ["utilization_high", "utilization_recovered"]);
  assert.equal(events[0].resolved_at, events[1].created_at);
  assert.equal(events[0].source_ref, PORTABLE_TARGET_ID);
  assert.equal(events[1].source_ref, PORTABLE_TARGET_ID);
  for (const event of events) {
    assert.match(event.id, /^[0-9a-f-]{36}$/i);
    assert.equal(event.raw_context.source, "managed_telemetry");
    assert.equal(event.raw_context.target_id, PORTABLE_TARGET_ID);
    assert.ok(["low", "medium", "high", "critical"].includes(event.severity));
  }
});

test("fixtures remain secret-free and within existing host and payload bounds", () => {
  for (const scenario of ["healthy", "partial", "alert_recovery", "large_observed_hosts"] as const) {
    const fixture = managedTelemetryFixture(scenario);
    const encoded = JSON.stringify(fixture);
    assert.ok(fixture.observedHosts.length <= 256);
    assert.ok(Buffer.byteLength(encoded, "utf8") <= 128 * 1024);
    assert.doesNotMatch(encoded, /community|string_secret|auth_password|priv_password|service_role|access_token|refresh_token/i);
    assert.doesNotMatch(encoded, /JHC|hospital|patient/i);
  }
  assert.equal(managedTelemetryFixture("large_observed_hosts").observedHosts.length, 200);
});

test("portable fixture UI is explicitly labelled and non-public environment variables are used", () => {
  const banner = readFileSync(new URL("../components/portable-fixture-banner.tsx", import.meta.url), "utf8");
  const mode = readFileSync(new URL("../lib/portable-dev-mode.ts", import.meta.url), "utf8");
  assert.match(banner, /t\("portable\.title"\)/);
  assert.match(banner, /t\("portable\.description"/);
  assert.match(banner, /t\("portable\.events"/);
  assert.match(mode, /PORTABLE_DEV_MODE/);
  assert.doesNotMatch(mode, /NEXT_PUBLIC/);
});