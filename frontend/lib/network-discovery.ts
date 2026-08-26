import type { SupabaseClient } from "@supabase/supabase-js";

export type DiscoveryHost = {
  ip_address: string;
  evidence: ("icmp" | "neighbor")[];
  latency_ms: number | null;
  is_this_device: boolean;
  is_gateway: boolean;
  reachability_evidence?: "icmp_verified" | "l2_observed" | "cached_only";
  neighbor_state?: "Reachable" | "Stale" | "Delay" | "Probe" | "Permanent";
};

export type DiscoverySession = {
  runner_id: string;
  session_id: string;
  requested_by: string;
  status: "idle" | "queued" | "running" | "completed" | "failed" | "expired";
  phase: "prepare" | "scan";
  connection_type: "wifi" | "ethernet" | "unknown" | null;
  interface_alias: string | null;
  local_ipv4: string | null;
  subnet_cidr: string | null;
  total_hosts: number;
  scanned_hosts: number;
  found_count: number;
  results: DiscoveryHost[];
  error_code: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  expires_at: string;
  updated_at: string;
};

export const DISCOVERY_RUNNER_FRESHNESS_MS = 30_000;

export type DiscoveryRunner = {
  id: string;
  display_name: string;
  last_seen_at: string;
  health_status: "online" | "degraded";
  capabilities: { operations?: string[] };
};

export function isDiscoveryRunnerOnline(
  runner: DiscoveryRunner | null | undefined,
  nowMs = Date.now(),
) {
  if (!runner || runner.health_status !== "online") return false;
  const lastSeen = Date.parse(runner.last_seen_at);
  return Number.isFinite(lastSeen) && nowMs - lastSeen <= DISCOVERY_RUNNER_FRESHNESS_MS;
}

export async function loadDiscoverySessions(supabase: SupabaseClient, isAdmin: boolean) {
  if (!isAdmin) return { data: [] as DiscoverySession[], error: false };
  const { data, error } = await supabase.from("network_discovery_sessions").select("*").limit(50).returns<DiscoverySession[]>();
  return { data: data ?? [], error: Boolean(error) };
}

export function observedTrafficIps(snapshots: { flows: { src_ip: string; dst_ip: string }[]; top_talkers: { ip: string }[] }[]) {
  return [...new Set(snapshots.flatMap((snapshot) => [
    ...snapshot.flows.flatMap((flow) => [flow.src_ip, flow.dst_ip]),
    ...snapshot.top_talkers.map((talker) => talker.ip),
  ]))];
}
