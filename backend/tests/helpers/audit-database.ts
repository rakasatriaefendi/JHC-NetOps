import type { PostgresQuery, PostgresTransactionalQuery } from "../../src/persistence/postgres-query.js";

export const AUDIT_ACTOR = "11111111-1111-4111-8111-111111111111";
export class AuditDatabase implements PostgresTransactionalQuery {
  calls: { sql: string; values: readonly unknown[] }[] = [];
  committed: readonly unknown[][] = [];
  role = "admin";
  status = "approved";
  credential = true;
  failAppend = false;
  readRows: Record<string, unknown>[] = [];
  private staged: readonly unknown[][] = [];

  async transaction<T>(signal: AbortSignal, action: (query: PostgresQuery) => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    const before = this.staged.length;
    try {
      const result = await action(this);
      signal.throwIfAborted();
      this.committed = [...this.staged];
      return result;
    } catch (error) { this.staged = this.staged.slice(0, before); throw error; }
  }
  async rows(sql: string, values: readonly unknown[], signal: AbortSignal): Promise<readonly Record<string, unknown>[]> {
    signal.throwIfAborted();
    this.calls.push({ sql, values });
    if (sql.includes("FOR SHARE OF p,c")) return values[0] === AUDIT_ACTOR && this.role === "admin" && this.status === "approved" && this.credential ? [{ id: AUDIT_ACTOR }] : [];
    if (sql.includes("INSERT INTO public.administrative_audit")) {
      if (this.failAppend) throw new Error("test database failure");
      this.staged = [...this.staged, [...values]];
      return [];
    }
    if (sql.includes("UNION ALL")) return this.readRows;
    return [];
  }
}
