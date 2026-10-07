import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string) { return readFileSync(new URL(relativePath, import.meta.url), "utf8"); }

test("navigation has compact operations, asset, and role-gated administration groups", () => {
  const navigation = source("../components/app-navigation.tsx");
  assert.ok(navigation.indexOf('href: "/devices"') < navigation.indexOf('href: "/diagnostics"'));
  assert.ok(navigation.indexOf('href: "/snmp"') < navigation.indexOf('href: "/diagnostics"'));
  assert.match(navigation, /key: "networkOperations"/);
  assert.doesNotMatch(navigation, /observedHosts|observed-lan-hosts|\/snmp\/\$\{[^}]+\}\/hosts/);
  assert.match(navigation, /href: "\/dashboard"[\s\S]*href: "\/traffic"[\s\S]*href: "\/history"[\s\S]*href: "\/alerts"[\s\S]*href: "\/devices"[\s\S]*href: "\/snmp"[\s\S]*href: "\/diagnostics"/);
  assert.match(navigation, /link\.href === "\/snmp"[\s\S]*pathname === "\/snmp" \|\| \/\^\\\/snmp/);
  assert.doesNotMatch(navigation, /b9bf5d39-c965-4407-960c-4b327ff273a8/);
  assert.match(navigation, /key: "assetManagement"[\s\S]*href: "\/assets"[\s\S]*href: "\/medical-equipment"/);
  assert.match(navigation, /role === "admin"[\s\S]*key: "administration"[\s\S]*href: "\/admin"/);
  assert.doesNotMatch(navigation, /vendor-history|ip-history|calibration|maintenance/);
});

test("Admin is account-only and monitoring configuration moved to approved-user pages", () => {
  const admin = source("../app/(protected)/admin/page.tsx");
  const devices = source("../app/(protected)/devices/page.tsx");
  const snmp = source("../app/(protected)/snmp/page.tsx");
  assert.doesNotMatch(admin, /NetworkHealthTargets|ManagedTelemetryTargets|network_targets|managed_telemetry_targets/);
  assert.match(admin, /UserAccessControl/);
  assert.match(devices, /requireApprovedProfile|DeviceInventory/);
  assert.doesNotMatch(devices, /NetworkHealthTargets/);
  assert.match(snmp, /requireApprovedProfile|ManagedTelemetryTargets|ManagedTelemetryDetail/);
  assert.match(devices, /canManage=\{canOperateNetwork\(profile\.role\)\}/);
  assert.match(snmp, /canManage=\{!portable\.enabled && canOperateNetwork\(profile\.role\)\}/);
});

test("manual onboarding is operator-authorized, server-validated, duplicate-safe, and never starts a probe", () => {
  const action = source("../app/actions/devices.ts");
  assert.match(action, /requireOperatorProfile/);
  assert.match(action, /validateManualNetworkNodeInput/);
  assert.match(action, /hasUnexpectedFormFields/);
  assert.match(action, /nodes\.some\(\(node\) => node\.ip_address === normalizedIp\)/);
  const onboardingStart = action.indexOf("export async function saveManualNetworkNodeAction(");
  const onboardingEnd = action.indexOf("export async function saveNetworkTargetAction(", onboardingStart);
  assert.ok(onboardingStart >= 0 && onboardingEnd > onboardingStart);
  const onboarding = action.slice(onboardingStart, onboardingEnd);
  const createAt = onboarding.indexOf('localApplicationRequest("POST", "/api/application/network-nodes"');
  assert.ok(createAt >= 0);
  assert.match(onboarding, /await requireOperatorProfile\(\)/);
  assert.match(onboarding, /hasUnexpectedFormFields\(formData, DEVICE_FIELDS\)/);
  assert.match(onboarding, /if \(validationError \|\| !normalizedIp\)\s*\{\s*return \{ ok: false, code: "invalid-request" \};\s*\}/);
  assert.match(onboarding, /if \(nodes\.some\(\(node\) => node\.ip_address === normalizedIp\)\)\s*\{\s*return \{ ok: true, changed: false \};\s*\}\s*const created = await localApplicationRequest\("POST", "\/api\/application\/network-nodes"/);
  for (const prerequisite of ["validateManualNetworkNodeInput(input)", "normalizeNetworkNodeIpv4(input.ip_address)",
    "await requireOperatorProfile()", "await localNetworkNodes()", "return { ok: true, changed: false }"]) {
    assert.ok(onboarding.indexOf(prerequisite) >= 0 && onboarding.indexOf(prerequisite) < createAt);
  }
  assert.equal((onboarding.match(/localApplicationRequest\("POST"/g) ?? []).length, 1);
  assert.match(onboarding, /actor_id: userId,[\s\S]*ip_address: normalizedIp/);
  assert.doesNotMatch(onboarding, /redirect\(|device_notice|queueManualPingAction|mutateDiscoverySessionAction|startDeviceInspectionAction|scan-runs|asset-scan/);
  assert.match(action, /\/api\/application\/network-nodes/);
  assert.match(action, /node_id: nodeId/);
  assert.doesNotMatch(action, /device-inspect|managed-telemetry-poll|discovery_sessions|manual_ping_requests|wsl\.exe|child_process/);
});

test("SNMP onboarding stores only an authorized node and non-secret runner profile reference", () => {
  const action = source("../app/actions/snmp.ts");
  const component = source("../components/admin/managed-telemetry-targets.tsx");
  assert.match(action, /requireOperatorProfile/);
  assert.match(action, /hasUnexpectedFormFields/);
  assert.match(action, /localNetworkNode\(values\.node_id\)/);
  assert.match(action, /input: \{ \.\.\.values, enabled \}/);
  assert.match(action, /runnerCredentialProfiles\(runner\.capabilities\)\.includes\(values\.credential_profile_ref\)/);
  assert.match(component, /credentialProfileStatus/);
  assert.doesNotMatch(action, /auth_password|priv_password|community\s*:/);
  assert.doesNotMatch(action, /arbitrary|snmpwalk|snmpget|managed-telemetry-poll|child_process/);
});

test("viewer receives read-only inventory and telemetry controls", () => {
  const inventory = source("../components/devices/device-inventory.tsx");
  const health = source("../components/devices/device-inventory.tsx");
  const telemetry = source("../components/admin/managed-telemetry-targets.tsx");
  assert.match(inventory, /canManage \? <div[\s\S]*saveManualNetworkNodeAction/);
  assert.match(health, /canManage \?/);
  assert.match(telemetry, /canManage \?/);
});

test("Discovery remains an explicit on-demand helper", () => {
  const inventory = source("../components/devices/device-inventory.tsx");
  assert.match(inventory, /t\("import\.open"\)/);
  assert.doesNotMatch(inventory, /startDiscovery|createDiscovery|discoveryAction/);
});
