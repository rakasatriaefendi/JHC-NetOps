import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { isNetworkDiscoveredSource, isNewNetworkAsset } from "../lib/asset-change-contract.ts";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("NEW DEVICE is a temporary derived badge for recent network evidence only", () => {
  const now = "2026-09-09T12:00:00.000Z";
  assert.equal(isNewNetworkAsset({ source: "active_scan", first_seen_at: "2026-09-08T12:00:00.000Z" }, now), true);
  assert.equal(isNewNetworkAsset({ source: "discovery", first_seen_at: "2026-09-09T11:59:00.000Z" }, now), true);
  assert.equal(isNewNetworkAsset({ source: "observed_host", first_seen_at: "2026-09-09T11:59:00.000Z" }, now), true);
  assert.equal(isNewNetworkAsset({ source: "manual", first_seen_at: "2026-09-09T11:59:00.000Z" }, now), false);
  assert.equal(isNewNetworkAsset({ source: "active_scan", first_seen_at: "2026-09-08T11:59:59.999Z" }, now), false);
  assert.equal(isNewNetworkAsset({ source: "active_scan", first_seen_at: null }, now), false);
  assert.equal(isNewNetworkAsset({ source: "active_scan", first_seen_at: "2026-09-09T12:00:01.000Z" }, now), false);
  assert.equal(isNetworkDiscoveredSource("manual"), false);
  assert.equal(isNetworkDiscoveredSource("active_scan"), true);
});

test("Asset Inventory exposes contextual history without table N+1 requests", () => {
  const inventory = source("../components/assets/asset-inventory.tsx");
  const action = source("../app/actions/assets.ts");
  assert.match(inventory, /"overview" \| "network" \| "history"/);
  assert.match(inventory, /<AssetDetailHistory assetId=\{asset\.id\}/);
  assert.match(inventory, /isNewNetworkAsset\(asset, data\.server_time\)/);
  assert.match(inventory, /getAssetChangeHistoryAction\(assetId, page\)/);
  const inventoryList = inventory.slice(inventory.indexOf("data?.items.length"), inventory.indexOf("function AssetInsights"));
  assert.doesNotMatch(inventoryList, /getAssetChangeHistoryAction/);
  assert.match(action, /requireApprovedProfile\(\)/);
  assert.match(action, /loadAssetChangeHistory\(\{ page: String\(page\), page_size: "10" \}, assetId\)/);
});

test("History workspace has bounded asset filters and operator-friendly values", () => {
  const panel = source("../components/assets/asset-change-history-panel.tsx");
  const page = source("../app/(protected)/history/page.tsx");
  const tabs = source("../components/history/history-tabs.tsx");
  for (const filter of ["event_type", "changed_field", "page_size"]) assert.match(panel, new RegExp(filter));
  assert.match(panel, /changeValue/);
  assert.match(panel, /before_state/);
  assert.match(panel, /after_state/);
  assert.doesNotMatch(panel, /JSON\.stringify/);
  assert.match(page, /loadAssetChangeHistory\(query\)/);
  assert.match(tabs, /tabs\.assets/);
  assert.match(tabs, /AssetChangeHistoryPanel/);
});

test("asset change catalogs remain paired in Indonesian and English", () => {
  for (const language of ["id", "en"]) {
    const assets = JSON.parse(source(`../i18n/${language}/assets.json`));
    const history = JSON.parse(source(`../i18n/${language}/history.json`));
    assert.equal(typeof assets.history.newDevice, "string");
    assert.equal(typeof assets.history.loading, "string");
    assert.equal(typeof history.tabs.assets, "string");
    assert.equal(typeof history.assetChanges.title, "string");
    assert.equal(typeof history.assetChanges.assetCreated, "string");
    assert.equal(typeof history.assetChanges.createdVia, "string");
    for (const field of ["name", "hostname", "ip_address", "mac_address", "vendor", "platform", "device_type", "status", "open_ports", "detected_services"]) {
      assert.equal(typeof history.assetChanges.fields[field], "string");
    }
  }
});
