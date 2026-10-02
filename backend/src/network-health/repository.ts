import type { HealthState, HealthTransition } from "./contract.js";
type Row = Record<string, unknown>;
export interface NetworkHealthRepository {
  listTargets(runnerId: string, signal: AbortSignal): Promise<{ targets: Row[] }>;
  publish(runnerId: string, states: HealthState[], transitions: HealthTransition[], now: string, signal: AbortSignal): Promise<{ states: number; events: number }>;
  claimManualPing(runnerId: string, signal: AbortSignal): Promise<Row | null>;
  completeManualPing(pingId: string, runnerId: string, now: string, result: Row, signal: AbortSignal): Promise<Row | null>;
  failManualPing(pingId: string, runnerId: string, now: string, errorCode: string, signal: AbortSignal): Promise<Row | null>;
}
export class NetworkHealthRepositoryError extends Error { constructor(readonly code: "TARGET_NOT_AUTHORIZED") { super("Network health persistence failed"); this.name = "NetworkHealthRepositoryError"; } }
export function coalescedSamples(states: HealthState[]) {
  const buckets = new Map<string, { checkedAt: number; row: Record<string, unknown> }>();
  for (const state of states) {
    const checkedAt = new Date(state.last_checked_at);
    const sampledAt = new Date(Date.UTC(checkedAt.getUTCFullYear(), checkedAt.getUTCMonth(), checkedAt.getUTCDate(), checkedAt.getUTCHours(), checkedAt.getUTCMinutes(), 0, 0)).toISOString();
    const key = `${state.target_id}|${sampledAt}`;
    const existing = buckets.get(key);
    if (!existing || existing.checkedAt < checkedAt.getTime()) buckets.set(key, { checkedAt: checkedAt.getTime(), row: { target_id: state.target_id, sampled_at: sampledAt, status: state.status, latency_ms: state.latency_ms, packet_loss_percent: state.packet_loss_percent, sample_count: state.sample_count } });
  }
  return [...buckets.values()].map(({ row }) => row);
}
export function healthEvent(item: HealthTransition, node: Row | null, critical: boolean) {
  const name = typeof node?.name === "string" ? node.name : "Known network target";
  const ipAddress = typeof node?.ip_address === "string" ? node.ip_address : null;
  const status = item.new_status;
  const title = status === "offline" ? `${name} tidak merespons ICMP` : status === "degraded" ? `${name} health degraded` : `${name} recovered`;
  const description = status === "offline" ? "Target melewati ambang kegagalan ICMP. Ini tidak membuktikan perangkat mati; ICMP dapat diblokir atau jalur dapat bermasalah." : status === "degraded" ? "Target masih merespons, tetapi latency atau packet-loss short window melewati threshold yang dikonfigurasi." : "Target kembali memenuhi recovery threshold dan merespons secara konsisten.";
  return { id: item.event_id, created_at: item.occurred_at, severity: status === "offline" ? (critical ? "critical" : "high") : status === "degraded" ? "medium" : "low", title, description, source: "network_health", source_ref: item.target_id, resolved_at: status === "online" ? item.occurred_at : null, raw_context: { source: "network_health", target_id: item.target_id, ip_address: ipAddress, previous_status: item.previous_status, new_status: status, critical, latency_ms: item.latency_ms, packet_loss_percent: item.packet_loss_percent, consecutive_failures: item.consecutive_failures, transition_id: item.event_id } };
}
