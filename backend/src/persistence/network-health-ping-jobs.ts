import type { PostgresTransactionalQuery } from "./postgres-query.js";

type Row = Record<string, unknown>;

export interface NetworkHealthPingJobsRepository {
  listByRunner(runnerId: string, signal: AbortSignal): Promise<readonly Row[]>;
  get(jobId: string, signal: AbortSignal): Promise<Row | null>;
  create(actorId: string, input: PingJobCreateInput, signal: AbortSignal): Promise<Row>;
  claim(runnerId: string, signal: AbortSignal): Promise<Row | null>;
  complete(jobId: string, runnerId: string, now: string, result: Row, signal: AbortSignal): Promise<Row | null>;
  fail(jobId: string, runnerId: string, now: string, errorCode: string, signal: AbortSignal): Promise<Row | null>;
  expireStale(signal: AbortSignal): Promise<void>;
}

export type PingJobCreateInput = Readonly<{
  targetId: string;
  runnerId: string;
  requestedBy: string;
}>;

export class PostgresNetworkHealthPingJobsRepository implements NetworkHealthPingJobsRepository {
  constructor(private readonly database: PostgresTransactionalQuery) {}

  async listByRunner(runnerId: string, signal: AbortSignal): Promise<readonly Row[]> {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(runnerId)) return [];
    return this.database.rows(`
      SELECT id,target_id,runner_id,requested_by,status,result,error_code,
        created_at,started_at,completed_at,expires_at,updated_at
      FROM public.network_health_ping_jobs
      WHERE runner_id=$1 ORDER BY created_at DESC LIMIT 200
    `, [runnerId], signal);
  }

  async get(jobId: string, signal: AbortSignal): Promise<Row | null> {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!UUID.test(jobId)) return null;
    const rows = await this.database.rows(`
      SELECT id,target_id,runner_id,requested_by,status,result,error_code,
        created_at,started_at,completed_at,expires_at,updated_at
      FROM public.network_health_ping_jobs WHERE id=$1::uuid
    `, [jobId], signal);
    return rows[0] ?? null;
  }

  async create(actorId: string, input: PingJobCreateInput, signal: AbortSignal): Promise<Row> {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const RUNNER = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
    if (!UUID.test(actorId) || !UUID.test(input.targetId) || !RUNNER.test(input.runnerId)) {
      throw new Error("Invalid ping job input");
    }
    const rows = await this.database.rows(`
      INSERT INTO public.network_health_ping_jobs
        (target_id,runner_id,requested_by,status)
      VALUES ($1::uuid,$2,$3::uuid,'queued')
      ON CONFLICT DO NOTHING
      RETURNING *
    `, [input.targetId, input.runnerId, actorId], signal);
    if (!rows[0]) {
      const existing = await this.database.rows(`
        SELECT * FROM public.network_health_ping_jobs
        WHERE target_id=$1::uuid AND status IN ('queued','running')
        ORDER BY created_at DESC LIMIT 1
      `, [input.targetId], signal);
      if (existing[0]) return existing[0];
      throw new Error("Ping job create failed");
    }
    return rows[0];
  }

  async claim(runnerId: string, signal: AbortSignal): Promise<Row | null> {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(runnerId)) return null;
    const rows = await this.database.rows(`
      UPDATE public.network_health_ping_jobs SET
        status='running', started_at=now(), updated_at=now()
      WHERE id = (
        SELECT id FROM public.network_health_ping_jobs
        WHERE runner_id=$1 AND status='queued'
        ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
      ) AND status='queued'
      RETURNING *
    `, [runnerId], signal);
    return rows[0] ?? null;
  }

  async complete(jobId: string, runnerId: string, now: string, result: Row, signal: AbortSignal): Promise<Row | null> {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const RUNNER = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
    if (!UUID.test(jobId) || !RUNNER.test(runnerId)) return null;
    const rows = await this.database.rows(`
      UPDATE public.network_health_ping_jobs SET
        status='completed', completed_at=$3::timestamptz, updated_at=$3::timestamptz,
        result=$4::jsonb
      WHERE id=$1::uuid AND runner_id=$2 AND status IN ('queued','running') RETURNING *
    `, [jobId, runnerId, now, JSON.stringify(result)], signal);
    return rows[0] ?? null;
  }

  async fail(jobId: string, runnerId: string, now: string, errorCode: string, signal: AbortSignal): Promise<Row | null> {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const RUNNER = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
    const ALLOWED_CODES = new Set(["MANUAL_PING_FAILED", "MANUAL_PING_TARGET_UNAVAILABLE"]);
    if (!UUID.test(jobId) || !RUNNER.test(runnerId) || !ALLOWED_CODES.has(errorCode)) return null;
    const rows = await this.database.rows(`
      UPDATE public.network_health_ping_jobs SET
        status='failed', completed_at=$3::timestamptz, updated_at=$3::timestamptz,
        error_code=$4
      WHERE id=$1::uuid AND runner_id=$2 AND status IN ('queued','running') RETURNING *
    `, [jobId, runnerId, now, errorCode], signal);
    return rows[0] ?? null;
  }

  async expireStale(signal: AbortSignal): Promise<void> {
    await this.database.rows(`
      UPDATE public.network_health_ping_jobs SET
        status='failed', completed_at=now(), updated_at=now(),
        error_code='MANUAL_PING_TARGET_UNAVAILABLE'
      WHERE status IN ('queued','running') AND expires_at < now()
    `, [], signal);
  }
}