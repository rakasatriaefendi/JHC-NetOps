import type { PostgresQuery } from "./postgres-query.js";

type Row = Record<string, unknown>;

export interface TrafficMetricsRepository {
  insert(metric: TrafficMetricInput, signal: AbortSignal): Promise<Row>;
  listRecent(limit: number, signal: AbortSignal): Promise<readonly Row[]>;
  listByStatus(status: string, signal: AbortSignal): Promise<readonly Row[]>;
}

export type TrafficMetricInput = Readonly<{
  recordedAt?: string;
  intervalSeconds: number;
  bytesIn: number;
  bytesOut: number;
  packetCount: number;
  avgLatencyMs?: number | null;
  packetLossPct?: number | null;
  gatewayReachable: boolean;
  dnsReachable: boolean;
  protocolBreakdown?: Record<string, unknown>;
  status: "normal" | "high_traffic" | "low_traffic" | "down" | "not_internet";
}>;

export class PostgresTrafficMetricsRepository implements TrafficMetricsRepository {
  constructor(private readonly database: PostgresQuery) {}

  async insert(metric: TrafficMetricInput, signal: AbortSignal): Promise<Row> {
    const VALID_STATUSES = new Set(["normal", "high_traffic", "low_traffic", "down", "not_internet"]);
    if (!VALID_STATUSES.has(metric.status)) throw new Error("Invalid status");
    if (!Number.isSafeInteger(metric.intervalSeconds) || metric.intervalSeconds <= 0) throw new Error("Invalid interval");
    if (!Number.isSafeInteger(metric.bytesIn) || metric.bytesIn < 0) throw new Error("Invalid bytes in");
    if (!Number.isSafeInteger(metric.bytesOut) || metric.bytesOut < 0) throw new Error("Invalid bytes out");
    if (!Number.isSafeInteger(metric.packetCount) || metric.packetCount < 0) throw new Error("Invalid packet count");
    const rows = await this.database.rows(`
      INSERT INTO public.traffic_metrics
        (recorded_at,interval_seconds,bytes_in,bytes_out,packet_count,avg_latency_ms,
         packet_loss_pct,gateway_reachable,dns_reachable,protocol_breakdown,status)
      VALUES ($1::timestamptz,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
      RETURNING *
    `, [
      metric.recordedAt ?? new Date().toISOString(),
      metric.intervalSeconds,
      metric.bytesIn,
      metric.bytesOut,
      metric.packetCount,
      metric.avgLatencyMs ?? null,
      metric.packetLossPct ?? null,
      metric.gatewayReachable,
      metric.dnsReachable,
      JSON.stringify(metric.protocolBreakdown ?? {}),
      metric.status,
    ], signal);
    if (!rows[0]) throw new Error("Traffic metric insert failed");
    return rows[0];
  }

  async listRecent(limit: number, signal: AbortSignal): Promise<readonly Row[]> {
    const boundedLimit = Math.max(1, Math.min(1000, Math.trunc(limit)));
    return this.database.rows(`
      SELECT * FROM public.traffic_metrics
      ORDER BY recorded_at DESC LIMIT $1
    `, [boundedLimit], signal);
  }

  async listByStatus(status: string, signal: AbortSignal): Promise<readonly Row[]> {
    const VALID_STATUSES = new Set(["normal", "high_traffic", "low_traffic", "down", "not_internet"]);
    if (!VALID_STATUSES.has(status)) return [];
    return this.database.rows(`
      SELECT * FROM public.traffic_metrics
      WHERE status=$1 ORDER BY recorded_at DESC LIMIT 500
    `, [status], signal);
  }
}