import type { PostgresTransactionalQuery } from "./postgres-query.js";

export type CanaryResult = Readonly<{
  id: string;
  created_at: string;
  verified_at: string | null;
}>;

/** Fixed-table, non-domain cutover canary. Caller input never selects SQL. */
export class PostgresCutoverCanaryRepository {
  constructor(private readonly database: PostgresTransactionalQuery) {}

  async write(cutoverIdentity: string, payload: Record<string, unknown>, signal: AbortSignal): Promise<CanaryResult> {
    return this.database.transaction(signal, async (query) => {
      await query.rows(`
        DELETE FROM public.cutover_canary WHERE id IN (
          SELECT id FROM public.cutover_canary WHERE expires_at <= now()
          ORDER BY expires_at ASC LIMIT 100
        )
      `, [], signal);
      const rows = await query.rows(`
        INSERT INTO public.cutover_canary (cutover_identity,payload)
        VALUES ($1,$2::jsonb)
        RETURNING id,created_at,verified_at
      `, [cutoverIdentity, JSON.stringify(payload)], signal);
      return canary(rows[0]);
    });
  }

  async read(cutoverIdentity: string, canaryId: string, signal: AbortSignal): Promise<CanaryResult | null> {
    const rows = await this.database.rows(`
      SELECT id,created_at,verified_at FROM public.cutover_canary
      WHERE id=$1::uuid AND cutover_identity=$2 AND expires_at > now()
    `, [canaryId, cutoverIdentity], signal);
    return rows[0] ? canary(rows[0]) : null;
  }

  async verify(cutoverIdentity: string, canaryId: string, signal: AbortSignal): Promise<boolean> {
    const rows = await this.database.rows(`
      UPDATE public.cutover_canary SET verified_at=now()
      WHERE id=$1::uuid AND cutover_identity=$2 AND verified_at IS NULL AND expires_at > now()
      RETURNING id
    `, [canaryId, cutoverIdentity], signal);
    return rows.length === 1;
  }

  /** Real bounded cleanup: successful cleanup leaves no canary row. */
  async cleanup(cutoverIdentity: string, canaryId: string, signal: AbortSignal): Promise<boolean> {
    const rows = await this.database.rows(`
      DELETE FROM public.cutover_canary
      WHERE id=$1::uuid AND cutover_identity=$2
      RETURNING id
    `, [canaryId, cutoverIdentity], signal);
    return rows.length === 1;
  }
}

function canary(row: Record<string, unknown> | undefined): CanaryResult {
  if (!row || typeof row.id !== "string") throw new Error("Canary persistence failed");
  return { id: row.id, created_at: iso(row.created_at), verified_at: row.verified_at ? iso(row.verified_at) : null };
}

function iso(value: unknown): string { return value instanceof Date ? value.toISOString() : String(value); }
