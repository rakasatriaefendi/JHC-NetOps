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
    return { ...row, node, latest, diagnostic_target_id: diagnosticTarget?.id ?? null } as NetworkHealthTarget;
  });
  return { data, events: (events ?? []) as NetworkHealthEvent[], error: false };
}

function relation(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return Array.isArray(value) && value[0] && typeof value[0] === "object" ? value[0] as Record<string, unknown> : null;
}
