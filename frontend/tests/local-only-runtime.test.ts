import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("frontend authority accepts only explicit local PostgreSQL", () => {
  const authority = source("../lib/application-authority.ts");
  assert.match(authority, /value !== "local_postgres"/);
  assert.doesNotMatch(authority, /functions\/v1|createClient/);
});

test("Traffic consumers use local SSE invalidation and authoritative refetch", () => {
  for (const path of ["../components/dashboard/local-traffic-summary.tsx", "../components/traffic/traffic-live-page.tsx"]) {
    const component = source(path);
    assert.match(component, /startLocalRealtimeInvalidation|startTrafficRefresh/);
    assert.match(component, /getTrafficStateAction/);
    assert.doesNotMatch(component, /\.channel\(|postgres_changes|createClient/);
  }
});

test("Discovery uses local runner polling, local session polling, and Traffic invalidation", () => {
  const drawer = source("../components/dashboard/network-discovery-drawer.tsx");
  assert.match(drawer, /getDiscoveryRunnersAction/);
  assert.match(drawer, /10_000/);
  assert.match(drawer, /getDiscoverySessionAction/);
  assert.match(drawer, /2_000/);
  assert.match(drawer, /topics: \["traffic"\]/);
  assert.doesNotMatch(drawer, /\.channel\(|postgres_changes|createClient/);
});

test("Diagnostics, Device Inspector, and Managed Telemetry use local SSE and refetch", () => {
  const diagnostics = source("../components/diagnostics/one-click-diagnostics.tsx");
  const inspector = source("../components/device-profile/device-profile-provider.tsx");
  const telemetry = source("../components/device-profile/managed-telemetry-section.tsx");
  assert.match(diagnostics, /topics: \["diagnostics"\]/);
  assert.match(inspector, /topics: \["device_inspector"\]/);
  assert.match(telemetry, /topics: \["managed_telemetry"\]/);
  for (const value of [diagnostics, inspector, telemetry]) assert.doesNotMatch(value, /\.channel\(|postgres_changes|createClient/);
});

test("Manual Ping polls the local authoritative job state", () => {
  const ping = source("../components/dashboard/manual-ping-provider.tsx");
  assert.match(ping, /pollManualPingAction/);
  assert.match(ping, /waitForManualPingLocal/);
  assert.doesNotMatch(ping, /\.channel\(|postgres_changes|createClient/);
});

test("server loaders and actions contain no remote compatibility transport", () => {
  for (const path of [
    "../lib/network-health.ts", "../lib/network-discovery.ts", "../lib/managed-telemetry.ts",
    "../lib/traffic-source.ts", "../app/actions/diagnostics.ts", "../app/actions/legacy-network-control.ts",
  ]) assert.doesNotMatch(source(path), /functions\/v1|\.from\(|\.rpc\(|createClient/);
});
