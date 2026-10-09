import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Asset Inventory data stays on the loopback backend while existing domain providers supply safe context", () => {
  const page = source("../app/(protected)/assets/page.tsx");
  const loader = source("../lib/assets.ts");
  assert.match(page, /requireApprovedProfile\(\)/);
  assert.match(page, /loadAssetInventory\(query\)/);
  assert.match(page, /loadAuthoritativeNetworkNodes\(\)/);
  assert.match(page, /localRunners\(\)/);
  assert.match(page, /localManagedTargets\(\)/);
  assert.match(page, /localHealthTargets\(\)/);
  assert.match(page, /<NetworkNodesProvider/);
  assert.match(page, /<DeviceProfileProvider/);
  assert.match(loader, /LOCAL_BACKEND_URL/);
  assert.match(loader, /LOCAL_BACKEND_FRONTEND_TOKEN/);
  assert.match(loader, /\["127\.0\.0\.1", "localhost", "\[::1\]"\]/);
  assert.doesNotMatch(loader, /NEXT_PUBLIC|DATABASE_URL|SUPABASE_SERVICE_ROLE_KEY/);
});

test("compact inventory exposes P10D columns, Insights, filters, pagination, and progressive detail", () => {
  const component = source("../components/assets/asset-inventory.tsx");
  for (const field of ["summary.total", "summary.online", "summary.offline", "summary.changed", "name_asc", "name_desc", "device_type", "status", "pagination.range", "insights.platform", "insights.vendor", "insights.vendorType"]) {
    assert.match(component, new RegExp(field.replace(".", "\\.")));
  }
  for (const column of ["table.no", "table.status", "table.ip", "table.hostname", "table.mac", "table.vendor", "table.os", "table.type", "table.ports"]) {
    assert.match(component, new RegExp(column.replace(".", "\\.")));
  }
  assert.match(component, /<details/);
  assert.match(component, /filterHref\(query, \{ vendor:/);
  assert.match(component, /filterHref\(query, \{ platform:/);
  assert.match(component, /setSelected\(asset\)/);
  assert.match(component, /AssetDetail/);
  assert.match(component, /role="dialog"/);
  assert.match(component, /aria-modal="true"/);
  assert.match(component, /items-center justify-center/);
  assert.match(component, /data\.server_time/);
  assert.match(component, /href="\/assets"/);
  assert.match(component, /hidden overflow-hidden[\s\S]*xl:block/);
  assert.match(component, /xl:hidden/);
  assert.doesNotMatch(component, /overflow-x-auto|min-w-\[/);
  assert.match(component, /"overview" \| "network" \| "history"/);
  assert.match(component, /AssetDetailHistory/);
  assert.match(component, /isNewNetworkAsset/);
  assert.match(component, /flex min-w-0 items-center gap-2/);
  assert.match(component, /inline-flex shrink-0 whitespace-nowrap/);
  assert.match(component, /<AssetIdentityPanel key=\{asset\.id\} assetId=\{asset\.id\}/);
  assert.doesNotMatch(component, /IP_CHANGED|MAC_CHANGED|NEW_DEVICE/);
});

test("Asset Detail renders bounded SNMP, Health Watch, and Inspector integration states", () => {
  const component = source("../components/assets/asset-inventory.tsx");
  assert.match(component, /validLinkedRef\(asset\.network_node_ref\)/);
  assert.match(component, /verifiedLinkedRef\(asset\.health_target_ref, healthTargetIds\)/);
  assert.match(component, /verifiedLinkedRef\(asset\.managed_telemetry_target_ref, managedTargets\.map/);
  assert.match(component, /context=\{managedTarget\?\.context \?\? null\}/);
  assert.match(component, /validLinkedRef\(asset\.observed_host_target_ref\)/);
  assert.match(component, /detail\.integrations\.snmp\.linked/);
  assert.match(component, /detail\.integrations\.snmp\.unlinked/);
  assert.match(component, /detail\.integrations\.health\.monitored/);
  assert.match(component, /detail\.integrations\.health\.unmonitored/);
  assert.match(component, /\/snmp\?target=\$\{encodeURIComponent\(managedTargetRef\)\}#managed-telemetry-workspace/);
  assert.match(component, /\/dashboard\?target=\$\{encodeURIComponent\(healthTargetRef\)\}/);
  assert.doesNotMatch(component, /community|auth_password|priv_password|credential_profile/i);
  assert.doesNotMatch(component, /Register.*Medical|Export Excel/);
});

test("Asset Detail launches only the existing bounded Inspector with inventory and operator guards", () => {
  const component = source("../components/assets/asset-inventory.tsx");
  const page = source("../app/(protected)/assets/page.tsx");
  assert.match(component, /nodes\.find\(\(node\) => node\.id === networkNodeRef\)/);
  assert.match(component, /normalizeNetworkNodeIpv4\(inspectorNode\.ip_address\)/);
  assert.match(component, /canInspect && inspectorIp && inspectorAvailable \? <Button/);
  assert.match(component, /openDeviceProfile\(\{ ipAddress: inspectorIp, inspect: true \}\)/);
  assert.match(page, /canInspect=\{canOperate\}/);
  assert.match(page, /capabilities\.operations\?\.includes\("device_inspect"\)/);
  assert.doesNotMatch(component, /functions\.invoke|start_inspection/);
});

test("asset catalogs are paired and contain compact error and empty states", () => {
  for (const language of ["id", "en"]) {
    const catalog = JSON.parse(source(`../i18n/${language}/assets.json`));
    assert.equal(typeof catalog.title, "string");
    assert.equal(typeof catalog.empty.title, "string");
    assert.equal(typeof catalog.errors.unconfigured.description, "string");
    assert.equal(typeof catalog.errors.unavailable.description, "string");
    assert.equal(typeof catalog.insights.title, "string");
    assert.equal(typeof catalog.detail.confidenceHelp, "string");
    assert.equal(typeof catalog.table.portCount, "string");
    assert.equal(typeof catalog.history.newDevice, "string");
    assert.equal(typeof catalog.history.empty, "string");
    assert.equal(typeof catalog.actions.openInspector, "string");
    assert.equal(typeof catalog.detail.integrations.snmp.linked, "string");
    assert.equal(typeof catalog.detail.integrations.snmp.unlinked, "string");
    assert.equal(typeof catalog.detail.integrations.health.monitored, "string");
    assert.equal(typeof catalog.detail.integrations.health.unmonitored, "string");
    assert.equal(typeof catalog.detail.integrations.inspector.inventoryRequired, "string");
  }
});

test("asset server loader forwards bounded evidence filters without exposing credentials", () => {
  const loader = source("../lib/assets.ts");
  assert.match(loader, /"vendor", "platform"/);
  assert.match(loader, /validInsights/);
  assert.match(loader, /item\.open_ports\.length <= 32/);
  assert.doesNotMatch(loader, /community|auth_password|priv_password/);
});

test("active inventory scan is explicit, operator-gated, allowlisted and polls only while running", () => {
  const page = source("../app/(protected)/assets/page.tsx");
  const action = source("../app/actions/assets.ts");
  const loader = source("../lib/assets.ts");
  const control = source("../components/assets/asset-scan-control.tsx");
  assert.match(page, /loadAssetScanState\(\)/);
  assert.match(page, /canOperateNetwork\(profile\.role\)/);
  assert.doesNotMatch(page, /startAssetScanAction|requestAssetScan/);
  assert.match(action, /requireOperatorProfile\(\)/);
  assert.match(action, /requireApprovedProfile\(\)/);
  assert.match(loader, /\/api\/assets\/scan/);
  assert.match(control, /state\?\.current\?\.status === "running"/);
  assert.match(control, /window\.setTimeout/);
  assert.match(control, /router\.refresh\(\)/);
  assert.match(control, /SCAN_NETWORK_NOT_ALLOWED/);
  assert.match(control, /role="dialog"/);
  assert.doesNotMatch(control, /nmap|--script|exec\(|spawn\(/i);
});

test("active scan localization and richer service evidence remain paired", () => {
  const component = source("../components/assets/asset-inventory.tsx");
  const loader = source("../lib/assets.ts");
  assert.match(component, /service\.product/);
  assert.match(component, /service\.version/);
  assert.match(component, /service\.extra_info/);
  assert.match(loader, /optionalString\(service\.product, 160\)/);
  for (const language of ["id", "en"]) {
    const catalog = JSON.parse(source(`../i18n/${language}/assets.json`));
    assert.equal(typeof catalog.scan.action, "string");
    assert.equal(typeof catalog.scan.mode.quick.description, "string");
    assert.equal(typeof catalog.scan.mode.deep.description, "string");
    assert.equal(typeof catalog.scan.unavailable, "string");
    assert.equal(typeof catalog.source.active_scan, "string");
  }
});
