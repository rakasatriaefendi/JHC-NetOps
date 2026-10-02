import type { PostgresTransactionalQuery } from "./postgres-query.js";

export type OutboxErrorCategory =
  | "transient_network"
  | "supabase_unavailable"
  | "payload_validation"
  | "projection_not_allowed";

export type OutboxEvent = Readonly<{
  id: number;
  event_id: string;
  aggregate_type: string;
  aggregate_key: Record<string, unknown>;
  operation: "INSERT" | "UPDATE" | "DELETE";
  payload: Record<string, unknown>;
  status: "pending" | "delivered" | "failed";
  attempt_count: number;
  next_attempt_at: string | null;
  created_at: string;
  delivered_at: string | null;
  last_error_category: OutboxErrorCategory | null;
}>;

export type OutboxFetchFailureCode =
  | "OUTBOX_PERMISSION_DENIED"
  | "OUTBOX_SCHEMA_MISMATCH"
  | "OUTBOX_QUERY_TIMEOUT"
  | "OUTBOX_QUERY_FAILED";

export class OutboxFetchError extends Error {
  constructor(readonly code: OutboxFetchFailureCode) {
    super(code);
    this.name = "OutboxFetchError";
  }
}

export const COALESCIBLE_AGGREGATE_TYPES = Object.freeze([
  "diagnostic_runners",
  "network_health_latest",
  "managed_device_latest",
  "managed_interface_latest",
  "managed_observed_hosts_latest",
] as const);

export class PostgresOutboxRepository {
  constructor(private readonly database: PostgresTransactionalQuery) {}

  /**
   * Fetches the strict FIFO head for normal aggregates and aggregates containing
   * any failed row. For the explicit latest-state allowlist only, an aggregate
   * with no failed row may project its newest pending state. The monotonic id is
   * the projection version.
   */
  async fetchPending(limit: number, signal: AbortSignal): Promise<OutboxEvent[]> {
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    try {
      const rows = await this.database.rows(`
      WITH aggregate_heads AS MATERIALIZED (
        SELECT DISTINCT ON (aggregate_type,aggregate_key)
          id,event_id,aggregate_type,aggregate_key,operation,payload,status,
          attempt_count,next_attempt_at,created_at,delivered_at,last_error_category
        FROM public.realtime_outbox
        WHERE status <> 'delivered'
        ORDER BY aggregate_type,aggregate_key,id ASC
      ), failed_aggregates AS MATERIALIZED (
        SELECT DISTINCT aggregate_type,aggregate_key
        FROM public.realtime_outbox
        WHERE status='failed'
      ), newest_coalescible_pending AS MATERIALIZED (
        SELECT DISTINCT ON (aggregate_type,aggregate_key)
          id,event_id,aggregate_type,aggregate_key,operation,payload,status,
          attempt_count,next_attempt_at,created_at,delivered_at,last_error_category
        FROM public.realtime_outbox
        WHERE status='pending'
          AND aggregate_type=ANY($2::text[])
          AND (next_attempt_at IS NULL OR next_attempt_at <= now())
        ORDER BY aggregate_type,aggregate_key,id DESC
      ), candidates AS MATERIALIZED (
        SELECT h.*
        FROM aggregate_heads h
        WHERE NOT (h.aggregate_type=ANY($2::text[]))
          OR EXISTS (
            SELECT 1 FROM failed_aggregates f
            WHERE f.aggregate_type=h.aggregate_type AND f.aggregate_key=h.aggregate_key
          )
        UNION ALL
        SELECT n.*
        FROM newest_coalescible_pending n
        WHERE NOT EXISTS (
          SELECT 1 FROM failed_aggregates f
          WHERE f.aggregate_type=n.aggregate_type AND f.aggregate_key=n.aggregate_key
        )
      )
      SELECT o.id,o.event_id,o.aggregate_type,o.aggregate_key,o.operation,o.payload,
        o.status,o.attempt_count,o.next_attempt_at,o.created_at,o.delivered_at,o.last_error_category
      FROM candidates o
      LEFT JOIN public.realtime_projection_watermarks w
        ON w.aggregate_type=o.aggregate_type AND w.aggregate_key=o.aggregate_key
      WHERE o.status IN ('pending','failed')
        AND (o.status='pending'
          OR o.last_error_category IN ('transient_network','supabase_unavailable')
          OR (o.operation='INSERT' AND o.last_error_category='payload_validation'))
        AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= now())
        AND o.id > COALESCE(w.last_delivered_outbox_id,0)
      ORDER BY o.id ASC
      LIMIT $1
      `, [boundedLimit, COALESCIBLE_AGGREGATE_TYPES], signal);
      return rows.map(mapRow);
    } catch (error) {
      if (error instanceof OutboxFetchError) throw error;
      throw new OutboxFetchError(classifyFetchFailure(error));
    }
  }

  /** Marks delivery and advances only this aggregate's watermark atomically. */
  async markDelivered(event: Pick<OutboxEvent, "id" | "aggregate_type" | "aggregate_key" | "status">, signal: AbortSignal): Promise<void> {
    await this.database.transaction(signal, async (query) => {
      if (event.status === "pending" && isCoalescibleAggregate(event.aggregate_type)) {
        const delivered = await query.rows(`
          UPDATE public.realtime_outbox o
          SET status='delivered',delivered_at=now(),next_attempt_at=NULL,last_error_category=NULL
          WHERE o.aggregate_type=$1 AND o.aggregate_key=$2::jsonb AND o.id <= $3
            AND o.status='pending'
            AND NOT EXISTS (
              SELECT 1 FROM public.realtime_outbox failed
              WHERE failed.aggregate_type=o.aggregate_type
                AND failed.aggregate_key=o.aggregate_key
                AND failed.status='failed'
            )
          RETURNING o.id
        `, [event.aggregate_type, JSON.stringify(event.aggregate_key), event.id], signal);
        if (!delivered.some((row) => Number(row.id) === event.id)) {
          throw new Error("OUTBOX_COALESCED_DELIVERY_BLOCKED");
        }
      } else {
        await query.rows(`
          UPDATE public.realtime_outbox
          SET status='delivered',delivered_at=now(),next_attempt_at=NULL,last_error_category=NULL
          WHERE id=$1 AND status IN ('pending','failed')
        `, [event.id], signal);
      }
      await query.rows(`
        INSERT INTO public.realtime_projection_watermarks
          (aggregate_type,aggregate_key,last_delivered_outbox_id,updated_at)
        VALUES ($1,$2::jsonb,$3,now())
        ON CONFLICT (aggregate_type,aggregate_key) DO UPDATE SET
          last_delivered_outbox_id=GREATEST(
            public.realtime_projection_watermarks.last_delivered_outbox_id,
            EXCLUDED.last_delivered_outbox_id),
          updated_at=now()
      `, [event.aggregate_type, JSON.stringify(event.aggregate_key), event.id], signal);
    });
  }

  async markFailed(id: number, errorCategory: OutboxErrorCategory, signal: AbortSignal): Promise<void> {
    await this.database.rows(`
      UPDATE public.realtime_outbox
      SET status='failed',attempt_count=LEAST(attempt_count+1,100),
        next_attempt_at=now() + LEAST(3600,power(2,LEAST(attempt_count+1,11))) * interval '1 second',
        last_error_category=$2
      WHERE id=$1
    `, [id, errorCategory], signal);
  }

  async getHealth(signal: AbortSignal): Promise<{
    total_count: number;
    delivered_count: number;
    pending_count: number;
    failed_count: number;
    oldest_pending_age_ms: number | null;
  }> {
    const rows = await this.database.rows(`
      SELECT COUNT(*) AS total_count,
        COUNT(*) FILTER (WHERE status='delivered') AS delivered_count,
        COUNT(*) FILTER (WHERE status='pending') AS pending_count,
        COUNT(*) FILTER (WHERE status='failed') AS failed_count,
        EXTRACT(EPOCH FROM (
          now() - MIN(created_at) FILTER (WHERE status IN ('pending','failed'))
        ))*1000 AS oldest_pending_age_ms
      FROM public.realtime_outbox
    `, [], signal);
    const row = rows[0];
    return {
      total_count: Number(row?.total_count ?? 0),
      delivered_count: Number(row?.delivered_count ?? 0),
      pending_count: Number(row?.pending_count ?? 0),
      failed_count: Number(row?.failed_count ?? 0),
      oldest_pending_age_ms: row?.oldest_pending_age_ms === null || row?.oldest_pending_age_ms === undefined
        ? null : Number(row.oldest_pending_age_ms),
    };
  }
}

function isCoalescibleAggregate(value: string): value is typeof COALESCIBLE_AGGREGATE_TYPES[number] {
  return (COALESCIBLE_AGGREGATE_TYPES as readonly string[]).includes(value);
}

function classifyFetchFailure(error: unknown): OutboxFetchFailureCode {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : null;
  if (code === "42501") return "OUTBOX_PERMISSION_DENIED";
  if (code === "42P01" || code === "42703" || code === "42883") return "OUTBOX_SCHEMA_MISMATCH";
  if (code === "57014") return "OUTBOX_QUERY_TIMEOUT";
  return "OUTBOX_QUERY_FAILED";
}

function mapRow(row: Record<string, unknown>): OutboxEvent {
  return {
    id: Number(row.id), event_id: String(row.event_id), aggregate_type: String(row.aggregate_type),
    aggregate_key: row.aggregate_key as Record<string, unknown>,
    operation: row.operation as OutboxEvent["operation"],
    payload: row.payload as Record<string, unknown>, status: row.status as OutboxEvent["status"],
    attempt_count: Number(row.attempt_count), next_attempt_at: row.next_attempt_at ? String(row.next_attempt_at) : null,
    created_at: String(row.created_at), delivered_at: row.delivered_at ? String(row.delivered_at) : null,
    last_error_category: row.last_error_category as OutboxErrorCategory | null,
  };
}
