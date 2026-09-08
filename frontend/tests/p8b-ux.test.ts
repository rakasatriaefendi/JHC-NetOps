import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string) { return readFileSync(new URL(relativePath, import.meta.url), "utf8"); }

test("Devices uses one inventory-driven list with consolidated Health Watch state", () => {
  const page = source("../app/(protected)/devices/page.tsx");
  const inventory = source("../components/devices/device-inventory.tsx");
  assert.match(page, /network_health_latest\(status,last_checked_at\)/);
  assert.match(page, /<DeviceInventory/);
  assert.doesNotMatch(page, /NetworkHealthTargets/);
  assert.equal((inventory.match(/<table/g) ?? []).length, 1);
  assert.match(inventory, /t\("health\.notMonitored"\)/);
  assert.match(inventory, /t\("health\.latest", \{ status:/);
  assert.match(inventory, /runner\?\.display_name[\s\S]*probe_interval_seconds/);
  assert.doesNotMatch(inventory, /Known inventory|Known monitoring targets/);
});

test("Devices exposes contextual edit, Health Watch management, and confirmed deletes to admins", () => {
  const component = source("../components/devices/device-inventory.tsx");
  assert.match(component, /t\("list\.edit"\)/);
  assert.match(component, /t\("list\.configureHealth"\)/);
  assert.match(component, /t\("health\.remove"\)/);
  assert.match(component, /t\("list\.delete"\)/);
  assert.match(component, /window\.confirm\(t\("list\.deleteConfirm", \{ device: confirmationLabel\(node\) \}\)\)/);
  assert.match(component, /window\.confirm\(t\("health\.removeConfirm", \{ device: confirmationLabel\(node\) \}\)\)/);
  assert.match(component, /canManage \? <td/);
});

test("inventory deletion blocks Health Watch and SNMP dependencies without broad cleanup", () => {
  const action = source("../app/actions/devices.ts");
  assert.match(action, /deleteNetworkNodeAction/);
  assert.match(action, /network_targets[\s\S]*select\("id"\)[\s\S]*node_id/);
  assert.match(action, /managed_telemetry_targets[\s\S]*select\("id"\)[\s\S]*node_id/);
  assert.match(action, /blocked-health-snmp|blocked-health|blocked-snmp/);
  assert.match(action, /from\("network_nodes"\)\.delete\(\)\.eq\("id", nodeId\)/);
  assert.doesNotMatch(action, /from\("(?:events|managed_device_latest|managed_interface_latest|hop_measurements|bandwidth_measurements)"\)\.delete/);
});

test("Health Watch deletion targets only its configuration row", () => {
  const action = source("../app/actions/devices.ts");
  const section = action.slice(action.indexOf("export async function deleteNetworkTargetAction"), action.indexOf("export async function deleteNetworkNodeAction"));
  assert.match(section, /from\("network_targets"\)\.delete\(\)\.eq\("id", targetId\)/);
  assert.doesNotMatch(section, /network_nodes"\)\.delete|managed_telemetry_targets"\)\.delete|events"\)\.delete/);
});

test("inventory and SNMP forms constrain long select values inside responsive grid cells", () => {
  for (const path of ["../components/devices/device-inventory.tsx", "../components/admin/managed-telemetry-targets.tsx"]) {
    const component = source(path);
    assert.match(component, /grid min-w-0/);
    assert.match(component, /minmax\(0,1fr\)/);
    assert.match(component, /min-w-0 w-full truncate/);
  }
});

test("SNMP page renders telemetry information before management configuration", () => {
  const page = source("../app/(protected)/snmp/page.tsx");
  assert.ok(page.indexOf("<ManagedTelemetryDetail") < page.indexOf("<ManagedTelemetryTargets"));
});

test("SNMP managed target delete is confirmed and deletes no inventory or Health Watch rows", () => {
  const component = source("../components/admin/managed-telemetry-targets.tsx");
  const action = source("../app/actions/snmp.ts");
  assert.match(component, /t\("telemetry\.edit"\)/);
  assert.match(component, /t\("telemetry\.delete"\)/);
  assert.match(component, /window\.confirm\(t\("telemetry\.deleteConfirm"/);
  const section = action.slice(action.indexOf("export async function deleteManagedTelemetryTargetAction"));
  assert.match(section, /from\("managed_telemetry_targets"\)\.delete\(\)\.eq\("id", targetId\)/);
  assert.doesNotMatch(section, /from\("network_nodes"\)\.delete|from\("network_targets"\)\.delete/);
  assert.doesNotMatch(component + action, /auth_password|priv_password|community\s*:/);
});
