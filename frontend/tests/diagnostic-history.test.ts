import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDiagnosticTrendSeries,
  filterDiagnosticTests,
  groupComparableDiagnosticTests,
  groupDiagnosticTests,
  resolveHistoryRange,
  summarizeDiagnosticTests,
  type DiagnosticHistoryData,
  type DiagnosticHistoryJob,
} from "../lib/diagnostic-history.ts";
import type { BandwidthMeasurement, HopMeasurement } from "../lib/diagnostics.ts";

const wifiJob = job("job-wifi", "IT Office", "wifi", "lan", "2026-08-11T08:05:00Z");
const ethernetJob = job("job-ethernet", "Floor 3", "ethernet", "lan", "2026-08-06T08:05:00Z");
const developmentJob = job("job-development", "Local Development", "wifi", "localhost_demo", "2026-08-11T09:05:00Z", "Localhost");

const fixture: DiagnosticHistoryData = {
  jobs: [wifiJob, ethernetJob, developmentJob],
  bandwidth: [
    bandwidth("wifi-upload", wifiJob, "upload", 50, "2026-08-11T08:00:00Z", 55, 45, 1),
    bandwidth("wifi-download", wifiJob, "download", 70, "2026-08-11T08:01:00Z", 75, 60, 0),
    bandwidth("ethernet-upload", ethernetJob, "upload", 90, "2026-08-06T08:00:00Z", 95, 85, 0),
    bandwidth("ethernet-download", ethernetJob, "download", 110, "2026-08-06T08:01:00Z", 115, 100, 0),
    bandwidth("development-upload", developmentJob, "upload", 400, "2026-08-11T09:00:00Z", 410, 390, 0),
    bandwidth("development-download", developmentJob, "download", 500, "2026-08-11T09:01:00Z", 510, 490, 0),
  ],
  hops: [
    hop("wifi-hop-2", wifiJob, 2, 8, 1),
    hop("wifi-hop-1", wifiJob, 1, 2, 0),
    hop("ethernet-hop", ethernetJob, 1, 3, 0),
    hop("development-hop", developmentJob, 1, 0.1, 0),
  ],
};

test("one job with upload and download becomes one timestamp and one table record", () => {
  const tests = groupDiagnosticTests(fixture, false);
  const wifi = tests.find((item) => item.jobId === wifiJob.id)!;

  assert.equal(tests.length, 2);
  assert.equal(wifi.upload?.bitrate_mbps, 50);
  assert.equal(wifi.download?.bitrate_mbps, 70);
  assert.equal(wifi.measuredAt, "2026-08-11T08:01:00Z");
  assert.deepEqual(wifi.hops.map((item) => item.hop_number), [1, 2]);
  assert.equal(wifi.highestPathLatencyMs, 8);
  assert.equal(wifi.highestPathLossPercent, 1);
});

test("trend series preserves actual jobs as upload and download nodes", () => {
  const tests = groupDiagnosticTests(fixture, false);
  const series = buildDiagnosticTrendSeries(tests);

  assert.equal(series.ordered.length, 2);
  assert.equal(series.upload.length, 2);
  assert.equal(series.download.length, 2);
  assert.deepEqual(series.upload.map((point) => point.test.jobId), [ethernetJob.id, wifiJob.id]);
  assert.deepEqual(series.download.map((point) => point.value), [110, 70]);
});

test("mixed filters create separate comparable trend groups", () => {
  const tests = groupDiagnosticTests(fixture, false);
  const groups = groupComparableDiagnosticTests(tests);

  assert.equal(groups.length, 2);
  assert.equal(groups[0].tests.length, 1);
  assert.match(groups[0].label, /IT Office.*WiFi/);
  assert.match(groups[1].label, /Floor 3.*Ethernet/);
});

test("source, target, WiFi, and Ethernet filters select comparable tests", () => {
  const tests = groupDiagnosticTests(fixture, false);
  const common = { includeDevelopment: false, from: "2026-08-01T00:00:00Z", to: "2026-08-12T00:00:00Z" };
  const wifi = filterDiagnosticTests(tests, { ...common, source: "IT Office", target: "Server 253", connectionType: "wifi" });
  const ethernet = filterDiagnosticTests(tests, { ...common, source: "Floor 3", target: "Server 253", connectionType: "ethernet" });

  assert.deepEqual(wifi.map((item) => item.jobId), [wifiJob.id]);
  assert.deepEqual(ethernet.map((item) => item.jobId), [ethernetJob.id]);
});

test("localhost development jobs are excluded by default and explicit when enabled", () => {
  const lanOnly = groupDiagnosticTests(fixture, false);
  const withDevelopment = groupDiagnosticTests(fixture, true);

  assert.equal(lanOnly.some((item) => item.environment === "localhost_demo"), false);
  assert.equal(withDevelopment.some((item) => item.jobId === developmentJob.id), true);
});

test("summary latest average highest and lowest values are correct", () => {
  const summary = summarizeDiagnosticTests(groupDiagnosticTests(fixture, false));

  assert.equal(summary.testsPerformed, 2);
  assert.deepEqual(summary.upload, { latest: 50, average: 70, highest: 90, lowest: 50 });
  assert.deepEqual(summary.download, { latest: 70, average: 90, highest: 110, lowest: 70 });
});

test("Today, 7-day, 30-day, and custom ranges use local calendar boundaries", () => {
  const now = new Date(2026, 7, 11, 15, 30, 0);
  const today = resolveHistoryRange("today", now)!;
  const sevenDays = resolveHistoryRange("7d", now)!;
  const thirtyDays = resolveHistoryRange("30d", now)!;
  const custom = resolveHistoryRange("custom", now, "2026-08-01", "2026-08-03")!;

  assert.deepEqual(localParts(today.from), [2026, 8, 11, 0, 0]);
  assert.deepEqual(localParts(sevenDays.from), [2026, 8, 5, 0, 0]);
  assert.deepEqual(localParts(thirtyDays.from), [2026, 7, 13, 0, 0]);
  assert.deepEqual(localParts(custom.from), [2026, 8, 1, 0, 0]);
  assert.deepEqual(localParts(custom.to), [2026, 8, 4, 0, 0]);
  assert.equal(resolveHistoryRange("custom", now, "2026-08-04", "2026-08-03"), null);
});

function job(id: string, source: string, connectionType: "wifi" | "ethernet", environment: "lan" | "localhost_demo", completedAt: string, target = "Server 253"): DiagnosticHistoryJob {
  return { id, source_label: source, target_label: target, target_host: target === "Localhost" ? "127.0.0.1" : "192.168.1.253", connection_type: connectionType, environment, duration_seconds: 10, network_context: null, route_context: null, preflight_context: null, created_at: completedAt, started_at: completedAt, completed_at: completedAt };
}

function bandwidth(id: string, owner: DiagnosticHistoryJob, direction: "upload" | "download", bitrate: number, measuredAt: string, peak: number, minimum: number, retransmits: number): BandwidthMeasurement {
  return { id, job_id: owner.id, source_label: owner.source_label, target_label: owner.target_label, target_host: owner.target_host, connection_type: owner.connection_type, bitrate_mbps: bitrate, jitter_ms: null, measured_at: measuredAt, direction, environment: owner.environment, peak_mbps: peak, minimum_mbps: minimum, transferred_mb: 100, retransmits, duration_seconds: owner.duration_seconds };
}

function hop(id: string, owner: DiagnosticHistoryJob, hopNumber: number, latency: number, loss: number): HopMeasurement {
  return { id, job_id: owner.id, session_id: `${owner.id}-session`, source_label: owner.source_label, target_label: owner.target_label, target_host: owner.target_host, connection_type: owner.connection_type, hop_number: hopNumber, hop_ip: `192.168.1.${hopNumber}`, avg_latency_ms: latency, loss_percent: loss, measured_at: owner.completed_at!, environment: owner.environment };
}

function localParts(timestamp: string) {
  const date = new Date(timestamp);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes()];
}
