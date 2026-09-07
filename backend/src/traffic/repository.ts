import type { TrafficFlow, TrafficRequest } from "./contract.js";
import { firstRow, SupabaseRestClient } from "../supabase-rest.js";

type Row = Record<string, unknown>;
type StorageStatus = Record<string, unknown> | null;

export interface TrafficRepository {
  claim(runnerId: string, now: Date, signal: AbortSignal): Promise<Row | null>;
  updateSession(runnerId: string, sessionId: string, stage: string, now: string, signal: AbortSignal): Promise<Row | null>;
  updateSnapshot(request: Extract<TrafficRequest, { action: "update_snapshot" }>, now: string, signal: AbortSignal): Promise<Row>;
  persistFlows(request: Extract<TrafficRequest, { action: "persist_flow_batch" }>, signal: AbortSignal): Promise<Row>;
  finish(request: Extract<TrafficRequest, { action: "complete_session" | "fail_session" }>, now: string, signal: AbortSignal): Promise<Row | null>;
}

export class SupabaseTrafficRepository implements TrafficRepository {
  readonly #client: SupabaseRestClient;

  constructor(supabaseUrl: string, serviceRoleKey: string) {
    this.#client = new SupabaseRestClient(supabaseUrl, serviceRoleKey);
  }

  async claim(runnerId: string, now: Date, signal: AbortSignal): Promise<Row | null> {
    await this.#client.rpc("expire_stale_traffic_sessions", { p_runner_id: runnerId }, signal);
    const queuedRows = await this.#client.table<Row[]>("traffic_live_sessions", {
      query: { select: "*", runner_id: `eq.${runnerId}`, status: "eq.queued", order: "created_at.asc", limit: 1 },
      signal,
    });
    const queued = firstRow<Row>(queuedRows);
    if (!queued) return null;
    const duration = typeof queued.duration_seconds === "number" ? queued.duration_seconds : 0;
    const expiresAt = new Date(now.getTime() + (duration + 60) * 1_000).toISOString();
    const rows = await this.#client.table<Row[]>("traffic_live_sessions", {
      method: "PATCH",
      query: { select: "*", id: `eq.${String(queued.id)}`, status: "eq.queued" },
      prefer: "return=representation",
      body: { status: "running", stage: "starting_wsl", started_at: now.toISOString(), expires_at: expiresAt, updated_at: now.toISOString() },
      signal,
    });
    return firstRow<Row>(rows);
  }

  async updateSession(runnerId: string, sessionId: string, stage: string, now: string, signal: AbortSignal) {
    const rows = await this.#client.table<Row[]>("traffic_live_sessions", {
      method: "PATCH",
      query: { select: "*", id: `eq.${sessionId}`, runner_id: `eq.${runnerId}`, status: "eq.running" },
      prefer: "return=representation",
      body: { stage, updated_at: now },
      signal,
    });
    return firstRow<Row>(rows);
  }

  async updateSnapshot(request: Extract<TrafficRequest, { action: "update_snapshot" }>, now: string, signal: AbortSignal) {
    const sessionRows = await this.#client.table<Row[]>("traffic_live_sessions", {
      method: "PATCH",
      query: { select: "status", id: `eq.${request.session_id}`, runner_id: `eq.${request.runner_id}`, status: "in.(running,stopping)" },
      prefer: "return=representation",
      body: { updated_at: now },
      signal,
    });
    const session = firstRow<Row>(sessionRows);
    if (!session || (session.status !== "running" && session.status !== "stopping")) throw new TrafficRepositoryError("SESSION_NOT_ACTIVE");
    const snapshot = request.snapshot;
    const flows = snapshot.flows as unknown[];
    const conversations = snapshot.conversations as unknown[];
    const topTalkers = snapshot.top_talkers as unknown[];
    const payloadBytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
    await this.#client.table("traffic_live_snapshots", {
      method: "POST",
      query: { on_conflict: "runner_id" },
      prefer: "resolution=merge-duplicates,return=minimal",
      body: {
        runner_id: request.runner_id,
        session_id: request.session_id,
        captured_at: snapshot.captured_at,
        summary: snapshot.summary,
        flows,
        conversations,
        top_talkers: topTalkers,
        payload_bytes: payloadBytes,
        updated_at: now,
      },
      signal,
    });
    const storage = await this.#storageStatus(signal);
    return { stop_requested: session.status === "stopping", storage_status: storage };
  }

  async persistFlows(request: Extract<TrafficRequest, { action: "persist_flow_batch" }>, signal: AbortSignal) {
    const sessions = await this.#client.table<Row[]>("traffic_live_sessions", {
      query: { select: "id", id: `eq.${request.session_id}`, runner_id: `eq.${request.runner_id}`, status: "in.(running,stopping)", limit: 1 },
      signal,
    });
    if (!firstRow(sessions)) throw new TrafficRepositoryError("SESSION_NOT_ACTIVE");
    const storage = await this.#storageStatus(signal);
    if (storage?.status === "critical") return { persisted: 0, storage_status: storage };
    const accepted = storage?.status === "warning" ? request.flows.slice(0, 25) : request.flows;
    const rows = accepted.map((flow) => persistentFlow(request.runner_id, request.session_id, flow));
    await this.#client.table("flows", {
      method: "POST",
      query: { on_conflict: "session_id,flow_key" },
      prefer: "resolution=merge-duplicates,return=minimal",
      body: rows,
      signal,
    });
    return { persisted: rows.length, storage_status: storage };
  }

  async finish(request: Extract<TrafficRequest, { action: "complete_session" | "fail_session" }>, now: string, signal: AbortSignal) {
    const failed = request.action === "fail_session";
    const rows = await this.#client.table<Row[]>("traffic_live_sessions", {
      method: "PATCH",
      query: { select: "*", id: `eq.${request.session_id}`, runner_id: `eq.${request.runner_id}`, status: "in.(running,stopping)" },
      prefer: "return=representation",
      body: {
        status: failed ? "failed" : "completed",
        stage: failed ? "failed" : "complete",
        error_code: failed ? request.error_code : null,
        error_message: failed ? request.error_message : null,
        completed_at: now,
        updated_at: now,
      },
      signal,
    });
    return firstRow<Row>(rows);
  }

  async #storageStatus(signal: AbortSignal): Promise<StorageStatus> {
    const data = await this.#client.rpc<unknown>("traffic_storage_status", {}, signal);
    return firstRow<StorageStatus>(data);
  }
}

export class TrafficRepositoryError extends Error {
  constructor(readonly code: "SESSION_NOT_ACTIVE") {
    super("Traffic persistence failed");
    this.name = "TrafficRepositoryError";
  }
}

function persistentFlow(runnerId: string, sessionId: string, flow: TrafficFlow) {
  return {
    runner_id: runnerId,
    session_id: sessionId,
    flow_key: flow.flow_key,
    first_seen: flow.first_seen,
    last_seen: flow.last_seen,
    src_ip: flow.src_ip,
    dst_ip: flow.dst_ip,
    src_port: flow.src_port,
    dst_port: flow.dst_port,
    protocol: flow.protocol,
    total_bytes: flow.total_bytes,
    packet_count: flow.packet_count,
    peak_rate_mbps: flow.peak_rate_mbps,
  };
}
