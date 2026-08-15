import assert from "node:assert/strict";
import test from "node:test";

import {
  compareDiagnosticTimestamps,
  filterDiagnostics,
  groupHopMeasurementSessions,
  latestBandwidthComparisons,
  type BandwidthMeasurement,
  type DiagnosticsData,
} from "../lib/diagnostics.ts";

const bandwidth: BandwidthMeasurement[] = [
  measurement("wifi-old", "IT Office", "wifi", 70, "2026-08-11T01:00:00Z"),
  measurement("wifi-new", "IT Office", "wifi", 82, "2026-08-11T02:00:00Z"),
  measurement("ethernet", "IT Office", "ethernet", 94, "2026-08-11T03:00:00Z"),
  measurement("floor-7", "Floor 7 Corridor A", "wifi", 34, "2026-08-11T04:00:00Z"),
  measurement("other-target", "IT Office", "wifi", 55, "2026-08-11T05:00:00Z", "Server 10"),
  measurement("legacy", "Legacy desk", null, 10, "2026-08-11T00:00:00Z"),
];

const data: DiagnosticsData = {
  bandwidth,
  hops: [
    {
      id: "hop-wifi",
      session_id: "00000000-0000-4000-8000-000000000001",
      source_label: "Floor 7 Corridor A",
      target_label: "Server 253",
      target_host: "192.168.1.253",
      connection_type: "wifi",
      hop_number: 1,
      hop_ip: "192.168.1.1",
      avg_latency_ms: 2,
      loss_percent: 0,
      measured_at: "2026-08-11T04:00:00Z",
      job_id: null,
      environment: null,
    },
    {
      id: "hop-legacy",
      session_id: "00000000-0000-4000-8000-000000000002",
      source_label: null,
      target_label: null,
      target_host: null,
      connection_type: null,
      hop_number: 1,
      hop_ip: "127.0.0.1",
      avg_latency_ms: 0.1,
      loss_percent: 0,
      measured_at: "2026-08-11T00:00:00Z",
      job_id: null,
      environment: null,
    },
  ],
};

test("filters source, target, and explicit connection type", () => {
  const filtered = filterDiagnostics(data, {
    source: "IT Office",
    target: "Server 253",
    connectionType: "ethernet",
  });

  assert.deepEqual(filtered.bandwidth.map((item) => item.id), ["ethernet"]);
  assert.equal(filtered.hops.length, 0);
});

test("all filter preserves legacy rows with null connection context", () => {
  const filtered = filterDiagnostics(data, {
    source: "all",
    target: "all",
    connectionType: "all",
  });

  assert.equal(filtered.bandwidth.length, bandwidth.length);
  assert.equal(filtered.hops.length, 2);
  assert.ok(filtered.bandwidth.some((item) => item.connection_type === null));
});

test("comparison keeps latest value per target, source, and connection", () => {
  const rows = latestBandwidthComparisons(
    data.bandwidth.filter((item) => item.target_label === "Server 253"),
  );

  assert.equal(rows.length, 4);
  assert.equal(rows.find((item) => item.id === "wifi-old"), undefined);
  assert.equal(rows.find((item) => item.id === "wifi-new")?.bitrate_mbps, 82);
  assert.equal(rows.find((item) => item.id === "ethernet")?.bitrate_mbps, 94);
  assert.equal(rows.find((item) => item.id === "floor-7")?.bitrate_mbps, 34);
  assert.deepEqual(rows.map((item) => item.id), [
    "floor-7",
    "ethernet",
    "wifi-new",
    "legacy",
  ]);
});

test("diagnostic timestamp sorting supports newest and oldest order", () => {
  const timestamps = [
    "2026-08-11T02:00:00Z",
    "2026-08-11T04:00:00Z",
    "2026-08-11T01:00:00Z",
  ];

  assert.deepEqual(
    timestamps.toSorted((left, right) =>
      compareDiagnosticTimestamps(left, right, "newest"),
    ),
    ["2026-08-11T04:00:00Z", "2026-08-11T02:00:00Z", "2026-08-11T01:00:00Z"],
  );
  assert.deepEqual(
    timestamps.toSorted((left, right) =>
      compareDiagnosticTimestamps(left, right, "oldest"),
    ),
    ["2026-08-11T01:00:00Z", "2026-08-11T02:00:00Z", "2026-08-11T04:00:00Z"],
  );
});

test("MTR sessions always preserve ascending factual hop_number order", () => {
  const outOfOrder = [
    { ...data.hops[0], id: "hop-3", hop_number: 3 },
    { ...data.hops[0], id: "hop-1", hop_number: 1 },
    { ...data.hops[0], id: "hop-2", hop_number: 2 },
  ];

  const sessions = groupHopMeasurementSessions(outOfOrder);
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0].hops.map((hop) => hop.hop_number), [1, 2, 3]);
});

function measurement(
  id: string,
  source: string,
  connectionType: BandwidthMeasurement["connection_type"],
  bitrate: number,
  measuredAt: string,
  targetLabel = "Server 253",
): BandwidthMeasurement {
  return {
    id,
    source_label: source,
    target_label: targetLabel,
    target_host: targetLabel === "Server 253" ? "192.168.1.253" : "192.168.1.10",
    connection_type: connectionType,
    bitrate_mbps: bitrate,
    jitter_ms: null,
    measured_at: measuredAt,
    job_id: null,
    direction: null,
    environment: null,
    peak_mbps: null,
    minimum_mbps: null,
    transferred_mb: null,
    retransmits: null,
    duration_seconds: null,
  };
}
