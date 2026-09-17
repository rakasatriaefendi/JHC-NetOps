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

export class PostgresOutboxRepository {
  constructor(private readonly database: PostgresTransactionalQuery) {}

  /**
   * Fetches only the oldest eligible event for each aggregate. Domain triggers
   * create these rows atomically; later events remain blocked behind an older
   * pending/failed event. The monotonic id is the projection version.
   */
  async fetchPending(limit: number, signal: AbortSignal): Promise<OutboxEvent[]> {
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const rows = await this.database.rows(`
      SELECT o.id,o.event_id,o.aggregate_type,o.aggregate_key,o.operation,o.payload,
        o.status,o.attempt_count,o.next_attempt_at,o.created_at,o.delivered_at,o.last_error_category
      FROM public.realtime_outbox o
      LEFT JOIN public.realtime_projection_watermarks w
        ON w.aggregate_type=o.aggregate_type AND w.aggregate_key=o.aggregate_key
      WHERE o.status IN ('pending','failed')
        AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= now())
        AND o.id > COALESCE(w.last_delivered_outbox_id,0)
        AND NOT EXISTS (
          SELECT 1 FROM public.realtime_outbox earlier
          WHERE earlier.aggregate_type=o.aggregate_type
            AND earlier.aggregate_key=o.aggregate_key
            AND earlier.id < o.id
            AND earlier.status <> 'delivered'
        )
      ORDER BY o.id ASC
      LIMIT $1
    `, [boundedLimit], signal);
    return rows.map(mapRow);
  }

  /** Marks delivery and advances the aggregate watermark atomically. */
  async markDelivered(event: Pick<OutboxEvent, "id" | "aggregate_type" | "aggregate_key">, signal: AbortSignal): Promise<void> {
    await this.database.transaction(signal, async (query) => {
      await query.rows(`
        UPDATE public.realtime_outbox
        SET status='delivered',delivered_at=now(),next_attempt_at=NULL,last_error_category=NULL
        WHERE id=$1 AND status IN ('pending','failed')
      `, [event.id], signal);
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
    pending_count: number;
    failed_count: number;
    oldest_pending_age_ms: number | null;
  }> {
    const rows = await this.database.rows(`
      SELECT COUNT(*) FILTER (WHERE status='pending') AS pending_count,
        COUNT(*) FILTER (WHERE status='failed') AS failed_count,
        EXTRACT(EPOCH FROM (now()-MIN(created_at)))*1000
          FILTER (WHERE status IN ('pending','failed')) AS oldest_pending_age_ms
      FROM public.realtime_outbox
    `, [], signal);
    const row = rows[0];
    return {
      pending_count: Number(row?.pending_count ?? 0),
      failed_count: Number(row?.failed_count ?? 0),
      oldest_pending_age_ms: row?.oldest_pending_age_ms === null || row?.oldest_pending_age_ms === undefined
        ? null : Number(row.oldest_pending_age_ms),
    };
  }
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
