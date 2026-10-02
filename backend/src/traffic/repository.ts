import type { TrafficFlow, TrafficRequest } from "./contract.js";
type Row = Record<string, unknown>;
export interface TrafficRepository {
  claim(runnerId: string, now: Date, signal: AbortSignal): Promise<Row | null>;
  updateSession(runnerId: string, sessionId: string, stage: string, now: string, signal: AbortSignal): Promise<Row | null>;
  updateSnapshot(request: Extract<TrafficRequest, { action: "update_snapshot" }>, now: string, signal: AbortSignal): Promise<Row>;
  persistFlows(request: Extract<TrafficRequest, { action: "persist_flow_batch" }>, signal: AbortSignal): Promise<Row>;
  finish(request: Extract<TrafficRequest, { action: "complete_session" | "fail_session" }>, now: string, signal: AbortSignal): Promise<Row | null>;
}
export class TrafficRepositoryError extends Error { constructor(readonly code: "SESSION_NOT_ACTIVE") { super("Traffic persistence failed"); this.name = "TrafficRepositoryError"; } }
export function persistentFlow(runnerId: string, sessionId: string, flow: TrafficFlow) { return { runner_id: runnerId, session_id: sessionId, flow_key: flow.flow_key, first_seen: flow.first_seen, last_seen: flow.last_seen, src_ip: flow.src_ip, dst_ip: flow.dst_ip, src_port: flow.src_port, dst_port: flow.dst_port, protocol: flow.protocol, total_bytes: flow.total_bytes, packet_count: flow.packet_count, peak_rate_mbps: flow.peak_rate_mbps }; }
