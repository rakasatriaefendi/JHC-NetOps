"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import { applicationAuthority, localEvents, localHealthTargets, localRunners } from "./application-persistence.ts";
import type {
  HealthStatus,
  NetworkHealthTarget,
  NetworkHealthEvent,
  NetworkHealthSample,
  HealthTrendRange,
} from "./network-health-client.ts";

export type {
  HealthStatus,
  NetworkHealthTarget,
  NetworkHealthEvent,
  NetworkHealthSample,
  HealthTrendRange,
};

export async function loadNetworkHealth(supabase: SupabaseClient) {
  if (applicationAuthority() === "local_postgres") {
    return loadNetworkHealthLocal();
  }
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

export async function loadNetworkHealthHistory(supabase: SupabaseClient) {
  if (applicationAuthority() === "local_postgres") {
    const events = await localEvents(100, "network_health");
    return { data: events ? events as NetworkHealthEvent[] : [], error: !events };
  }
  const { data, error } = await supabase.from("events")
    .select("id,created_at,severity,title,description,source_ref,resolved_at,raw_context")
    .eq("source", "network_health")
    .order("created_at", { ascending: false })
    .limit(100)
    .returns<NetworkHealthEvent[]>();
  return { data: data ?? [], error: Boolean(error) };
}

async function loadNetworkHealthLocal() {
  const [rows, runners, events] = await Promise.all([
    localHealthTargets(),
    localRunners(),
    localEvents(20, "network_health"),
  ]);
  if (!rows || !runners || !events) return { data: [], events: [], error: true };
  const capabilityByRunner = new Map(runners.map((runner) => [String(runner.id), relation(runner.capabilities)]));
  const data = rows.filter((row) => row.enabled === true).map((row): NetworkHealthTarget => {
    const node = relation(row.node) as NetworkHealthTarget["node"];
    const latest = relation(row.latest) as NetworkHealthTarget["latest"];
    const capabilities = capabilityByRunner.get(String(row.runner_id));
    const targets = Array.isArray(capabilities?.targets) ? capabilities.targets : [];
    const diagnosticTarget = targets.find((target) => relation(target)?.host === node.ip_address);
    const operations = Array.isArray(capabilities?.operations) ? capabilities.operations : [];
    return {
      ...row,
      node,
      latest,
      diagnostic_target_id: relation(diagnosticTarget)?.id ? String(relation(diagnosticTarget)!.id) : null,
      manual_ping_available: operations.includes("manual_ping"),
    } as NetworkHealthTarget;
  });
  return { data, events: events as NetworkHealthEvent[], error: false };
}

export async function loadHealthSamples(supabase: SupabaseClient, targetIds: string[], range: HealthTrendRange) {
  if (applicationAuthority() === "local_postgres") {
    // Local mode: samples not yet exposed via API; return empty
    return { data: [], error: false };
  }
  if (!targetIds.length) return { data: [], error: false };
  const now = new Date();
  const rangeMs = range === "1h" ? 3600000 : range === "6h" ? 21600000 : range === "24h" ? 86400000 : 604800000;
  const since = new Date(now.getTime() - rangeMs).toISOString();
  const { HEALTH_TREND_RANGES } = await import("./network-health-client.ts");
  const maxPoints = HEALTH_TREND_RANGES.find((r) => r.value === range)?.maxPoints ?? 240;

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
