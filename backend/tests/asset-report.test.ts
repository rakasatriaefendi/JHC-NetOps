import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { normalizeAssetChangeSnapshot, type AssetChangeSnapshot } from "../src/assets/change.js";
import type { AssetChangeEvent } from "../src/assets/change-contract.js";
import type { AssetListQuery, AssetRecord } from "../src/assets/contract.js";
import { ExcelJS } from "../src/assets/exceljs.js";
import {
  ASSET_REPORT_MAX_ASSETS,
  ASSET_REPORT_MAX_HISTORY_EVENTS,
  validateAssetReportQuery,
} from "../src/assets/report-contract.js";
import type { AssetReportData, AssetReportRepository } from "../src/assets/report-repository.js";
import { normalizeReportEvent } from "../src/assets/report-repository.js";
import { buildAssetWorkbook, sanitizeSpreadsheetText } from "../src/assets/report-workbook.js";
import { buildServer } from "../src/server.js";

const TOKEN = "r".repeat(32);
const QUERY: AssetListQuery = { search: "core", deviceType: "switch_network", vendor: "Ruijie", platform: "Network OS", status: "online", sort: "name_desc", page: 1, pageSize: 10 };
const ASSET: AssetRecord = {
  id: "11111111-1111-4111-8111-111111111111", name: "Core Switch", hostname: "core-switch", device_type: "switch_network", status: "online",
  ip_address: "192.168.1.8", mac_address: "00:11:22:33:44:55", vendor: "Ruijie", platform: "Network OS",
  first_seen_at: "2026-09-01T00:00:00Z", last_seen_at: "2026-09-10T00:00:00Z", source: "managed_telemetry",
  classification_confidence: "high", os_confidence: "high", classification_evidence: [], open_ports: [22, 443],
  detected_services: [{ protocol: "tcp", port: 22, name: "ssh", product: "OpenSSH" }], latency_ms: 1,
  evidence_updated_at: "2026-09-10T00:00:00Z", network_node_ref: "22222222-2222-4222-8222-222222222222",
  health_target_ref: "33333333-3333-4333-8333-333333333333", managed_telemetry_target_ref: "44444444-4444-4444-8444-444444444444", observed_host_target_ref: null,
};
const BEFORE = normalizeAssetChangeSnapshot({ ...ASSET, name: "Old Switch", status: "offline" });
const AFTER = normalizeAssetChangeSnapshot({ ...ASSET, status: "online" });
const EVENT: AssetChangeEvent = {
  id: "55555555-5555-4555-8555-555555555555", asset_id: ASSET.id, scan_run_id: null, asset_stable_key: "node:core",
  event_type: "changed", source: "managed_telemetry", observed_at: "2026-09-10T00:00:00Z", recorded_at: "2026-09-10T00:00:01Z",
  changed_fields: ["name"], before_state: BEFORE, after_state: AFTER,
};

test("asset report query reuses active inventory filters and ignores UI pagination by contract", () => {
  const result = validateAssetReportQuery({ q: "core", device_type: "switch_network", vendor: "Ruijie", platform: "Network OS", status: "online", sort: "name_desc", lang: "en" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.inventory, QUERY);
  assert.equal(result.value.language, "en");
  for (const invalid of [{ page: "2" }, { page_size: "50" }, { lang: "fr" }, { extra: "x" }, { status: "deleted" }]) {
    assert.equal(validateAssetReportQuery(invalid).ok, false);
  }
});

test("workbook contains readable bounded sheets, headers, counts, filters and timestamps", async () => {
  const report = await buildAssetWorkbook(reportData(), { inventory: QUERY, language: "en" }, new Date("2026-09-10T07:08:09Z"));
  assert.equal(report.filename, "JHC-NetOps-Asset-Inventory-2026-09-10.xlsx");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Uint8Array.from(report.buffer).buffer);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ["Summary", "Assets", "Change History"]);
  const summary = workbook.getWorksheet("Summary")!;
  assert.equal(summary.getCell("B3").value, 1);
  assert.equal(summary.getCell("B4").value, 1);
  assert.equal(summary.getCell("B10").value, "core");
  const assets = workbook.getWorksheet("Assets")!;
  assert.equal(assets.getCell("A1").value, "No");
  assert.equal(assets.getCell("R1").value, "Health Watch Monitored");
  assert.equal(assets.getCell("A2").value, 1);
  assert.equal(assets.getCell("Q2").value, "Yes");
  assert.equal(assets.views[0]?.state, "frozen");
  assert.ok(assets.autoFilter);
  assert.equal(assets.getRow(1).font.bold, true);
  assert.ok(assets.getCell("L2").value instanceof Date);
  const history = workbook.getWorksheet("Change History")!;
  assert.equal(history.getCell("E2").value, "Name");
  assert.match(String(history.getCell("F2").value), /Name: Old Switch/);
});

test("formula-like network and operator strings are neutralized as plain text", async () => {
  for (const value of ["=HYPERLINK(\"bad\")", "+SUM(1,1)", "-2+3", "@cmd", "  =1+1"]) {
    assert.equal(sanitizeSpreadsheetText(value), `'${value}`);
  }
  const malicious = { ...ASSET, name: "=2+2", hostname: "+cmd", vendor: "@vendor", detected_services: [{ protocol: "tcp" as const, port: 80, name: "-service" }] };
  const report = await buildAssetWorkbook(reportData({ assets: [malicious] }), { inventory: QUERY, language: "en" }, new Date("2026-09-10T00:00:00Z"));
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Uint8Array.from(report.buffer).buffer);
  const assets = workbook.getWorksheet("Assets")!;
  assert.equal(assets.getCell("C2").value, "'+cmd");
  assert.equal(assets.getCell("D2").value, "'=2+2");
  assert.equal(assets.getCell("G2").value, "'@vendor");
  assert.equal(assets.getCell("C2").type, ExcelJS.ValueType.String);
});

test("null fields and empty datasets export safely while truncation is explicit", async () => {
  const empty = reportData({ assets: [], history: [], matchingAssetCount: 2_500, assetsTruncated: true, historyTruncated: true });
  const report = await buildAssetWorkbook(empty, { inventory: { ...QUERY, search: "", deviceType: null, vendor: null, platform: null, status: null }, language: "id" }, new Date("2026-09-10T00:00:00Z"));
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Uint8Array.from(report.buffer).buffer);
  assert.equal(workbook.getWorksheet("Aset")!.rowCount, 1);
  assert.equal(workbook.getWorksheet("Riwayat Perubahan")!.rowCount, 1);
  assert.equal(workbook.getWorksheet("Ringkasan")!.getCell("B3").value, 2_500);
  assert.match(String(workbook.getWorksheet("Ringkasan")!.getCell("B6").value), /Tercapai/);
});

test("legacy status-only events are excluded and mixed events retain meaningful fields", () => {
  const row = changeRow(["status"], BEFORE, AFTER);
  assert.equal(normalizeReportEvent(row), null);
  const mixed = normalizeReportEvent(changeRow(["status", "mac_address"], BEFORE, AFTER));
  assert.deepEqual(mixed?.changed_fields, ["mac_address"]);
});

test("report route requires auth, applies fixed bounds, and returns safe XLSX headers", async () => {
  const repository = new FakeReports(reportData());
  const server = buildServer({ logger: false, assetReport: { token: TOKEN, repository, now: () => new Date("2026-09-10T07:08:09Z") } });
  assert.equal((await server.inject({ method: "GET", url: "/api/assets/export.xlsx" })).statusCode, 401);
  assert.equal((await server.inject({ method: "GET", url: "/api/assets/export.xlsx?page=2", headers: auth() })).statusCode, 400);
  const response = await server.inject({ method: "GET", url: "/api/assets/export.xlsx?q=core&device_type=switch_network&vendor=Ruijie&platform=Network%20OS&status=online&sort=name_desc&lang=en", headers: auth() });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(response.headers["content-disposition"], "attachment; filename=\"JHC-NetOps-Asset-Inventory-2026-09-10.xlsx\"");
  assert.equal(repository.calls[0]?.assetLimit, ASSET_REPORT_MAX_ASSETS);
  assert.equal(repository.calls[0]?.historyLimit, ASSET_REPORT_MAX_HISTORY_EVENTS);
  assert.deepEqual(repository.calls[0]?.query, QUERY);
  await server.close();
});

test("report persistence remains one filtered asset query plus bounded matching history", () => {
  const repository = readFileSync(new URL("../src/assets/report-repository.ts", import.meta.url), "utf8");
  const sharedQuery = readFileSync(new URL("../src/assets/query.ts", import.meta.url), "utf8");
  assert.match(repository, /assetListWhere\(query\)/);
  assert.match(repository, /assetListOrder\(query\)/);
  assert.match(repository, /asset_id = ANY\(\$1::uuid\[\]\)/);
  assert.match(repository, /LIMIT \$3/);
  assert.match(repository, /event_type = 'created' OR changed_fields && \$2::text\[\]/);
  assert.doesNotMatch(repository + sharedQuery, /credential|community|auth_password|priv_password|service_role/i);
});

class FakeReports implements AssetReportRepository {
  calls: { query: AssetListQuery; assetLimit: number; historyLimit: number }[] = [];
  constructor(private readonly data: AssetReportData) {}
  async load(query: AssetListQuery, assetLimit: number, historyLimit: number, signal: AbortSignal): Promise<AssetReportData> {
    signal.throwIfAborted();
    this.calls.push({ query, assetLimit, historyLimit });
    return this.data;
  }
}

function reportData(overrides: Partial<AssetReportData> = {}): AssetReportData {
  return { assets: [ASSET], history: [EVENT], matchingAssetCount: 1, assetsTruncated: false, historyTruncated: false, ...overrides };
}

function changeRow(changedFields: string[], before: AssetChangeSnapshot, after: AssetChangeSnapshot) {
  return { ...EVENT, changed_fields: changedFields, before_state: before, after_state: after };
}

function auth() { return { authorization: `Bearer ${TOKEN}` }; }
