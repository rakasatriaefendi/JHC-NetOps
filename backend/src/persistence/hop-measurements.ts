import type { PostgresQuery } from "./postgres-query.js";

type Row = Record<string, unknown>;

export interface HopMeasurementsRepository {
  insertBatch(measurements: HopMeasurementInput[], signal: AbortSignal): Promise<number>;
  listBySession(sessionId: string, signal: AbortSignal): Promise<readonly Row[]>;
  listByJob(jobId: string, signal: AbortSignal): Promise<readonly Row[]>;
}

export type HopMeasurementInput = Readonly<{
  sessionId: string;
  hopNumber: number;
  hopIp?: string | null;
  avgLatencyMs?: number | null;
  lossPercent: number;
  measuredAt?: string;
  sourceLabel?: string | null;
  targetLabel?: string | null;
  targetHost?: string | null;
  connectionType?: "wifi" | "ethernet" | null;
  jobId?: string | null;
  environment?: "lan" | "localhost_demo" | null;
}>;

export class PostgresHopMeasurementsRepository implements HopMeasurementsRepository {
  constructor(private readonly database: PostgresQuery) {}

  async insertBatch(measurements: HopMeasurementInput[], signal: AbortSignal): Promise<number> {
    if (!measurements.length) return 0;
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const firstMeasurement = measurements[0];
    if (!firstMeasurement || !UUID.test(firstMeasurement.sessionId)) throw new Error("Invalid session ID");
    const rows = measurements.map((m) => ({
      session_id: m.sessionId,
      hop_number: m.hopNumber,
      hop_ip: m.hopIp ?? null,
      avg_latency_ms: m.avgLatencyMs ?? null,
      loss_percent: m.lossPercent,
      measured_at: m.measuredAt ?? new Date().toISOString(),
      source_label: m.sourceLabel ?? null,
      target_label: m.targetLabel ?? null,
      target_host: m.targetHost ?? null,
      connection_type: m.connectionType ?? null,
      job_id: m.jobId ?? null,
      environment: m.environment ?? null,
    }));
    await this.database.rows(`
      INSERT INTO public.hop_measurements
        (session_id,hop_number,hop_ip,avg_latency_ms,loss_percent,measured_at,
         source_label,target_label,target_host,connection_type,job_id,environment)
      SELECT session_id,hop_number,hop_ip,avg_latency_ms,loss_percent,measured_at::timestamptz,
        source_label,target_label,target_host,connection_type,job_id::uuid,environment
      FROM jsonb_to_recordset($1::jsonb) AS x(
        session_id uuid,hop_number integer,hop_ip inet,avg_latency_ms double precision,
        loss_percent double precision,measured_at timestamptz,source_label text,
        target_label text,target_host text,connection_type text,job_id uuid,environment text)
    `, [JSON.stringify(rows)], signal);
    return measurements.length;
  }

  async listBySession(sessionId: string, signal: AbortSignal): Promise<readonly Row[]> {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!UUID.test(sessionId)) return [];
    return this.database.rows(`
      SELECT * FROM public.hop_measurements
      WHERE session_id=$1::uuid ORDER BY hop_number ASC
    `, [sessionId], signal);
  }

  async listByJob(jobId: string, signal: AbortSignal): Promise<readonly Row[]> {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!UUID.test(jobId)) return [];
    return this.database.rows(`
      SELECT * FROM public.hop_measurements
      WHERE job_id=$1::uuid ORDER BY measured_at DESC, hop_number ASC
    `, [jobId], signal);
  }
}