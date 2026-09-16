import type { PostgresQuery } from "./postgres-query.js";

type Row = Record<string, unknown>;

export interface BandwidthMeasurementsRepository {
  insert(measurement: BandwidthMeasurementInput, signal: AbortSignal): Promise<Row>;
  listByJob(jobId: string, signal: AbortSignal): Promise<readonly Row[]>;
  listRecent(limit: number, signal: AbortSignal): Promise<readonly Row[]>;
}

export type BandwidthMeasurementInput = Readonly<{
  sourceLabel: string;
  targetLabel: string;
  bitrateMbps: number;
  jitterMs?: number | null;
  measuredAt?: string;
  targetHost?: string | null;
  connectionType?: "wifi" | "ethernet" | null;
  jobId?: string | null;
  direction?: "upload" | "download" | null;
  environment?: "lan" | "localhost_demo" | null;
  peakMbps?: number | null;
  minimumMbps?: number | null;
  transferredMb?: number | null;
  retransmits?: number | null;
  durationSeconds?: number | null;
}>;

export class PostgresBandwidthMeasurementsRepository implements BandwidthMeasurementsRepository {
  constructor(private readonly database: PostgresQuery) {}

  async insert(measurement: BandwidthMeasurementInput, signal: AbortSignal): Promise<Row> {
    if (!Number.isFinite(measurement.bitrateMbps) || measurement.bitrateMbps < 0) {
      throw new Error("Invalid bitrate");
    }
    const rows = await this.database.rows(`
      INSERT INTO public.bandwidth_measurements
        (source_label,target_label,bitrate_mbps,jitter_ms,measured_at,target_host,
         connection_type,job_id,direction,environment,peak_mbps,minimum_mbps,
         transferred_mb,retransmits,duration_seconds)
      VALUES ($1,$2,$3,$4,$5::timestamptz,$6,$7,$8::uuid,$9,$10,$11,$12,$13,$14,$15)
      RETURNING *
    `, [
      measurement.sourceLabel.slice(0, 200),
      measurement.targetLabel.slice(0, 200),
      measurement.bitrateMbps,
      measurement.jitterMs ?? null,
      measurement.measuredAt ?? new Date().toISOString(),
      measurement.targetHost ?? null,
      measurement.connectionType ?? null,
      measurement.jobId ?? null,
      measurement.direction ?? null,
      measurement.environment ?? null,
      measurement.peakMbps ?? null,
      measurement.minimumMbps ?? null,
      measurement.transferredMb ?? null,
      measurement.retransmits ?? null,
      measurement.durationSeconds ?? null,
    ], signal);
    if (!rows[0]) throw new Error("Bandwidth measurement insert failed");
    return rows[0];
  }

  async listByJob(jobId: string, signal: AbortSignal): Promise<readonly Row[]> {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!UUID.test(jobId)) return [];
    return this.database.rows(`
      SELECT * FROM public.bandwidth_measurements
      WHERE job_id=$1::uuid ORDER BY measured_at DESC
    `, [jobId], signal);
  }

  async listRecent(limit: number, signal: AbortSignal): Promise<readonly Row[]> {
    const boundedLimit = Math.max(1, Math.min(1000, Math.trunc(limit)));
    return this.database.rows(`
      SELECT * FROM public.bandwidth_measurements
      ORDER BY measured_at DESC LIMIT $1
    `, [boundedLimit], signal);
  }
}