import type { TrafficRequest } from "../traffic/contract.js";
import { persistentFlow, TrafficRepositoryError, type TrafficRepository } from "../traffic/repository.js";
import { PostgresRunnerHeartbeatRepository } from "./runner-heartbeat.js";
import type { PostgresQuery } from "./postgres-query.js";

type Row = Record<string, unknown>;

export class PostgresTrafficRepository implements TrafficRepository {
  constructor(private readonly database: PostgresQuery) {}

  async claim(runnerId: string, now: Date, signal: AbortSignal): Promise<Row | null> {
    await new PostgresRunnerHeartbeatRepository(this.database).expireStaleTrafficSessions(runnerId, signal);
    const rows = await this.database.rows(`
      UPDATE public.traffic_live_sessions s SET
        status='running', stage='starting_wsl', started_at=$2::timestamptz,
        expires_at=$2::timestamptz + (s.duration_seconds + 60) * interval '1 second',
        updated_at=$2::timestamptz
      WHERE s.id = (
        SELECT id FROM public.traffic_live_sessions
        WHERE runner_id=$1 AND status='queued'
        ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
      ) AND s.status='queued'
      RETURNING s.*
    `, [runnerId, now.toISOString()], signal);
    return rows[0] ?? null;
  }

  async updateSession(runnerId: string, sessionId: string, stage: string, now: string, signal: AbortSignal): Promise<Row | null> {
    const rows = await this.database.rows(`
      UPDATE public.traffic_live_sessions SET stage=$3, updated_at=$4::timestamptz
      WHERE id=$2::uuid AND runner_id=$1 AND status='running' RETURNING *
    `, [runnerId, sessionId, stage, now], signal);
    return rows[0] ?? null;
  }

  async updateSnapshot(request: Extract<TrafficRequest, { action: "update_snapshot" }>, now: string, signal: AbortSignal): Promise<Row> {
    const session = (await this.database.rows(`
      UPDATE public.traffic_live_sessions SET updated_at=$3::timestamptz
      WHERE id=$2::uuid AND runner_id=$1 AND status IN ('running','stopping')
      RETURNING status
    `, [request.runner_id, request.session_id, now], signal))[0];
    if (!session || !["running", "stopping"].includes(String(session.status))) throw new TrafficRepositoryError("SESSION_NOT_ACTIVE");
    const snapshot = request.snapshot;
    const payloadBytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
    await this.database.rows(`
      INSERT INTO public.traffic_live_snapshots
        (runner_id,session_id,captured_at,summary,flows,conversations,top_talkers,payload_bytes,updated_at)
      VALUES ($1,$2::uuid,$3::timestamptz,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9::timestamptz)
      ON CONFLICT (runner_id) DO UPDATE SET
        session_id=EXCLUDED.session_id,captured_at=EXCLUDED.captured_at,
        summary=EXCLUDED.summary,flows=EXCLUDED.flows,
        conversations=EXCLUDED.conversations,top_talkers=EXCLUDED.top_talkers,
        payload_bytes=EXCLUDED.payload_bytes,updated_at=EXCLUDED.updated_at
    `, [request.runner_id, request.session_id, snapshot.captured_at, JSON.stringify(snapshot.summary),
      JSON.stringify(snapshot.flows), JSON.stringify(snapshot.conversations), JSON.stringify(snapshot.top_talkers),
      payloadBytes, now], signal);
    return { stop_requested: session.status === "stopping", storage_status: await this.#storageStatus(signal) };
  }

  async persistFlows(request: Extract<TrafficRequest, { action: "persist_flow_batch" }>, signal: AbortSignal): Promise<Row> {
    const sessions = await this.database.rows(`
      SELECT id FROM public.traffic_live_sessions
      WHERE id=$2::uuid AND runner_id=$1 AND status IN ('running','stopping') LIMIT 1
    `, [request.runner_id, request.session_id], signal);
    if (!sessions.length) throw new TrafficRepositoryError("SESSION_NOT_ACTIVE");
    const storage = await this.#storageStatus(signal);
    if (storage?.status === "critical") return { persisted: 0, storage_status: storage };
    const accepted = storage?.status === "warning" ? request.flows.slice(0, 25) : request.flows;
    const flows = accepted.map((flow) => persistentFlow(request.runner_id, request.session_id, flow));
    if (flows.length) await this.database.rows(`
      INSERT INTO public.flows
        (runner_id,session_id,flow_key,first_seen,last_seen,src_ip,dst_ip,src_port,dst_port,
         protocol,total_bytes,packet_count,peak_rate_mbps)
      SELECT runner_id,session_id,flow_key,first_seen,last_seen,src_ip,dst_ip,src_port,dst_port,
        protocol,total_bytes,packet_count,peak_rate_mbps
      FROM jsonb_to_recordset($1::jsonb) AS x(
        runner_id text,session_id uuid,flow_key text,first_seen timestamptz,last_seen timestamptz,
        src_ip inet,dst_ip inet,src_port integer,dst_port integer,protocol text,
        total_bytes bigint,packet_count bigint,peak_rate_mbps double precision)
      ON CONFLICT (session_id,flow_key) DO UPDATE SET
        first_seen=EXCLUDED.first_seen,last_seen=EXCLUDED.last_seen,
        src_ip=EXCLUDED.src_ip,dst_ip=EXCLUDED.dst_ip,src_port=EXCLUDED.src_port,dst_port=EXCLUDED.dst_port,
        protocol=EXCLUDED.protocol,total_bytes=EXCLUDED.total_bytes,packet_count=EXCLUDED.packet_count,
        peak_rate_mbps=EXCLUDED.peak_rate_mbps
    `, [JSON.stringify(flows)], signal);
    return { persisted: flows.length, storage_status: storage };
  }

  async finish(request: Extract<TrafficRequest, { action: "complete_session" | "fail_session" }>, now: string, signal: AbortSignal): Promise<Row | null> {
    const failed = request.action === "fail_session";
    const rows = await this.database.rows(`
      UPDATE public.traffic_live_sessions SET
        status=$3,stage=$4,error_code=$5,error_message=$6,
        completed_at=$7::timestamptz,updated_at=$7::timestamptz
      WHERE id=$2::uuid AND runner_id=$1 AND status IN ('running','stopping') RETURNING *
    `, [request.runner_id, request.session_id, failed ? "failed" : "completed",
      failed ? "failed" : "complete", failed ? request.error_code : null,
      failed ? request.error_message : null, now], signal);
    return rows[0] ?? null;
  }

  async #storageStatus(signal: AbortSignal): Promise<Row | null> {
    const rows = await this.database.rows(`
      SELECT round(pg_total_relation_size('public.flows'::regclass)::numeric / 1024 / 1024, 2) AS storage_mb,
        CASE WHEN pg_total_relation_size('public.flows'::regclass) > 400 * 1024 * 1024 THEN 'critical'
          WHEN pg_total_relation_size('public.flows'::regclass) > 300 * 1024 * 1024 THEN 'warning'
          ELSE 'healthy' END AS status
    `, [], signal);
    const row = rows[0];
    return row ? { ...row, storage_mb: Number(row.storage_mb) } : null;
  }
}
