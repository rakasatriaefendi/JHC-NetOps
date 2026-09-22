import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("frontend authority remains explicit and local API has no Supabase fallback", () => {
  const adapter = source("../lib/application-persistence.ts");
  assert.match(adapter, /import "server-only"/);
  assert.doesNotMatch(adapter, /NEXT_PUBLIC_[A-Z0-9_]*(?:TOKEN|KEY|SECRET)/);
  assert.match(adapter, /value !== "supabase" && value !== "local_postgres"/);
  assert.match(adapter, /if \(applicationAuthority\(\) !== "local_postgres"\)/);
  assert.match(adapter, /LOCAL_APPLICATION_UNAVAILABLE/);
  assert.doesNotMatch(adapter, /supabase\.from|functions\/v1/);
  for (const path of ["runners", "network-targets", "managed-targets", "managed-interfaces", "managed-observed-hosts"]) {
    assert.match(adapter, new RegExp(`/api/application/${path}`));
  }
});

test("local Health and SNMP loaders use only loopback helpers and fail closed", () => {
  const health = source("../lib/network-health.ts");
  const telemetry = source("../lib/managed-telemetry.ts");
  const telemetrySource = source("../lib/managed-telemetry-source.ts");
  assert.match(health, /applicationAuthority\(\) === "local_postgres"[\s\S]*loadNetworkHealthLocal/);
  assert.match(health, /localHealthTargets\(\)/);
  assert.match(health, /localRunners\(\)/);
  assert.match(health, /!rows \|\| !runners \|\| !events[\s\S]*error: true/);
  for (const helper of ["localManagedTargets", "localManagedInterfaces", "localManagedObservedHosts"]) {
    assert.match(telemetry, new RegExp(`${helper}\\(`));
  }
  assert.match(telemetry, /!targets \|\| !interfaces \|\| !observedHosts[\s\S]*error: true/);
  assert.match(telemetrySource, /loadRunnersLocal[\s\S]*localRunners\(\)/);
  assert.match(health, /supabase\.from\("network_targets"\)/);
  assert.match(telemetry, /supabase\.from\("managed_telemetry_targets"\)/);
});

test("affected server pages choose authoritative local read helpers", () => {
  const devices = source("../app/(protected)/devices/page.tsx");
  const assets = source("../app/(protected)/assets/page.tsx");
  const nodes = source("../lib/network-nodes-source.ts");
  assert.match(devices, /applicationAuthority\(\) === "local_postgres"[\s\S]*localRunners\(\)[\s\S]*localHealthTargets\(\)/);
  assert.match(assets, /applicationAuthority\(\) === "local_postgres"[\s\S]*localRunners\(\)[\s\S]*localManagedTargets\(\)[\s\S]*localHealthTargets\(\)/);
  assert.match(nodes, /import "server-only"/);
  assert.match(nodes, /applicationAuthority\(\) === "local_postgres"[\s\S]*localNetworkNodes\(\)/);
  assert.match(nodes, /return loadNetworkNodes\(supabase\)/);
});

test("Supabase Auth stays external while local profiles supply application role and status", () => {
  const auth = source("../lib/auth.ts");
  const admin = source("../app/actions/admin.ts");
  assert.match(auth, /supabase\.auth\.getClaims\(\)/);
  assert.match(auth, /supabase\.auth\.getUser\(\)/);
  assert.match(auth, /applicationAuthority\(\) === "local_postgres"[\s\S]*loadLocalAuthenticatedProfile/);
  assert.match(admin, /applicationAuthority\(\) === "local_postgres"[\s\S]*localApplicationRequest/);
});

test("direct browser inventory and Health target mutations use server actions", () => {
  const nodes = source("../components/diagnostics/network-nodes-provider.tsx");
  const profile = source("../components/device-profile/device-profile-provider.tsx");
  const discovery = source("../components/dashboard/network-discovery-drawer.tsx");
  assert.match(nodes, /saveNetworkNodeClientAction/);
  assert.match(nodes, /saveNetworkFingerprintClientAction/);
  assert.match(nodes, /deleteNetworkNodeClientAction/);
  assert.match(profile, /promoteHealthTargetsAction/);
  assert.match(discovery, /promoteHealthTargetsAction/);
  for (const component of [nodes, profile, discovery]) {
    assert.doesNotMatch(component, /\.from\("network_nodes"\)\.(?:insert|update|delete)/);
    assert.doesNotMatch(component, /\.from\("network_targets"\)\.upsert/);
  }
});

test("client components cannot invoke legacy mutating Edge functions directly", () => {
  const diagnostics = source("../components/diagnostics/one-click-diagnostics.tsx");
  const ping = source("../components/dashboard/manual-ping-provider.tsx");
  const discovery = source("../components/dashboard/network-discovery-drawer.tsx");
  const inspector = source("../components/device-profile/device-profile-provider.tsx");
  const traffic = source("../components/traffic/traffic-live-page.tsx");
  const action = source("../app/actions/legacy-network-control.ts");
  assert.doesNotMatch(diagnostics, /functions\.invoke\("diagnostic-jobs"/);
  assert.doesNotMatch(ping, /functions\.invoke\("network-health"/);
  assert.doesNotMatch(discovery, /functions\.invoke[^]*"network-discovery"/);
  assert.doesNotMatch(inspector, /functions\.invoke[^]*"device-inspector"/);
  assert.match(traffic, /mutateTrafficSessionAction/);
  assert.doesNotMatch(
    traffic,
    /functions\.invoke(?:<[^>]+>)?\(\s*"traffic-live",\s*\{\s*body\b/,
  );
  assert.match(action, /applicationAuthority\(\) === "local_postgres"/);
  for (const edge of ["diagnostic-jobs", "network-health", "network-discovery", "device-inspector", "traffic-live"]) {
    assert.match(action, new RegExp(`functions\\.invoke[^]*${edge}`));
  }
});

test("server actions preserve Supabase mode but switch writes to loopback in local mode", () => {
  for (const path of ["../app/actions/devices.ts", "../app/actions/snmp.ts",
    "../app/actions/network-nodes-client.ts", "../app/actions/health-promotion.ts"]) {
    const action = source(path);
    assert.match(action, /applicationAuthority\(\) === "local_postgres"/);
    assert.match(action, /localApplicationRequest/);
    assert.match(action, /supabase\.from/);
  }
  assert.match(source("../app/actions/health-promotion.ts"), /nodeIds\.length > 254/);
  assert.match(source("../app/actions/health-promotion.ts"), /\/api\/application\/network-targets\/promote/);
  assert.match(source("../app/actions/snmp.ts"), /\/api\/application\/managed-targets/);
  assert.match(source("../app/actions/devices.ts"), /\/api\/application\/network-targets/);
});

test("browser Device Profile uses server actions for authoritative reads and exposes no local token", () => {
  const profile = source("../components/device-profile/device-profile-provider.tsx");
  const inspectionAction = source("../app/actions/device-inspection.ts");
  const telemetry = source("../components/device-profile/managed-telemetry-section.tsx");
  assert.match(profile, /healthTargetMonitoringStateAction/);
  assert.match(profile, /getDeviceInspectionSessionAction/);
  assert.match(profile, /inspectionAuthority !== "local_postgres"/);
  assert.match(profile, /window\.setInterval[^]*2_000/);
  assert.match(profile, /inspectionAuthority !== "supabase"/);
  assert.match(inspectionAction, /localDeviceInspection/);
  assert.match(inspectionAction, /\.from\("device_inspection_sessions"\)/);
  assert.match(telemetry, /loadManagedTelemetryForNodeAction/);
  assert.doesNotMatch(profile, /\.from\("network_targets"\)/);
  assert.doesNotMatch(telemetry, /\.from\("(?:managed_telemetry_targets|managed_device_latest|managed_interface_latest|managed_observed_hosts_latest)"\)/);
  for (const component of [profile, inspectionAction, telemetry]) {
    assert.doesNotMatch(component, /LOCAL_BACKEND_FRONTEND_TOKEN|localApplicationRequest/);
  }
  assert.match(telemetry, /postgres_changes/);
});

test("cutover canary stays server-only, verifies local commit, and cleans up in finally", () => {
  const canary = source("../app/actions/cutover-canary.ts");
  const adapter = source("../lib/application-persistence.ts");
  assert.match(canary, /"use server"/);
  assert.match(canary, /await requireAdminProfile\(\)/);
  assert.match(canary, /localApplicationRequest\("PATCH"/);
  assert.match(canary, /finally\s*\{/);
  assert.doesNotMatch(canary, /actor_id/);
  assert.match(adapter, /export function safeApplicationPath/);
  assert.match(adapter, /parsed\.origin !== base\.origin/);
  assert.match(adapter, /parsed\.searchParams\.entries\(\)/);
});
