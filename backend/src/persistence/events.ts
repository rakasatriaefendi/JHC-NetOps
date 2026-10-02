import type { PostgresQuery } from "./postgres-query.js";

type Row = Record<string, unknown>;

export interface EventsRepository {
  insert(event: EventInput, signal: AbortSignal): Promise<Row | null>;
  listBySource(source: string, sourceRef: string | null, limit: number, signal: AbortSignal): Promise<readonly Row[]>;
  listOpenBySource(source: string, limit: number, signal: AbortSignal): Promise<readonly Row[]>;
  listRecent(limit: number, signal: AbortSignal): Promise<readonly Row[]>;
  resolveOpenEvents(source: string, sourceRef: string, resolvedAt: string, signal: AbortSignal): Promise<number>;
}

export type EventInput = Readonly<{
  id: string;
  createdAt: string;
  severity: "low" | "medium" | "high" | "critical";
  title: string;
  description?: string | null;
  rawContext?: Record<string, unknown>;
  aiSummary?: string | null;
  resolvedAt?: string | null;
  source: string;
  sourceRef?: string | null;
}>;

export class PostgresEventsRepository implements EventsRepository {
  constructor(private readonly database: PostgresQuery) {}

  async insert(event: EventInput, signal: AbortSignal): Promise<Row | null> {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const VALID_SEVERITY = new Set(["low", "medium", "high", "critical"]);
    if (!UUID.test(event.id) || !VALID_SEVERITY.has(event.severity) ||
        typeof event.title !== "string" || event.title.length > 200) {
      throw new Error("Invalid event input");
    }
    const rows = await this.database.rows(`
      INSERT INTO public.events
        (id,created_at,severity,title,description,raw_context,ai_summary,resolved_at,source,source_ref)
      VALUES ($1::uuid,$2::timestamptz,$3,$4,$5,$6::jsonb,$7,$8::timestamptz,$9,$10::uuid)
      ON CONFLICT (id) DO NOTHING
      RETURNING *
    `, [
      event.id,
      event.createdAt,
      event.severity,
      event.title,
      event.description ?? null,
      JSON.stringify(event.rawContext ?? {}),
      event.aiSummary ?? null,
      event.resolvedAt ?? null,
      event.source,
      event.sourceRef ?? null,
    ], signal);
    return rows[0] ?? null;
  }

  async listBySource(source: string, sourceRef: string | null, limit: number, signal: AbortSignal): Promise<readonly Row[]> {
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    if (sourceRef) {
      const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (!UUID.test(sourceRef)) return [];
      return this.database.rows(`
        SELECT * FROM public.events
        WHERE source=$1 AND source_ref=$2::uuid
        ORDER BY created_at DESC LIMIT $3
      `, [source, sourceRef, boundedLimit], signal);
    }
    return this.database.rows(`
      SELECT * FROM public.events
      WHERE source=$1 ORDER BY created_at DESC LIMIT $2
    `, [source, boundedLimit], signal);
  }

  async listRecent(limit: number, signal: AbortSignal): Promise<readonly Row[]> {
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    return this.database.rows(`
      SELECT * FROM public.events ORDER BY created_at DESC LIMIT $1
    `, [boundedLimit], signal);
  }

  async listOpenBySource(source: string, limit: number, signal: AbortSignal): Promise<readonly Row[]> {
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    return this.database.rows(`
      SELECT id,created_at,severity,title,description,source_ref,resolved_at,raw_context
      FROM public.events
      WHERE source=$1 AND resolved_at IS NULL
      ORDER BY created_at DESC LIMIT $2
    `, [source, boundedLimit], signal);
  }

  async resolveOpenEvents(source: string, sourceRef: string, resolvedAt: string, signal: AbortSignal): Promise<number> {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!UUID.test(sourceRef)) return 0;
    const rows = await this.database.rows(`
      UPDATE public.events SET resolved_at=$3::timestamptz
      WHERE source=$1 AND source_ref=$2::uuid AND resolved_at IS NULL
      RETURNING id
    `, [source, sourceRef, resolvedAt], signal);
    return rows.length;
  }
}
