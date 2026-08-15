import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  BandwidthMeasurement,
  ConnectionType,
  DiagnosticEnvironment,
  HopMeasurement,
} from "@/lib/diagnostics";
import type { NetworkContext, PreflightContext, RouteContext } from "@/lib/diagnostic-jobs";

export type HistoryPeriod = "today" | "7d" | "30d" | "custom";

export type DiagnosticHistoryJob = {
  id: string;
  source_label: string;
  target_label: string;
  target_host: string;
  connection_type: ConnectionType;
  environment: DiagnosticEnvironment;
  duration_seconds: number;
  network_context: NetworkContext | null;
  route_context: RouteContext | null;
  preflight_context: PreflightContext | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

export type DiagnosticHistoryData = {
  jobs: DiagnosticHistoryJob[];
  bandwidth: BandwidthMeasurement[];
  hops: HopMeasurement[];
};

export type DiagnosticHistoryQuery = {
  source: string;
  target: string;
  connectionType: "all" | ConnectionType;
  includeDevelopment: boolean;
  from: string;
  to: string;
};

export type DiagnosticTest = {
  jobId: string;
  sourceLabel: string;
  targetLabel: string;
  targetHost: string;
  connectionType: ConnectionType;
  environment: DiagnosticEnvironment;
  durationSeconds: number;
  measuredAt: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  networkContext: NetworkContext | null;
  routeContext: RouteContext | null;
  upload: BandwidthMeasurement | null;
  download: BandwidthMeasurement | null;
  hops: HopMeasurement[];
  highestPathLatencyMs: number | null;
  highestPathLossPercent: number | null;
};

export type SeriesSummary = {
  latest: number | null;
  average: number | null;
  highest: number | null;
  lowest: number | null;
};

export type DiagnosticHistorySummary = {
  testsPerformed: number;
  upload: SeriesSummary;
  download: SeriesSummary;
};

export type DiagnosticTrendPoint = {
  test: DiagnosticTest;
  value: number;
};

export type ComparableDiagnosticGroup = {
  key: string;
  label: string;
  tests: DiagnosticTest[];
};

type DiagnosticHistoryResponse = {
  data: DiagnosticHistoryData;
};

export async function loadDiagnosticHistory(
  supabase: SupabaseClient,
  query: DiagnosticHistoryQuery,
): Promise<{ data: DiagnosticHistoryData; error: boolean }> {
  const params = new URLSearchParams({
    view: "history",
    from: query.from,
    to: query.to,
    source: query.source,
    target: query.target,
    connection_type: query.connectionType,
    include_development: String(query.includeDevelopment),
  });
  const { data, error } = await supabase.functions.invoke<DiagnosticHistoryResponse>(
    `diagnostics?${params.toString()}`,
    { method: "GET" },
  );

  if (error || !data?.data) {
    return { data: emptyHistoryData(), error: true };
  }
  return { data: data.data, error: false };
}

export function resolveHistoryRange(
  period: HistoryPeriod,
  now = new Date(),
  customStart?: string,
  customEnd?: string,
): { from: string; to: string } | null {
  if (period === "custom") {
    if (!customStart || !customEnd) return null;
    const from = localDateStart(customStart);
    const to = localDateStart(customEnd);
    if (!from || !to || from.getTime() > to.getTime()) return null;
    to.setDate(to.getDate() + 1);
    return { from: from.toISOString(), to: to.toISOString() };
  }

  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  if (period === "7d") from.setDate(from.getDate() - 6);
  if (period === "30d") from.setDate(from.getDate() - 29);
  return { from: from.toISOString(), to: now.toISOString() };
}

export function groupDiagnosticTests(
  data: DiagnosticHistoryData,
  includeDevelopment: boolean,
): DiagnosticTest[] {
  const bandwidthByJob = new Map<string, BandwidthMeasurement[]>();
  const hopsByJob = new Map<string, HopMeasurement[]>();

  for (const measurement of data.bandwidth) {
    if (!measurement.job_id) continue;
    const values = bandwidthByJob.get(measurement.job_id) ?? [];
    values.push(measurement);
    bandwidthByJob.set(measurement.job_id, values);
  }
  for (const hop of data.hops) {
    if (!hop.job_id) continue;
    const values = hopsByJob.get(hop.job_id) ?? [];
    values.push(hop);
    hopsByJob.set(hop.job_id, values);
  }

  return data.jobs
    .filter((job) => includeDevelopment || job.environment === "lan")
    .flatMap((job) => {
      const bandwidth = bandwidthByJob.get(job.id) ?? [];
      const upload = latestDirection(bandwidth, "upload");
      const download = latestDirection(bandwidth, "download");
      if (!upload && !download) return [];
      const hops = (hopsByJob.get(job.id) ?? []).toSorted(
        (left, right) => left.hop_number - right.hop_number,
      );
      const measuredAt = [upload?.measured_at, download?.measured_at]
        .filter((value): value is string => Boolean(value))
        .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
      const latencies = hops.flatMap((hop) =>
        hop.avg_latency_ms === null ? [] : [hop.avg_latency_ms],
      );
      const losses = hops.map((hop) => hop.loss_percent);

      return [{
        jobId: job.id,
        sourceLabel: job.source_label,
        targetLabel: job.target_label,
        targetHost: job.target_host,
        connectionType: job.connection_type,
        environment: job.environment,
        durationSeconds: job.duration_seconds,
        measuredAt,
        createdAt: job.created_at,
        startedAt: job.started_at,
        completedAt: job.completed_at,
        networkContext: job.network_context,
        routeContext: job.route_context,
        upload,
        download,
        hops,
        highestPathLatencyMs: latencies.length ? Math.max(...latencies) : null,
        highestPathLossPercent: losses.length ? Math.max(...losses) : null,
      }];
    })
    .sort((left, right) => Date.parse(right.measuredAt) - Date.parse(left.measuredAt));
}

export function filterDiagnosticTests(
  tests: DiagnosticTest[],
  query: DiagnosticHistoryQuery,
): DiagnosticTest[] {
  const from = Date.parse(query.from);
  const to = Date.parse(query.to);
  return tests.filter((test) =>
    Date.parse(test.measuredAt) >= from &&
    Date.parse(test.measuredAt) < to &&
    (query.source === "all" || test.sourceLabel === query.source) &&
    (query.target === "all" || test.targetLabel === query.target) &&
    (query.connectionType === "all" || test.connectionType === query.connectionType) &&
    (query.includeDevelopment || test.environment === "lan"),
  );
}

export function summarizeDiagnosticTests(
  tests: DiagnosticTest[],
): DiagnosticHistorySummary {
  return {
    testsPerformed: tests.length,
    upload: summarizeSeries(tests, "upload"),
    download: summarizeSeries(tests, "download"),
  };
}

export function buildDiagnosticTrendSeries(tests: DiagnosticTest[]) {
  const ordered = tests.toSorted(
    (left, right) => Date.parse(left.measuredAt) - Date.parse(right.measuredAt),
  );
  return {
    ordered,
    upload: ordered.flatMap((test) =>
      test.upload ? [{ test, value: test.upload.bitrate_mbps }] : [],
    ),
    download: ordered.flatMap((test) =>
      test.download ? [{ test, value: test.download.bitrate_mbps }] : [],
    ),
  };
}

export function groupComparableDiagnosticTests(
  tests: DiagnosticTest[],
): ComparableDiagnosticGroup[] {
  const groups = new Map<string, DiagnosticTest[]>();
  for (const test of tests) {
    const key = [
      test.sourceLabel,
      test.targetLabel,
      test.targetHost,
      test.connectionType,
      test.environment,
    ].join("\u0000");
    const values = groups.get(key) ?? [];
    values.push(test);
    groups.set(key, values);
  }

  return Array.from(groups.entries())
    .map(([key, values]) => {
      const ordered = values.toSorted(
        (left, right) => Date.parse(right.measuredAt) - Date.parse(left.measuredAt),
      );
      const latest = ordered[0];
      return {
        key,
        label: `${latest.sourceLabel} → ${latest.targetLabel} · ${
          latest.connectionType === "wifi" ? "WiFi" : "Ethernet"
        }${latest.environment === "localhost_demo" ? " · TEST" : ""}`,
        tests: ordered,
      };
    })
    .sort(
      (left, right) =>
        Date.parse(right.tests[0].measuredAt) - Date.parse(left.tests[0].measuredAt),
    );
}

export function emptyHistoryData(): DiagnosticHistoryData {
  return { jobs: [], bandwidth: [], hops: [] };
}

function latestDirection(
  measurements: BandwidthMeasurement[],
  direction: "upload" | "download",
) {
  return measurements
    .filter((measurement) => measurement.direction === direction)
    .sort((left, right) => Date.parse(right.measured_at) - Date.parse(left.measured_at))[0] ?? null;
}

function summarizeSeries(
  tests: DiagnosticTest[],
  direction: "upload" | "download",
): SeriesSummary {
  const measurements = tests
    .flatMap((test) => test[direction] ? [test[direction]] : [])
    .toSorted((left, right) => Date.parse(left.measured_at) - Date.parse(right.measured_at));
  const values = measurements.map((measurement) => measurement.bitrate_mbps);
  if (!values.length) return { latest: null, average: null, highest: null, lowest: null };
  return {
    latest: values.at(-1) ?? null,
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
    highest: Math.max(...values),
    lowest: Math.min(...values),
  };
}

function localDateStart(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}
