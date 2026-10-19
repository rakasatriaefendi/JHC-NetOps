import type { PostgresQuery, PostgresTransactionalQuery } from "../persistence/postgres-query.js";
import { WORK_KINDS, type WorkKind } from "./contract.js";

export interface RunnerWorkRepository {
  available(runnerId: string, signal: AbortSignal): Promise<readonly WorkKind[]>;
  recover(signal: AbortSignal): Promise<void>;
}

export class RunnerNotRegistered extends Error {}

export class PostgresRunnerWorkRepository implements RunnerWorkRepository {
  constructor(private readonly database: PostgresTransactionalQuery) {}

  private bounded<T>(signal: AbortSignal, action: (query: PostgresQuery) => Promise<T>): Promise<T> {
    return this.database.transaction(signal, async (query) => {
      await query.rows("SELECT set_config('statement_timeout','3000',true)", [], signal);
      return action(query);
    });
  }

  async assignments(runnerId: string, signal: AbortSignal): Promise<{ health: boolean; telemetry: boolean }> {
    const rows = await this.bounded(signal, (query) => query.rows(`
      SELECT
        EXISTS(SELECT 1 FROM public.network_targets WHERE runner_id=$1 AND enabled=true) AS health,
        EXISTS(SELECT 1 FROM public.managed_telemetry_targets WHERE runner_id=$1 AND enabled=true) AS telemetry
    `, [runnerId], signal));
    const row = rows[0];
    if (!row || typeof row.health !== "boolean" || typeof row.telemetry !== "boolean") throw new Error("Invalid assignments");
    return { health: row.health, telemetry: row.telemetry };
  }

  async available(runnerId: string, signal: AbortSignal): Promise<readonly WorkKind[]> {
    // One bounded read; never claims a job or holds a connection while waiting.
    const rows = await this.bounded(signal, (query) => query.rows(`
      SELECT
        (r.capabilities->'operations' ? 'manual_ping' AND EXISTS(
          SELECT 1 FROM public.network_health_ping_jobs WHERE runner_id=r.id
          AND status='queued' AND expires_at >= now())) AS manual_ping,
        EXISTS(SELECT 1 FROM public.traffic_live_sessions WHERE runner_id=r.id
          AND status='queued' AND created_at >= now() - interval '10 minutes') AS traffic,
        EXISTS(SELECT 1 FROM public.network_discovery_sessions WHERE runner_id=r.id
          AND status='queued' AND expires_at >= now()) AS discovery,
        EXISTS(SELECT 1 FROM public.device_inspection_sessions WHERE runner_id=r.id
          AND status='queued' AND expires_at >= now()) AS device_inspector
      FROM public.diagnostic_runners r WHERE r.id=$1
    `, [runnerId], signal));
    const row = rows[0];
    if (!row) throw new RunnerNotRegistered();
    return WORK_KINDS.filter((kind) => row[kind] === true);
  }

  async recover(signal: AbortSignal): Promise<void> {
    // Same lease predicates/terminal fields as existing claim recovery. At most
    // 100 rows per subsystem per pass; SKIP LOCKED never waits behind active work.
    await this.bounded(signal, (query) => query.rows(`
      WITH ping AS (
        UPDATE public.network_health_ping_jobs SET status='failed',completed_at=now(),updated_at=now(),
          error_code='MANUAL_PING_TARGET_UNAVAILABLE'
        WHERE id IN (SELECT id FROM public.network_health_ping_jobs
          WHERE status IN ('queued','running') AND expires_at < now()
          ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED) RETURNING id
      ), traffic AS (
        UPDATE public.traffic_live_sessions SET status='expired',stage='expired',completed_at=now(),updated_at=now(),
          error_code='SESSION_ORPHANED',
          error_message='Traffic session lost its runner lease and was recovered automatically'
        WHERE id IN (SELECT id FROM public.traffic_live_sessions WHERE
          (status='queued' AND created_at < now() - interval '10 minutes') OR
          (status='stopping' AND (started_at IS NULL OR expires_at < now() OR updated_at < now() - interval '30 seconds')) OR
          (status='running' AND (expires_at < now() OR updated_at < now() - interval '45 seconds'))
          ORDER BY updated_at LIMIT 100 FOR UPDATE SKIP LOCKED) RETURNING id
      ), discovery AS (
        UPDATE public.network_discovery_sessions SET status='expired',phase='scan',completed_at=now(),updated_at=now(),
          error_code='SESSION_ORPHANED'
        WHERE runner_id IN (SELECT runner_id FROM public.network_discovery_sessions
          WHERE status IN ('queued','running') AND expires_at < now()
          ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED) RETURNING runner_id
      ), inspection AS (
        UPDATE public.device_inspection_sessions SET status='expired',stage='complete',completed_at=now(),updated_at=now(),
          error_code='SESSION_ORPHANED'
        WHERE runner_id IN (SELECT runner_id FROM public.device_inspection_sessions
          WHERE status IN ('queued','running') AND expires_at < now()
          ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED) RETURNING runner_id
      ) SELECT (SELECT count(*) FROM ping) + (SELECT count(*) FROM traffic) +
        (SELECT count(*) FROM discovery) + (SELECT count(*) FROM inspection) AS recovered
    `, [], signal));
  }
}
