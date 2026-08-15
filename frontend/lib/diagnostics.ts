import type { SupabaseClient } from "@supabase/supabase-js";

export type ConnectionType = "wifi" | "ethernet";
export type DiagnosticDirection = "upload" | "download";
export type DiagnosticEnvironment = "lan" | "localhost_demo";
export type DiagnosticSortOrder = "newest" | "oldest";

export type BandwidthMeasurement = {
  id: string;
  source_label: string;
  target_label: string;
  target_host: string | null;
  connection_type: ConnectionType | null;
  bitrate_mbps: number;
  jitter_ms: number | null;
  measured_at: string;
  job_id: string | null;
  direction: DiagnosticDirection | null;
  environment: DiagnosticEnvironment | null;
  peak_mbps: number | null;
  minimum_mbps: number | null;
  transferred_mb: number | null;
  retransmits: number | null;
  duration_seconds: number | null;
};

export type HopMeasurement = {
  id: string;
  session_id: string;
  source_label: string | null;
  target_label: string | null;
  target_host: string | null;
  connection_type: ConnectionType | null;
  hop_number: number;
  hop_ip: string | null;
  avg_latency_ms: number | null;
  loss_percent: number;
  measured_at: string;
  job_id: string | null;
  environment: DiagnosticEnvironment | null;
};

export type DiagnosticsData = {
  bandwidth: BandwidthMeasurement[];
  hops: HopMeasurement[];
};

export type HopMeasurementSession = {
  sessionId: string;
  hops: HopMeasurement[];
  measuredAt: string;
  sourceLabel: string | null;
  targetLabel: string | null;
  targetHost: string | null;
  connectionType: ConnectionType | null;
  environment: DiagnosticEnvironment | null;
};

export type DiagnosticsFilters = {
  source: string;
  target: string;
  connectionType: "all" | ConnectionType;
};

export type BandwidthComparisonRow = BandwidthMeasurement;

type DiagnosticsResponse = {
  data: DiagnosticsData;
};

export async function loadDiagnostics(
  supabase: SupabaseClient,
): Promise<{ data: DiagnosticsData; error: boolean }> {
  const { data, error } = await supabase.functions.invoke<DiagnosticsResponse>(
    "diagnostics",
    { method: "GET" },
  );

  if (error || !data?.data) {
    return {
      data: { bandwidth: [], hops: [] },
      error: true,
    };
  }

  return { data: data.data, error: false };
}

export function filterDiagnostics(
  data: DiagnosticsData,
  filters: DiagnosticsFilters,
): DiagnosticsData {
  return {
    bandwidth: data.bandwidth.filter(
      (measurement) =>
        matchesLabel(measurement.source_label, filters.source) &&
        matchesLabel(measurement.target_label, filters.target) &&
        matchesConnection(measurement.connection_type, filters.connectionType),
    ),
    hops: data.hops.filter(
      (measurement) =>
        matchesLabel(measurement.source_label, filters.source) &&
        matchesLabel(measurement.target_label, filters.target) &&
        matchesConnection(measurement.connection_type, filters.connectionType),
    ),
  };
}

export function latestBandwidthComparisons(
  measurements: BandwidthMeasurement[],
  sortOrder: DiagnosticSortOrder = "newest",
): BandwidthComparisonRow[] {
  const latest = new Map<string, BandwidthMeasurement>();

  for (const measurement of measurements) {
    const key = [
      measurement.target_label,
      measurement.target_host ?? "",
      measurement.source_label,
      measurement.connection_type ?? "legacy",
      measurement.direction ?? "legacy",
    ].join("\u0000");
    const current = latest.get(key);
    if (!current || Date.parse(measurement.measured_at) > Date.parse(current.measured_at)) {
      latest.set(key, measurement);
    }
  }

  return Array.from(latest.values()).sort((left, right) =>
    compareDiagnosticTimestamps(left.measured_at, right.measured_at, sortOrder),
  );
}

export function compareDiagnosticTimestamps(
  left: string,
  right: string,
  sortOrder: DiagnosticSortOrder,
) {
  const difference = Date.parse(left) - Date.parse(right);
  return sortOrder === "oldest" ? difference : -difference;
}

export function groupHopMeasurementSessions(
  measurements: HopMeasurement[],
  sortOrder: DiagnosticSortOrder = "newest",
): HopMeasurementSession[] {
  const grouped = new Map<string, HopMeasurement[]>();
  for (const measurement of measurements) {
    grouped.set(
      measurement.session_id,
      [...(grouped.get(measurement.session_id) ?? []), measurement],
    );
  }

  return Array.from(grouped.entries())
    .map(([sessionId, hops]) => {
      const orderedHops = hops.toSorted(
        (left, right) => left.hop_number - right.hop_number,
      );
      const first = orderedHops[0];
      return {
        sessionId,
        hops: orderedHops,
        measuredAt: first.measured_at,
        sourceLabel: first.source_label,
        targetLabel: first.target_label,
        targetHost: first.target_host,
        connectionType: first.connection_type,
        environment: first.environment,
      };
    })
    .sort((left, right) =>
      compareDiagnosticTimestamps(left.measuredAt, right.measuredAt, sortOrder),
    );
}

function matchesLabel(value: string | null, filter: string) {
  return filter === "all" || value === filter;
}

function matchesConnection(
  value: ConnectionType | null,
  filter: DiagnosticsFilters["connectionType"],
) {
  return filter === "all" || value === filter;
}
