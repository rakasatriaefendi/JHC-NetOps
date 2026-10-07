import type { DiagnosticRunner } from "@/lib/diagnostic-jobs";
import type { ProfileRole } from "@/lib/authorization";
import { isRunnerHeartbeatFresh, RUNNER_FRESHNESS_MS } from "./runner-freshness.ts";

export type TrafficFlow = { flow_key:string; src_ip:string; dst_ip:string; src_port:number|null; dst_port:number|null; protocol:"tcp"|"udp"|"icmp"; service:string|null; first_seen:string; last_seen:string; total_bytes:number; packet_count:number; bytes_delta:number; packets_delta:number; packets_per_second:number; rate_mbps:number; peak_rate_mbps:number; rate_trend:"increasing"|"decreasing"|"stable"; status:"active"|"idle" };
export type Conversation = { endpoint_a:string; endpoint_b:string; a_to_b_bytes:number; b_to_a_bytes:number; total_bytes:number; rate_mbps:number; active_flows:number; first_seen:string; last_seen:string; protocol:string; service:string|null };
export type TopTalker = { ip:string; rate_mbps:number; total_bytes:number; active_flows:number };
export type TrafficSummary = { observed_tx_mbps:number; observed_rx_mbps:number; packets_observed:number; packets_per_second:number; active_flows:number; dominant_protocol:string|null };
export type TrafficSnapshot = { runner_id:string; session_id:string; captured_at:string; summary:TrafficSummary; flows:TrafficFlow[]; conversations:Conversation[]; top_talkers:TopTalker[]; payload_bytes:number; updated_at:string };
export type TrafficSession = { id:string; runner_id:string; requested_by:string; status:"queued"|"running"|"stopping"|"completed"|"failed"|"expired"; duration_seconds:number; capture_scope:"this_device"; stage:string; error_code:string|null; error_message:string|null; created_at:string; started_at:string|null; expires_at:string|null; completed_at:string|null; updated_at:string };
export type StorageStatus = { storage_mb:number|string; status:"healthy"|"warning"|"critical" };
export type TrafficState = { runners:DiagnosticRunner[]; sessions:TrafficSession[]; snapshots:TrafficSnapshot[]; storage_status:StorageStatus; role:ProfileRole; server_time:string };
export const TRAFFIC_RUNNER_FRESHNESS_MS = RUNNER_FRESHNESS_MS;
export type TrafficRunnerSnapshot = Pick<DiagnosticRunner, "id" | "display_name" | "last_seen_at" | "health_status"> & {
  capabilities: Pick<DiagnosticRunner["capabilities"], "operations" | "traffic_durations_seconds">;
};

export const emptyTrafficState = (role:ProfileRole="viewer"):TrafficState => ({runners:[],sessions:[],snapshots:[],storage_status:{storage_mb:0,status:"healthy"},role,server_time:new Date().toISOString()});

export function normalizeTrafficRunnerSnapshots(rows: readonly Record<string, unknown>[]): TrafficRunnerSnapshot[] {
  return rows.map((row): TrafficRunnerSnapshot | null => {
    const capabilities = record(row.capabilities) ? row.capabilities : null;
    const operations = capabilities && Array.isArray(capabilities.operations)
      ? capabilities.operations.filter((operation): operation is DiagnosticRunner["capabilities"]["operations"][number] =>
        typeof operation === "string" && ["bandwidth_and_path", "traffic_live", "network_discovery", "device_inspect", "manual_ping"].includes(operation))
      : [];
    const durations = capabilities && Array.isArray(capabilities.traffic_durations_seconds)
      ? capabilities.traffic_durations_seconds.filter((duration): duration is number => Number.isInteger(duration))
      : undefined;
    if (typeof row.id !== "string" || typeof row.display_name !== "string" || typeof row.last_seen_at !== "string"
        || (row.health_status !== "online" && row.health_status !== "degraded")) return null;
    return {
      id: row.id,
      display_name: row.display_name,
      last_seen_at: row.last_seen_at,
      health_status: row.health_status,
      capabilities: { operations, ...(durations ? { traffic_durations_seconds: durations } : {}) },
    };
  }).filter((runner): runner is TrafficRunnerSnapshot => runner !== null);
}

export function mergeTrafficRunnerSnapshots(current: DiagnosticRunner[], snapshots: TrafficRunnerSnapshot[]): DiagnosticRunner[] {
  return snapshots.map((snapshot) => {
    const existing = current.find((runner) => runner.id === snapshot.id);
    return {
      id: snapshot.id,
      display_name: snapshot.display_name,
      last_seen_at: snapshot.last_seen_at,
      health_status: snapshot.health_status,
      health_error_code: existing?.health_error_code ?? null,
      capabilities: {
        source_locations: existing?.capabilities.source_locations ?? [],
        targets: existing?.capabilities.targets ?? [],
        durations: existing?.capabilities.durations ?? [],
        ...existing?.capabilities,
        ...snapshot.capabilities,
      },
      preflight: existing?.preflight ?? {},
      updated_at: existing?.updated_at ?? snapshot.last_seen_at,
    };
  });
}

export function isTrafficRunnerAvailable(runner: DiagnosticRunner | null | undefined, nowMs = Date.now()) {
  if (!runner || runner.health_status !== "online"
      || !runner.capabilities.operations.includes("traffic_live")) return false;
  return isRunnerHeartbeatFresh(runner.last_seen_at, nowMs);
}

export function filterFlows(flows:TrafficFlow[], search:string, protocol:string, status:string) {
  const needle=search.trim().toLowerCase();
  return flows.filter((flow)=>(protocol==="all"||flow.protocol===protocol)&&(status==="all"||flow.status===status)&&(!needle||[flow.src_ip,flow.dst_ip,String(flow.src_port??""),String(flow.dst_port??""),flow.service??""].some((v)=>v.toLowerCase().includes(needle))));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
