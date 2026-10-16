import type { PostgresQuery } from "./postgres-query.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const HEALTH_HISTORY_MAX_TARGETS = 20;
export const HEALTH_HISTORY_MAX_BYTES = 4 * 1024 * 1024;
export const HEALTH_HISTORY_RANGES = {
  "1h": { minutes: 60, bucketMinutes: 1, maxPoints: 61 },
  "6h": { minutes: 360, bucketMinutes: 2, maxPoints: 181 },
  "24h": { minutes: 1440, bucketMinutes: 6, maxPoints: 241 },
  "7d": { minutes: 10080, bucketMinutes: 21, maxPoints: 481 },
} as const;
export type HealthHistoryRange = keyof typeof HEALTH_HISTORY_RANGES;
export type HealthHistoryQuery = { targetIds: string[]; range: HealthHistoryRange };
export type HealthHistorySample = {
  target_id: string; sampled_at: string; status: "online" | "degraded" | "offline";
  latency_ms: number | null; packet_loss_percent: number; sample_count: number;
  observation_count: number; latency_observation_count: number;
  latency_min_ms: number | null; latency_max_ms: number | null;
  packet_loss_min_percent: number; packet_loss_max_percent: number;
  first_sample_at: string; last_sample_at: string;
};
export type HealthHistory = {
  target_ids: string[]; range: HealthHistoryRange; from: string; to: string;
  bucket_seconds: number; samples: HealthHistorySample[];
};
export class HealthHistoryError extends Error {
  constructor(readonly code: "INVALID_HEALTH_HISTORY_REQUEST" | "HEALTH_HISTORY_TARGET_UNAVAILABLE" |
    "HEALTH_HISTORY_RESPONSE_TOO_LARGE" | "HEALTH_HISTORY_QUERY_FAILED") {
    super("Health history read failed");
  }
}

export function validateHealthHistoryQuery(value: unknown): HealthHistoryQuery | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const query = value as Record<string, unknown>;
  if (Object.keys(query).length !== 2 || typeof query.target_ids !== "string" ||
    query.target_ids.length > HEALTH_HISTORY_MAX_TARGETS * 37 || typeof query.range !== "string" ||
    !Object.hasOwn(HEALTH_HISTORY_RANGES, query.range)) return null;
  const targetIds = query.target_ids.split(",").map((id) => id.toLowerCase());
  if (!targetIds.length || targetIds.length > HEALTH_HISTORY_MAX_TARGETS ||
    targetIds.some((id) => !UUID.test(id)) || new Set(targetIds).size !== targetIds.length) return null;
  return { targetIds: targetIds.sort(), range: query.range as HealthHistoryRange };
}

export interface HealthHistoryRepository {
  read(query: HealthHistoryQuery, now: Date, signal: AbortSignal): Promise<HealthHistory>;
}

/** Read-only. No generated buckets, fills, LIMIT truncation, or identity inference. */
export class PostgresHealthHistoryRepository implements HealthHistoryRepository {
  constructor(private readonly database: PostgresQuery) {}

  async read(query: HealthHistoryQuery, now: Date, signal: AbortSignal): Promise<HealthHistory> {
    const validated = validateHealthHistoryQuery({ target_ids: query.targetIds.join(","), range: query.range });
    if (!validated || !Number.isFinite(now.getTime())) throw new HealthHistoryError("INVALID_HEALTH_HISTORY_REQUEST");
    const spec = HEALTH_HISTORY_RANGES[validated.range];
    const to = now.toISOString();
    const from = new Date(now.getTime() - spec.minutes * 60_000).toISOString();
    const targets = await this.database.rows(`
      SELECT id::text FROM public.network_targets
      WHERE id=ANY($1::uuid[]) AND enabled=true ORDER BY id
    `, [validated.targetIds], signal);
    if (targets.length !== validated.targetIds.length ||
      validated.targetIds.some((id) => !targets.some((row) => String(row.id).toLowerCase() === id))) {
      throw new HealthHistoryError("HEALTH_HISTORY_TARGET_UNAVAILABLE");
    }
    const maxRows = validated.targetIds.length * spec.maxPoints;
    const rows = await this.database.rows(`
      SELECT target_id::text,
        date_bin($4::interval,sampled_at,date_trunc('minute',$2::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS sampled_at,
        CASE max(CASE status WHEN 'offline' THEN 2 WHEN 'degraded' THEN 1 ELSE 0 END)
          WHEN 2 THEN 'offline' WHEN 1 THEN 'degraded' ELSE 'online' END AS status,
        avg(latency_ms)::double precision AS latency_ms,
        avg(packet_loss_percent)::double precision AS packet_loss_percent,
        (array_agg(sample_count ORDER BY sampled_at DESC,id DESC))[1] AS sample_count,
        count(*)::integer AS observation_count,
        count(latency_ms)::integer AS latency_observation_count,
        min(latency_ms) AS latency_min_ms,max(latency_ms) AS latency_max_ms,
        min(packet_loss_percent)::double precision AS packet_loss_min_percent,
        max(packet_loss_percent)::double precision AS packet_loss_max_percent,
        min(sampled_at) AS first_sample_at,max(sampled_at) AS last_sample_at
      FROM public.network_health_samples
      WHERE target_id=ANY($1::uuid[]) AND sampled_at >= $2::timestamptz AND sampled_at < $3::timestamptz
      GROUP BY target_id,date_bin($4::interval,sampled_at,date_trunc('minute',$2::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
      ORDER BY sampled_at ASC,target_id ASC
      LIMIT $5
    `, [validated.targetIds, from, to, `${spec.bucketMinutes} minutes`, maxRows + 1], signal);
    // An extra row detects unexpected overflow; never silently clip the time range.
    if (rows.length > maxRows) throw new HealthHistoryError("HEALTH_HISTORY_RESPONSE_TOO_LARGE");
    const samples = rows.map(normalizeSample);
    if (samples.some((sample) => !validated.targetIds.includes(sample.target_id))) {
      throw new HealthHistoryError("HEALTH_HISTORY_QUERY_FAILED");
    }
    const data: HealthHistory = { target_ids: validated.targetIds, range: validated.range,
      from, to, bucket_seconds: spec.bucketMinutes * 60, samples };
    if (Buffer.byteLength(JSON.stringify({ data }), "utf8") > HEALTH_HISTORY_MAX_BYTES) {
      throw new HealthHistoryError("HEALTH_HISTORY_RESPONSE_TOO_LARGE");
    }
    return data;
  }
}

function normalizeSample(row: Record<string, unknown>): HealthHistorySample {
  const timestamp = (value: unknown): string => {
    if (!(value instanceof Date) && typeof value !== "string") throw new HealthHistoryError("HEALTH_HISTORY_QUERY_FAILED");
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new HealthHistoryError("HEALTH_HISTORY_QUERY_FAILED");
    return date.toISOString();
  };
  const number = (value: unknown, max: number, integer = false): number => {
    if (typeof value !== "number" && typeof value !== "string") throw new HealthHistoryError("HEALTH_HISTORY_QUERY_FAILED");
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > max || (integer && !Number.isInteger(parsed))) {
      throw new HealthHistoryError("HEALTH_HISTORY_QUERY_FAILED");
    }
    return parsed;
  };
  const nullableLatency = (value: unknown) => value === null ? null : number(value, 60_000);
  if (typeof row.target_id !== "string" || !UUID.test(row.target_id) || typeof row.status !== "string" ||
    !["online", "degraded", "offline"].includes(row.status)) throw new HealthHistoryError("HEALTH_HISTORY_QUERY_FAILED");
  const sample: HealthHistorySample = {
    target_id: row.target_id.toLowerCase(), sampled_at: timestamp(row.sampled_at),
    status: row.status as HealthHistorySample["status"], latency_ms: nullableLatency(row.latency_ms),
    packet_loss_percent: number(row.packet_loss_percent, 100), sample_count: number(row.sample_count, 5, true),
    observation_count: number(row.observation_count, 21, true),
    latency_observation_count: number(row.latency_observation_count, 21, true),
    latency_min_ms: nullableLatency(row.latency_min_ms), latency_max_ms: nullableLatency(row.latency_max_ms),
    packet_loss_min_percent: number(row.packet_loss_min_percent, 100),
    packet_loss_max_percent: number(row.packet_loss_max_percent, 100),
    first_sample_at: timestamp(row.first_sample_at), last_sample_at: timestamp(row.last_sample_at),
  };
  if (sample.observation_count < 1 || sample.sample_count < 1 || sample.latency_observation_count > sample.observation_count) {
    throw new HealthHistoryError("HEALTH_HISTORY_QUERY_FAILED");
  }
  return sample;
}
