import type { SupabaseClient } from "@supabase/supabase-js";

export type HealthStatus = "online" | "degraded" | "offline";

export type NetworkHealthTarget = {
  id: string;
  runner_id: string;
  enabled: boolean;
  critical: boolean;
  probe_interval_seconds: number;
  timeout_ms: number;
  failure_threshold: number;
  recovery_threshold: number;
  latency_warning_ms: number;
  loss_warning_percent: number;
  node: { id: string; ip_address: string; name: string; device_type: string | null; location: string | null; detected_fingerprint: import("@/lib/device-inspector").DeviceFingerprint | null; last_inspected_at: string | null };
  latest: { status: HealthStatus; latency_ms: number | null; packet_loss_percent: number; last_checked_at: string; last_success_at: string | null; consecutive_failures: number; sample_count: number } | null;
  diagnostic_target_id: string | null;
  manual_ping_available: boolean;
};

export type NetworkHealthEvent = {
  id: string;
  created_at: string;
  severity: "low" | "medium" | "high" | "critical";
  title: string;
  description: string;
  source_ref: string | null;
  resolved_at: string | null;
  raw_context: Record<string, unknown>;
};

export type NetworkHealthSample = {
  target_id: string;
  sampled_at: string;
  status: HealthStatus;
  latency_ms: number | null;
  packet_loss_percent: number;
  sample_count: number;
};

export type HealthTrendRange = "1h" | "6h" | "24h" | "7d";

export const HEALTH_TREND_RANGES: { value: HealthTrendRange; label: string; maxPoints: number }[] = [
  { value: "1h", label: "Last hour", maxPoints: 60 },
  { value: "6h", label: "Last 6 hours", maxPoints: 180 },
  { value: "24h", label: "Last 24 hours", maxPoints: 240 },
  { value: "7d", label: "Last 7 days", maxPoints: 480 },
];

export const HEALTH_TARGET_PAGE_SIZE = 10;

export function healthTargetPagination(total: number, requestedPage: number, pageSize = HEALTH_TARGET_PAGE_SIZE) {
  const boundedTotal = Math.max(0, Math.trunc(total));
  const boundedPageSize = Math.max(1, Math.trunc(pageSize));
  const pageCount = Math.max(1, Math.ceil(boundedTotal / boundedPageSize));
  const candidatePage = Number.isFinite(requestedPage) ? Math.trunc(requestedPage) : 0;
  const page = Math.min(Math.max(0, candidatePage), pageCount - 1);
  const start = page * boundedPageSize;
  const end = Math.min(start + boundedPageSize, boundedTotal);
  return { page, pageCount, start, end };
}

export async function loadNetworkHealth(supabase: SupabaseClient) {
  const [{ data: rows, error }, { data: runners }, { data: events, error: eventError }] = await Promise.all([
    supabase.from("network_targets").select("id,runner_id,enabled,critical,probe_interval_seconds,timeout_ms,failure_threshold,recovery_threshold,latency_warning_ms,loss_warning_percent,network_nodes!inner(id,ip_address,name,device_type,location,detected_fingerprint,last_inspected_at),network_health_latest(status,latency_ms,packet_loss_percent,last_checked_at,last_success_at,consecutive_failures,sample_count)").eq("enabled", true),
    supabase.from("diagnostic_runners").select("id,capabilities"),
    supabase.from("events").select("id,created_at,severity,title,description,source_ref,resolved_at,raw_context").eq("source", "network_health").order("created_at", { ascending: false }).limit(20),
  ]);
  if (error || eventError) return { data: [], events: [], error: true };
  const capabilityByRunner = new Map((runners ?? []).map((runner) => [runner.id, runner.capabilities]));
  const data = (rows ?? []).map((row): NetworkHealthTarget => {
    const node = relation(row.network_nodes) as NetworkHealthTarget["node"];
    const latest = relation(row.network_health_latest) as NetworkHealthTarget["latest"];
    const targets = Array.isArray(capabilityByRunner.get(row.runner_id)?.targets) ? capabilityByRunner.get(row.runner_id).targets : [];
    const diagnosticTarget = targets.find((target: { host?: string }) => target.host === node.ip_address);
    const operations = Array.isArray(capabilityByRunner.get(row.runner_id)?.operations)
      ? capabilityByRunner.get(row.runner_id).operations as unknown[]
      : [];
    return {
      ...row,
      node,
      latest,
      diagnostic_target_id: diagnosticTarget?.id ?? null,
      manual_ping_available: operations.includes("manual_ping"),
    } as NetworkHealthTarget;
  });
  return { data, events: (events ?? []) as NetworkHealthEvent[], error: false };
}

export async function loadHealthSamples(supabase: SupabaseClient, targetIds: string[], range: HealthTrendRange) {
  if (!targetIds.length) return { data: [], error: false };
  const now = new Date();
  const rangeMs = range === "1h" ? 3600000 : range === "6h" ? 21600000 : range === "24h" ? 86400000 : 604800000;
  const since = new Date(now.getTime() - rangeMs).toISOString();
  const maxPoints = HEALTH_TREND_RANGES.find(r => r.value === range)?.maxPoints ?? 240;

  // Calculate bucket interval in seconds to achieve roughly maxPoints across the range
  const bucketSeconds = Math.max(60, Math.ceil(rangeMs / 1000 / maxPoints));

  const { data, error } = await supabase.rpc("get_health_samples_downsampled", {
    p_target_ids: targetIds,
    p_since: since,
    p_bucket_seconds: bucketSeconds,
    p_limit: maxPoints,
  });
  if (error) return { data: [], error: true };
  return { data: (data ?? []) as NetworkHealthSample[], error: false };
}

function relation(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return Array.isArray(value) && value[0] && typeof value[0] === "object" ? value[0] as Record<string, unknown> : null;
}
