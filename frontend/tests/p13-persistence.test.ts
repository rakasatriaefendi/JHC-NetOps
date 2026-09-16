import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("frontend authority remains explicit and local API has no Supabase fallback", () => {
  const adapter = source("../lib/application-persistence.ts");
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
