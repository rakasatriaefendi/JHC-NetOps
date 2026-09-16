import type {
  RunnerHeartbeatRepository,
  RunnerHeartbeatRow,
  StoredRunnerHeartbeat,
} from "../runner-heartbeat/repository.js";
import { RunnerHeartbeatPersistenceError } from "../runner-heartbeat/repository.js";
import type { PostgresQuery } from "./postgres-query.js";

export class PostgresRunnerHeartbeatRepository implements RunnerHeartbeatRepository {
  constructor(private readonly database: PostgresQuery) {}

  async upsertHeartbeat(row: RunnerHeartbeatRow, signal: AbortSignal): Promise<StoredRunnerHeartbeat> {
    try {
      const rows = await this.database.rows(`
        INSERT INTO public.diagnostic_runners
          (id, display_name, last_seen_at, health_status, health_error_code, capabilities, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
        ON CONFLICT (id) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          last_seen_at = EXCLUDED.last_seen_at,
          health_status = EXCLUDED.health_status,
          health_error_code = EXCLUDED.health_error_code,
          capabilities = EXCLUDED.capabilities,
          updated_at = EXCLUDED.updated_at
        RETURNING id, last_seen_at, health_status, health_error_code
      `, [row.id, row.display_name, row.last_seen_at, row.health_status, row.health_error_code,
        JSON.stringify(row.capabilities), row.updated_at], signal);
      const stored = rows[0];
      if (!isStoredHeartbeat(stored)) throw new Error("invalid stored heartbeat");
      return {
        id: stored.id,
        last_seen_at: stored.last_seen_at instanceof Date ? stored.last_seen_at.toISOString() : stored.last_seen_at,
        health_status: stored.health_status,
        health_error_code: stored.health_error_code,
      };
    } catch {
      throw new RunnerHeartbeatPersistenceError("RUNNER_HEARTBEAT_STORE_FAILED");
    }
  }

  async expireStaleTrafficSessions(runnerId: string, signal: AbortSignal): Promise<void> {
    try {
      // Exact predicate and terminal fields of expire_stale_traffic_sessions(text).
      await this.database.rows(`
        UPDATE public.traffic_live_sessions SET
          status = 'expired', stage = 'expired', completed_at = now(), updated_at = now(),
          error_code = 'SESSION_ORPHANED',
          error_message = 'Traffic session lost its runner lease and was recovered automatically'
        WHERE runner_id = $1 AND (
          (status = 'queued' AND created_at < now() - interval '10 minutes') OR
          (status = 'stopping' AND (
            started_at IS NULL OR expires_at < now() OR updated_at < now() - interval '30 seconds'
          )) OR
          (status = 'running' AND (
            expires_at < now() OR updated_at < now() - interval '45 seconds'
          ))
        )
      `, [runnerId], signal);
    } catch {
      throw new RunnerHeartbeatPersistenceError("RUNNER_HEARTBEAT_RECOVERY_FAILED");
    }
  }
}

function isStoredHeartbeat(value: unknown): value is Omit<StoredRunnerHeartbeat, "last_seen_at"> & { last_seen_at: string | Date } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && (typeof row.last_seen_at === "string" || row.last_seen_at instanceof Date) &&
    (row.health_status === "online" || row.health_status === "degraded") &&
    (row.health_error_code === null || typeof row.health_error_code === "string");
}
