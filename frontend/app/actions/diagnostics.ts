"use server";

import { requireApprovedProfile } from "@/lib/auth";
import { applicationAuthority, localBandwidthByJob, localBandwidthMeasurements, localDiagnosticJob,
  localDiagnosticJobs, localHopByJob, localHopMeasurements, localRunners,
  type ApplicationAuthority } from "@/lib/application-persistence";
import type { DiagnosticHistoryData, DiagnosticHistoryQuery } from "@/lib/diagnostic-history";
import { emptyHistoryData } from "@/lib/diagnostic-history";
import type { DiagnosticJobState } from "@/lib/diagnostic-jobs";
import type { DiagnosticsData } from "@/lib/diagnostics";

type Result<T> = Readonly<{ ok: boolean; authority: ApplicationAuthority; data: T }>;

export async function getDiagnosticJobStateAction(): Promise<Result<DiagnosticJobState>> {
  const { supabase } = await requireApprovedProfile();
  const authority = applicationAuthority();
  if (authority === "local_postgres") {
    const runners = await localRunners();
    if (!runners) return { ok: false, authority, data: emptyJobState() };
    const jobGroups = await Promise.all(runners.slice(0, 50).map((runner) =>
      typeof runner.id === "string" ? localDiagnosticJobs(runner.id) : Promise.resolve(null)));
    if (jobGroups.some((group) => group === null)) return { ok: false, authority, data: emptyJobState() };
    const jobs = jobGroups.flatMap((group) => group ?? [])
      .sort((left, right) => Date.parse(String(right.created_at)) - Date.parse(String(left.created_at)))
      .slice(0, 25);
    return { ok: true, authority, data: {
      runners: runners as DiagnosticJobState["runners"],
      jobs: jobs as DiagnosticJobState["jobs"],
      server_time: new Date().toISOString(),
    } };
  }
  const { data, error } = await supabase.functions.invoke<{ data: DiagnosticJobState }>(
    "diagnostic-jobs", { method: "GET" });
  return error || !data?.data
    ? { ok: false, authority, data: emptyJobState() }
    : { ok: true, authority, data: data.data };
}

export async function getDiagnosticsAction(): Promise<Result<DiagnosticsData>> {
  const { supabase } = await requireApprovedProfile();
  const authority = applicationAuthority();
  if (authority === "local_postgres") {
    const [bandwidth, hops] = await Promise.all([localBandwidthMeasurements(200), localHopMeasurements(512)]);
    return bandwidth && hops
      ? { ok: true, authority, data: { bandwidth: bandwidth as DiagnosticsData["bandwidth"], hops: hops as DiagnosticsData["hops"] } }
      : { ok: false, authority, data: emptyDiagnostics() };
  }
  const { data, error } = await supabase.functions.invoke<{ data: DiagnosticsData }>("diagnostics", { method: "GET" });
  return error || !data?.data
    ? { ok: false, authority, data: emptyDiagnostics() }
    : { ok: true, authority, data: data.data };
}

export async function getDiagnosticHistoryAction(query: DiagnosticHistoryQuery): Promise<Result<DiagnosticHistoryData>> {
  const { supabase } = await requireApprovedProfile();
  const authority = applicationAuthority();
  if (!validHistoryQuery(query)) return { ok: false, authority, data: emptyHistoryData() };
  if (authority === "local_postgres") {
    const bandwidth = await localBandwidthMeasurements(200);
    if (!bandwidth) return { ok: false, authority, data: emptyHistoryData() };
    const jobIds = [...new Set(bandwidth.filter((row) => historyMeasurement(row, query))
      .flatMap((row) => typeof row.job_id === "string" ? [row.job_id] : []))].slice(0, 100);
    const correlated = await Promise.all(jobIds.map(async (jobId) => ({
      job: await localDiagnosticJob(jobId),
      bandwidth: await localBandwidthByJob(jobId),
      hops: await localHopByJob(jobId),
    })));
    if (correlated.some((item) => !item.job || !item.bandwidth || !item.hops)) {
      return { ok: false, authority, data: emptyHistoryData() };
    }
    const completed = correlated.filter((item) => item.job?.status === "completed");
    return { ok: true, authority, data: {
      jobs: completed.map((item) => item.job) as DiagnosticHistoryData["jobs"],
      bandwidth: completed.flatMap((item) => item.bandwidth ?? []) as DiagnosticHistoryData["bandwidth"],
      hops: completed.flatMap((item) => item.hops ?? []) as DiagnosticHistoryData["hops"],
    } };
  }
  const params = new URLSearchParams({ view: "history", from: query.from, to: query.to,
    source: query.source, target: query.target, connection_type: query.connectionType,
    include_development: String(query.includeDevelopment) });
  const { data, error } = await supabase.functions.invoke<{ data: DiagnosticHistoryData }>(
    `diagnostics?${params.toString()}`, { method: "GET" });
  return error || !data?.data
    ? { ok: false, authority, data: emptyHistoryData() }
    : { ok: true, authority, data: data.data };
}

function historyMeasurement(row: Record<string, unknown>, query: DiagnosticHistoryQuery): boolean {
  const measuredAt = typeof row.measured_at === "string" ? Date.parse(row.measured_at) : Number.NaN;
  return Number.isFinite(measuredAt) && measuredAt >= Date.parse(query.from) && measuredAt < Date.parse(query.to) &&
    (query.source === "all" || row.source_label === query.source) &&
    (query.target === "all" || row.target_label === query.target) &&
    (query.connectionType === "all" || row.connection_type === query.connectionType) &&
    (query.includeDevelopment || row.environment === "lan");
}

function validHistoryQuery(query: DiagnosticHistoryQuery): boolean {
  const from = Date.parse(query.from);
  const to = Date.parse(query.to);
  return Number.isFinite(from) && Number.isFinite(to) && from < to &&
    query.source.length > 0 && query.source.length <= 200 && !/[\r\n]/.test(query.source) &&
    query.target.length > 0 && query.target.length <= 200 && !/[\r\n]/.test(query.target) &&
    ["all", "wifi", "ethernet"].includes(query.connectionType) &&
    typeof query.includeDevelopment === "boolean";
}

function emptyJobState(): DiagnosticJobState {
  return { runners: [], jobs: [], server_time: new Date().toISOString() };
}

function emptyDiagnostics(): DiagnosticsData {
  return { bandwidth: [], hops: [] };
}
