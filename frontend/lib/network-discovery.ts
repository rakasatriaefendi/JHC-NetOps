import type { SupabaseClient } from "@supabase/supabase-js";

export type DiscoveryHost = {
  ip_address: string;
  evidence: ("icmp" | "neighbor")[];
  latency_ms: number | null;
  is_this_device: boolean;
  is_gateway: boolean;
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
