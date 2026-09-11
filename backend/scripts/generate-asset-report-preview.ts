import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { normalizeAssetChangeSnapshot } from "../src/assets/change.js";
import type { AssetChangeEvent } from "../src/assets/change-contract.js";
import type { AssetRecord } from "../src/assets/contract.js";
import { buildAssetWorkbook } from "../src/assets/report-workbook.js";

const generatedAt = new Date("2026-09-11T08:00:00Z");
const base: AssetRecord = {
  id: "11111111-1111-4111-8111-111111111111", name: "Core Switch", hostname: "core-switch", device_type: "switch_network", status: "online",
  ip_address: "192.168.10.1", mac_address: "00:11:22:33:44:55", vendor: "Network Vendor", platform: "Network OS", first_seen_at: "2026-09-01T00:00:00Z", last_seen_at: generatedAt.toISOString(), source: "managed_telemetry", classification_confidence: "high", os_confidence: "high",
  classification_evidence: [{ source: "snmp", label: "System name", value: "core-switch" }], open_ports: [22, 443], detected_services: [{ protocol: "tcp", port: 443, name: "https", product: "Management UI" }], latency_ms: 1.2, evidence_updated_at: generatedAt.toISOString(), network_node_ref: null, health_target_ref: "33333333-3333-4333-8333-333333333333", managed_telemetry_target_ref: "44444444-4444-4444-8444-444444444444", observed_host_target_ref: null,
};
const assets: AssetRecord[] = [
  base,
  { ...base, id: "22222222-2222-4222-8222-222222222222", name: "Manual Printer", hostname: null, device_type: "printer", source: "manual", ip_address: "192.168.10.20", vendor: null, platform: null, mac_address: null, open_ports: [], detected_services: [], health_target_ref: null, managed_telemetry_target_ref: null },
  { ...base, id: "33333333-3333-4333-8333-333333333333", name: "Deep Scan Server", hostname: "scan-server", device_type: "linux_unix_server", source: "active_scan", ip_address: "192.168.10.30", managed_telemetry_target_ref: null, health_target_ref: null },
  { ...base, id: "44444444-4444-4444-8444-444444444444", name: "=SUM(1,1)", hostname: "+formula-host", device_type: "unknown", status: "unknown", source: "manual", ip_address: null, mac_address: null, vendor: "@vendor", platform: null, health_target_ref: null, managed_telemetry_target_ref: null },
];
const previous = { ...base, name: "Old Core Switch", mac_address: "00:11:22:33:44:54" };
const history: AssetChangeEvent[] = [{
  id: "55555555-5555-4555-8555-555555555555", asset_id: base.id, scan_run_id: null, asset_stable_key: "node:preview-core", event_type: "changed", source: "managed_telemetry", observed_at: generatedAt.toISOString(), recorded_at: generatedAt.toISOString(), changed_fields: ["name", "mac_address"], before_state: normalizeAssetChangeSnapshot(previous), after_state: normalizeAssetChangeSnapshot(base),
}];
const logo = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const report = await buildAssetWorkbook(
  { assets, history, matchingAssetCount: assets.length, assetsTruncated: false, historyTruncated: false },
  { inventory: { search: "", deviceType: null, vendor: null, platform: null, status: null, sort: "name_asc", page: 1, pageSize: 10 }, language: "id" },
  generatedAt,
  { branding: { institution_name: "Contoh Institusi", division_name: "Divisi Teknologi Informasi", logo_available: true, logo_mime_type: "image/png", updated_at: generatedAt.toISOString() }, logo: { bytes: logo, mimeType: "image/png", extension: "png", width: 2, height: 1 } },
);
const directory = resolve("test-output");
await mkdir(directory, { recursive: true });
const destination = resolve(directory, "P10E-asset-report-preview.xlsx");
await writeFile(destination, report.buffer);
process.stdout.write(`Fixture workbook written to ${destination}\n`);
