import type { Pool } from "pg";

/** Server-side SQL boundary. Values are parameters; callers own fixed SQL text. */
export interface PostgresQuery {
  rows(sql: string, values: readonly unknown[], signal: AbortSignal): Promise<readonly Record<string, unknown>[]>;
}

export interface PostgresTransactionalQuery extends PostgresQuery {
  transaction<T>(signal: AbortSignal, action: (query: PostgresQuery) => Promise<T>): Promise<T>;
}

export class PoolPostgresQuery implements PostgresTransactionalQuery {
  constructor(private readonly pool: Pool) {}

  async rows(sql: string, values: readonly unknown[], signal: AbortSignal): Promise<readonly Record<string, unknown>[]> {
    signal.throwIfAborted();
    const result = await this.pool.query(sql, [...values]);
    signal.throwIfAborted();
    return result.rows as Record<string, unknown>[];
  }

  async transaction<T>(signal: AbortSignal, action: (query: PostgresQuery) => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    const client = await this.pool.connect();
    let begun = false;
    try {
      await client.query("BEGIN");
      begun = true;
      const query: PostgresQuery = {
        rows: async (sql, values, querySignal) => {
          querySignal.throwIfAborted();
          const result = await client.query(sql, [...values]);
          querySignal.throwIfAborted();
          return result.rows as Record<string, unknown>[];
        },
      };
      const result = await action(query);
      signal.throwIfAborted();
      await client.query("COMMIT");
      begun = false;
      return result;
    } catch (error) {
      if (begun) await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
