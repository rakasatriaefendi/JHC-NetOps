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
