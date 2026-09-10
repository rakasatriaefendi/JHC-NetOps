import type { AssetChangeEvent, AssetChangeSource } from "./change-contract.js";
import type { AssetChangeField, AssetChangeSnapshot } from "./change.js";
import type { AssetRecord, AssetStatus } from "./contract.js";
import { ExcelJS, type ExcelWorkbook, type ExcelWorksheet } from "./exceljs.js";
import type { AssetReportQuery } from "./report-contract.js";
import type { AssetReportData } from "./report-repository.js";

export type AssetWorkbookResult = Readonly<{ buffer: Buffer; filename: string }>;

export async function buildAssetWorkbook(data: AssetReportData, query: AssetReportQuery, generatedAt: Date): Promise<AssetWorkbookResult> {
  const labels = REPORT_LABELS[query.language];
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "JHC NetOps Asset Inventory";
  workbook.created = generatedAt;
  workbook.modified = generatedAt;

  addSummarySheet(workbook, data, query, generatedAt, labels);
  addAssetsSheet(workbook, data.assets, labels);
  addHistorySheet(workbook, data.history, data.assets, labels);

  const bytes = await workbook.xlsx.writeBuffer();
  return {
    buffer: Buffer.from(bytes),
    filename: `JHC-NetOps-Asset-Inventory-${generatedAt.toISOString().slice(0, 10)}.xlsx`,
  };
}

export function sanitizeSpreadsheetText(value: string): string {
  return /^[\t\r\n ]*[=+\-@]/.test(value) ? `'${value}` : value;
}

function addSummarySheet(
  workbook: ExcelWorkbook,
  data: AssetReportData,
  query: AssetReportQuery,
  generatedAt: Date,
  labels: ReportLabels,
) {
  const sheet = workbook.addWorksheet(labels.sheets.summary);
  sheet.columns = [{ width: 34 }, { width: 58 }];
  sheet.addRow([labels.reportTitle, "JHC NetOps Asset Inventory"]);
  sheet.addRow([labels.generatedAt, generatedAt]);
  sheet.getCell("B2").numFmt = labels.timestampFormat;
  sheet.addRow([labels.matchingAssets, data.matchingAssetCount]);
  sheet.addRow([labels.exportedAssets, data.assets.length]);
  sheet.addRow([labels.exportedHistory, data.history.length]);
  sheet.addRow([labels.assetLimit, data.assetsTruncated ? labels.truncated : labels.notTruncated]);
  sheet.addRow([labels.historyLimit, data.historyTruncated ? labels.truncated : labels.notTruncated]);
  sheet.addRow([]);
  sheet.addRow([labels.criteria, labels.value]);
  sheet.addRow([labels.search, safeOrAll(query.inventory.search, labels.all)]);
  sheet.addRow([labels.deviceType, safeOrAll(query.inventory.deviceType, labels.all)]);
  sheet.addRow([labels.vendor, safeOrAll(query.inventory.vendor, labels.all)]);
  sheet.addRow([labels.os, safeOrAll(query.inventory.platform, labels.all)]);
  sheet.addRow([labels.status, query.inventory.status ? labels.statuses[query.inventory.status] : labels.all]);
  sheet.addRow([labels.sort, query.inventory.sort === "name_desc" ? labels.nameDesc : labels.nameAsc]);
  sheet.addRow([]);
  sheet.addRow([labels.statusCounts, labels.count]);
  for (const status of ["online", "offline", "changed", "unknown"] as const) {
    sheet.addRow([labels.statuses[status], data.assets.filter((asset) => asset.status === status).length]);
  }
  sheet.addRow([]);
  sheet.addRow([labels.deviceTypeCounts, labels.count]);
  for (const [deviceType, count] of groupedCounts(data.assets.map((asset) => asset.device_type))) {
    sheet.addRow([safeText(deviceType), count]);
  }
  sheet.addRow([]);
  sheet.addRow([labels.evidenceCompleteness, labels.count]);
  sheet.addRow([labels.vendorKnown, data.assets.filter((asset) => known(asset.vendor)).length]);
  sheet.addRow([labels.vendorUnknown, data.assets.filter((asset) => !known(asset.vendor)).length]);
  sheet.addRow([labels.osKnown, data.assets.filter((asset) => known(asset.platform)).length]);
  sheet.addRow([labels.osUnknown, data.assets.filter((asset) => !known(asset.platform)).length]);
  styleSummary(sheet);
}

function addAssetsSheet(workbook: ExcelWorkbook, assets: readonly AssetRecord[], labels: ReportLabels) {
  const sheet = workbook.addWorksheet(labels.sheets.assets, { views: [{ state: "frozen", ySplit: 1 }] });
  const headers = [
    labels.no, labels.assetId, labels.hostname, labels.name, labels.currentIp, labels.mac, labels.vendor,
    labels.os, labels.deviceType, labels.currentStatus, labels.osConfidence, labels.firstSeen, labels.lastSeen,
    labels.source, labels.openPorts, labels.services, labels.snmpLinked, labels.healthMonitored,
  ];
  sheet.addRow(headers);
  for (const [index, asset] of assets.entries()) {
    sheet.addRow([
      index + 1,
      safeText(asset.id),
      safeOptional(asset.hostname),
      safeText(asset.name),
      safeOptional(asset.ip_address),
      safeOptional(asset.mac_address),
      safeOptional(asset.vendor),
      safeOptional(asset.platform),
      safeText(humanEnum(asset.device_type)),
      labels.statuses[asset.status],
      asset.os_confidence ? labels.confidence[asset.os_confidence] : "-",
      excelTimestamp(asset.first_seen_at),
      excelTimestamp(asset.last_seen_at),
      safeText(labels.sources[asset.source as AssetChangeSource] ?? humanEnum(asset.source)),
      asset.open_ports.length ? asset.open_ports.join(", ") : "-",
      asset.detected_services.length ? safeText(asset.detected_services.map(serviceSummary).join("\n")) : "-",
      asset.managed_telemetry_target_ref ? labels.yes : labels.noValue,
      asset.health_target_ref ? labels.yes : labels.noValue,
    ]);
  }
  styleDataSheet(sheet, headers.length, [12, 38, 24, 24, 18, 20, 22, 26, 22, 18, 18, 22, 22, 20, 18, 42, 18, 20], labels.timestampFormat, [12, 13]);
}

function addHistorySheet(
  workbook: ExcelWorkbook,
  events: readonly AssetChangeEvent[],
  assets: readonly AssetRecord[],
  labels: ReportLabels,
) {
  const sheet = workbook.addWorksheet(labels.sheets.history, { views: [{ state: "frozen", ySplit: 1 }] });
  const headers = [labels.eventTime, labels.asset, labels.eventType, labels.source, labels.changedFields, labels.before, labels.after, labels.scanReference];
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  sheet.addRow(headers);
  for (const event of events) {
    const asset = event.asset_id ? assetById.get(event.asset_id) : undefined;
    const changedFields = event.changed_fields.filter((field) => field !== "status");
    if (event.event_type === "changed" && !changedFields.length) continue;
    sheet.addRow([
      excelTimestamp(event.recorded_at),
      safeText(asset ? `${asset.hostname ?? asset.name} (${asset.id})` : event.asset_stable_key),
      labels.eventTypes[event.event_type],
      safeText(labels.sources[event.source] ?? humanEnum(event.source)),
      changedFields.length ? safeText(changedFields.map((field) => labels.fields[field]).join(", ")) : "-",
      event.before_state ? safeText(snapshotSummary(event.before_state, changedFields, labels)) : "-",
      safeText(snapshotSummary(event.after_state, changedFields, labels, event.event_type === "created")),
      safeOptional(event.scan_run_id),
    ]);
  }
  styleDataSheet(sheet, headers.length, [22, 42, 16, 20, 34, 54, 54, 38], labels.timestampFormat, [1]);
}

function styleDataSheet(sheet: ExcelWorksheet, columnCount: number, widths: number[], timestampFormat: string, dateColumns: number[]) {
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, sheet.rowCount), column: columnCount } };
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF176B68" } };
  header.alignment = { vertical: "middle", wrapText: true };
  header.height = 24;
  widths.forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
  for (const column of dateColumns) sheet.getColumn(column).numFmt = timestampFormat;
  for (let row = 2; row <= sheet.rowCount; row += 1) {
    sheet.getRow(row).alignment = { vertical: "top", wrapText: true };
  }
}

function styleSummary(sheet: ExcelWorksheet) {
  for (const rowNumber of [1, 9, 17, 23]) {
    const row = sheet.getRow(rowNumber);
    row.font = { bold: true, color: { argb: "FFFFFFFF" } };
    row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF176B68" } };
  }
  sheet.getColumn(1).font = { bold: true };
  sheet.eachRow((row) => { row.alignment = { vertical: "top", wrapText: true }; });
}

function snapshotSummary(snapshot: AssetChangeSnapshot, fields: readonly AssetChangeField[], labels: ReportLabels, created = false): string {
  const selected = created
    ? (["name", "hostname", "ip_address", "mac_address", "vendor", "platform", "device_type", "open_ports", "detected_services"] as const)
    : fields;
  return selected.map((field) => `${labels.fields[field]}: ${snapshotValue(snapshot, field)}`).join("\n");
}

function snapshotValue(snapshot: AssetChangeSnapshot, field: AssetChangeField): string {
  const value = snapshot[field];
  if (field === "detected_services") return snapshot.detected_services.length ? snapshot.detected_services.map(serviceSummary).join("; ") : "-";
  if (field === "open_ports") return snapshot.open_ports.length ? snapshot.open_ports.join(", ") : "-";
  return typeof value === "string" && value ? value : "-";
}

function serviceSummary(service: AssetRecord["detected_services"][number]): string {
  return [`${service.protocol.toUpperCase()}/${service.port}`, service.name, service.product, service.version].filter(Boolean).join(" ");
}

function excelTimestamp(value: string | null): Date | string {
  if (!value) return "-";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? safeText(value) : parsed;
}

function safeText(value: string): string { return sanitizeSpreadsheetText(value); }
function safeOptional(value: string | null): string { return value ? safeText(value) : "-"; }
function safeOrAll(value: string | null, fallback: string): string { return value ? safeText(value) : fallback; }
function humanEnum(value: string): string { return value.replaceAll("_", " "); }
function known(value: string | null): boolean { return Boolean(value && !["unknown", "n/a", "none", "null", "-"].includes(value.trim().toLowerCase())); }

function groupedCounts(values: string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

const REPORT_LABELS = {
  en: {
    sheets: { summary: "Summary", assets: "Assets", history: "Change History" },
    reportTitle: "Report title", generatedAt: "Generated at", matchingAssets: "Total matching assets", exportedAssets: "Assets exported", exportedHistory: "History events exported",
    assetLimit: "Asset export limit", historyLimit: "History export limit", truncated: "Reached - report contains the first bounded records", notTruncated: "Not reached",
    criteria: "Active criteria", value: "Value", search: "Search", deviceType: "Device type", vendor: "Vendor", os: "OS / Platform", status: "Status", sort: "Sort", all: "All", nameAsc: "Name A-Z", nameDesc: "Name Z-A",
    statusCounts: "Status counts (exported assets)", deviceTypeCounts: "Device type counts (exported assets)", evidenceCompleteness: "Evidence completeness", count: "Count", vendorKnown: "Known vendor", vendorUnknown: "Unknown vendor", osKnown: "Known OS", osUnknown: "Unknown OS",
    no: "No", assetId: "Asset ID", hostname: "Hostname", name: "Name", currentIp: "Current IP", mac: "MAC", currentStatus: "Current Operational Status", osConfidence: "OS Confidence", firstSeen: "First Seen", lastSeen: "Last Seen", source: "Source", openPorts: "Open Ports", services: "Services", snmpLinked: "Managed SNMP Linked", healthMonitored: "Health Watch Monitored",
    eventTime: "Event Time", asset: "Asset", eventType: "Event Type", changedFields: "Changed Fields", before: "Before", after: "After", scanReference: "Scan / Run Reference",
    yes: "Yes", noValue: "No", timestampFormat: "yyyy-mm-dd hh:mm:ss",
    statuses: { online: "Online", offline: "Offline", changed: "Changed", unknown: "Unknown" } as Record<AssetStatus, string>,
    confidence: { low: "Low", medium: "Medium", high: "High" }, eventTypes: { created: "Created", changed: "Changed" },
    sources: { manual: "Manual", discovery: "Discovery", observed_host: "Observed LAN Host", device_inspector: "Device Inspector", managed_telemetry: "Managed SNMP", active_scan: "Active scan", import: "Import" } as Record<AssetChangeSource, string>,
    fields: { name: "Name", hostname: "Hostname", ip_address: "IP address", mac_address: "MAC address", vendor: "Vendor", platform: "OS / Platform", device_type: "Device type", status: "Status", open_ports: "Open ports", detected_services: "Detected services" } as Record<AssetChangeField, string>,
  },
  id: {
    sheets: { summary: "Ringkasan", assets: "Aset", history: "Riwayat Perubahan" },
    reportTitle: "Judul laporan", generatedAt: "Dibuat pada", matchingAssets: "Total aset yang cocok", exportedAssets: "Aset diekspor", exportedHistory: "Peristiwa riwayat diekspor",
    assetLimit: "Batas ekspor aset", historyLimit: "Batas ekspor riwayat", truncated: "Tercapai - laporan memuat data pertama sesuai batas", notTruncated: "Tidak tercapai",
    criteria: "Kriteria aktif", value: "Nilai", search: "Pencarian", deviceType: "Tipe perangkat", vendor: "Vendor", os: "OS / Platform", status: "Status", sort: "Urutan", all: "Semua", nameAsc: "Nama A-Z", nameDesc: "Nama Z-A",
    statusCounts: "Jumlah status (aset diekspor)", deviceTypeCounts: "Jumlah tipe perangkat (aset diekspor)", evidenceCompleteness: "Kelengkapan bukti", count: "Jumlah", vendorKnown: "Vendor diketahui", vendorUnknown: "Vendor tidak diketahui", osKnown: "OS diketahui", osUnknown: "OS tidak diketahui",
    no: "No", assetId: "ID Aset", hostname: "Hostname", name: "Nama", currentIp: "IP Saat Ini", mac: "MAC", currentStatus: "Status Operasional Saat Ini", osConfidence: "Keyakinan OS", firstSeen: "Pertama Terlihat", lastSeen: "Terakhir Terlihat", source: "Sumber", openPorts: "Port Terbuka", services: "Layanan", snmpLinked: "Terhubung ke SNMP Terkelola", healthMonitored: "Dipantau Health Watch",
    eventTime: "Waktu Peristiwa", asset: "Aset", eventType: "Tipe Peristiwa", changedFields: "Field Berubah", before: "Sebelum", after: "Sesudah", scanReference: "Referensi Scan / Run",
    yes: "Ya", noValue: "Tidak", timestampFormat: "yyyy-mm-dd hh:mm:ss",
    statuses: { online: "Online", offline: "Offline", changed: "Berubah", unknown: "Tidak diketahui" } as Record<AssetStatus, string>,
    confidence: { low: "Rendah", medium: "Sedang", high: "Tinggi" }, eventTypes: { created: "Dibuat", changed: "Berubah" },
    sources: { manual: "Manual", discovery: "Discovery", observed_host: "Observed LAN Host", device_inspector: "Device Inspector", managed_telemetry: "SNMP Terkelola", active_scan: "Pemindaian aktif", import: "Impor" } as Record<AssetChangeSource, string>,
    fields: { name: "Nama", hostname: "Hostname", ip_address: "Alamat IP", mac_address: "Alamat MAC", vendor: "Vendor", platform: "OS / Platform", device_type: "Tipe perangkat", status: "Status", open_ports: "Port terbuka", detected_services: "Layanan terdeteksi" } as Record<AssetChangeField, string>,
  },
} as const;

type ReportLabels = (typeof REPORT_LABELS)[keyof typeof REPORT_LABELS];
