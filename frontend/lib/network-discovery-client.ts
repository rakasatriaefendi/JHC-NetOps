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
  capabilities: { operations?: string[]; targets?: unknown[] };
};

export function normalizeDiscoveryRunners(rows: readonly Record<string, unknown>[]): DiscoveryRunner[] {
  return rows.map((row): DiscoveryRunner | null => {
    const capabilities = record(row.capabilities) ? row.capabilities : null;
    const operations = capabilities && Array.isArray(capabilities.operations)
      ? capabilities.operations.filter((operation): operation is string => typeof operation === "string")
      : [];
    if (typeof row.id !== "string" || typeof row.display_name !== "string"
      || typeof row.last_seen_at !== "string"
      || (row.health_status !== "online" && row.health_status !== "degraded")) return null;
    return {
      id: row.id,
      display_name: row.display_name,
      last_seen_at: row.last_seen_at,
      health_status: row.health_status,
      capabilities: { operations },
    };
  }).filter((runner): runner is DiscoveryRunner => runner !== null);
}

export function isDiscoveryRunnerOnline(
  runner: DiscoveryRunner | null | undefined,
  nowMs = Date.now(),
) {
  if (!runner || runner.health_status !== "online") return false;
  const lastSeen = Date.parse(runner.last_seen_at);
  return Number.isFinite(lastSeen) && nowMs - lastSeen <= DISCOVERY_RUNNER_FRESHNESS_MS;
}

export function isDiscoveryRunnerAvailable(
  runner: DiscoveryRunner | null | undefined,
  nowMs = Date.now(),
) {
  return runner?.capabilities.operations?.includes("network_discovery") === true
    && isDiscoveryRunnerOnline(runner, nowMs);
}

export function observedTrafficIps(snapshots: { flows: { src_ip: string; dst_ip: string }[]; top_talkers: { ip: string }[] }[]) {
  return [...new Set(snapshots.flatMap((snapshot) => [
    ...snapshot.flows.flatMap((flow) => [flow.src_ip, flow.dst_ip]),
    ...snapshot.top_talkers.map((talker) => talker.ip),
  ]))];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
