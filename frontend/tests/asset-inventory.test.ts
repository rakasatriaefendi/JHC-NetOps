import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Asset Inventory is approved-user server data through the loopback backend only", () => {
  const page = source("../app/(protected)/assets/page.tsx");
  const loader = source("../lib/assets.ts");
  assert.match(page, /requireApprovedProfile\(\)/);
  assert.match(page, /loadAssetInventory\(query\)/);
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
  assert.match(component, /"overview" \| "network"/);
  assert.doesNotMatch(component, /identity|IP_CHANGED|MAC_CHANGED|NEW_DEVICE/);
});

test("contextual links render only when their stable reference exists", () => {
  const component = source("../components/assets/asset-inventory.tsx");
  assert.match(component, /asset\.network_node_ref \?/);
  assert.match(component, /asset\.health_target_ref \?/);
  assert.match(component, /asset\.managed_telemetry_target_ref \?/);
  assert.match(component, /asset\.observed_host_target_ref \?/);
  assert.doesNotMatch(component, /Register.*Medical|Inspect Device|Export Excel/);
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
  }
});

test("asset server loader forwards bounded evidence filters without exposing credentials", () => {
  const loader = source("../lib/assets.ts");
  assert.match(loader, /"vendor", "platform"/);
  assert.match(loader, /validInsights/);
  assert.match(loader, /item\.open_ports\.length <= 32/);
  assert.doesNotMatch(loader, /community|auth_password|priv_password/);
});
