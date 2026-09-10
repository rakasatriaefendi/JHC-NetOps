import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { assetExportHref } from "../lib/asset-report-query.ts";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Asset Inventory exposes the localized server-generated Excel action", () => {
  const inventory = source("../components/assets/asset-inventory.tsx");
  const button = source("../components/assets/asset-export-button.tsx");
  const route = source("../app/(protected)/assets/export/route.ts");
  assert.match(inventory, /<AssetExportButton disabled=\{!data\} query=\{query\}/);
  assert.match(button, /report\.exporting/);
  assert.match(button, /setState\("success"\)/);
  assert.match(button, /setState\("error"\)/);
  assert.match(button, /t\(`report\.\$\{state\}`\)/);
  assert.match(route, /requireApprovedProfile\(\)/);
  assert.match(route, /loadAssetInventoryReport/);
  assert.doesNotMatch(button + route, /LOCAL_BACKEND_FRONTEND_TOKEN|service_role|credential|community|auth_password|priv_password/i);
});

test("export propagates active filters and sort but never the current UI page", () => {
  const href = assetExportHref({ q: "core & edge", device_type: "switch_network", vendor: "Ruijie", platform: "Network OS", status: "online", sort: "name_desc", page: "4", page_size: "10" }, "en");
  const url = new URL(href, "http://localhost");
  assert.equal(url.searchParams.get("q"), "core & edge");
  assert.equal(url.searchParams.get("device_type"), "switch_network");
  assert.equal(url.searchParams.get("vendor"), "Ruijie");
  assert.equal(url.searchParams.get("platform"), "Network OS");
  assert.equal(url.searchParams.get("status"), "online");
  assert.equal(url.searchParams.get("sort"), "name_desc");
  assert.equal(url.searchParams.get("lang"), "en");
  assert.equal(url.searchParams.has("page"), false);
  assert.equal(url.searchParams.has("page_size"), false);
});

test("report catalogs remain paired in Indonesian and English", () => {
  for (const language of ["en", "id"] as const) {
    const catalog = JSON.parse(source(`../i18n/${language}/assets.json`));
    assert.equal(typeof catalog.report.action, "string");
    assert.equal(typeof catalog.report.exporting, "string");
    assert.equal(typeof catalog.report.success, "string");
    assert.equal(typeof catalog.report.error, "string");
  }
});

test("existing inventory pagination remains separate from export query construction", () => {
  const inventory = source("../components/assets/asset-inventory.tsx");
  assert.match(inventory, /pageHref\(query, page - 1\)/);
  assert.match(inventory, /pageHref\(query, page \+ 1\)/);
  assert.match(inventory, /<AssetExportButton[^>]+query=\{query\}/);
});
