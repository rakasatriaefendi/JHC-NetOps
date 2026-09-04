import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string) { return readFileSync(new URL(relativePath, import.meta.url), "utf8"); }

test("navigation exposes Devices and SNMP before LAN Diagnostics while Admin remains role-gated", () => {
  const navigation = source("../components/app-navigation.tsx");
  assert.ok(navigation.indexOf('href: "/devices"') < navigation.indexOf('href: "/diagnostics"'));
  assert.ok(navigation.indexOf('href: "/snmp"') < navigation.indexOf('href: "/diagnostics"'));
  assert.match(navigation, /role === "admin"[\s\S]*href: "\/admin"/);
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
  assert.match(action, /\.eq\("ip_address", normalizedIp\)/);
  assert.match(action, /device_notice=existing/);
  assert.match(action, /network_targets/);
  assert.match(action, /node_id: nodeId/);
  assert.doesNotMatch(action, /device-inspect|managed-telemetry-poll|discovery_sessions|manual_ping_requests|wsl\.exe|child_process/);
});

test("SNMP onboarding stores only an authorized node and non-secret runner profile reference", () => {
  const action = source("../app/actions/snmp.ts");
  const component = source("../components/admin/managed-telemetry-targets.tsx");
  assert.match(action, /requireOperatorProfile/);
  assert.match(action, /hasUnexpectedFormFields/);
  assert.match(action, /network_nodes/);
  assert.match(action, /node_id: values\.node_id/);
  assert.match(action, /runnerCredentialProfiles[\s\S]*profiles\.includes/);
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
  assert.match(inventory, /Open on-demand Discovery/);
  assert.doesNotMatch(inventory, /startDiscovery|createDiscovery|discoveryAction/);
});
