"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import { applicationAuthority, localNetworkNodes, localRunner, localEvents } from "./application-persistence.ts";
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

async function loadNetworkHealthLocal() {
  const [nodes, runners, events] = await Promise.all([
    localNetworkNodes(),
    localRunner(""), // Not used for capabilities in local mode
    localEvents(20, "network_health"),
  ]);
  if (!nodes || !runners) return { data: [], events: [], error: true };
  const data = nodes.map((row): NetworkHealthTarget => {
    const node = {
      id: String(row.id),
      ip_address: String(row.ip_address),
      name: String(row.name),
      device_type: row.device_type ? String(row.device_type) : null,
      location: row.location ? String(row.location) : null,
      detected_fingerprint: row.detected_fingerprint as NetworkHealthTarget["node"]["detected_fingerprint"],
      last_inspected_at: row.last_inspected_at ? String(row.last_inspected_at) : null,
    };
    return {
      id: String(row.id),
      runner_id: "",
      enabled: true,
      critical: false,
      probe_interval_seconds: 30,
      timeout_ms: 1000,
      failure_threshold: 3,
      recovery_threshold: 2,
      latency_warning_ms: 100,
      loss_warning_percent: 40,
      node,
      latest: null,
      diagnostic_target_id: null,
      manual_ping_available: false,
    } as NetworkHealthTarget;
  });
  return { data, events: (events ?? []) as NetworkHealthEvent[], error: false };
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