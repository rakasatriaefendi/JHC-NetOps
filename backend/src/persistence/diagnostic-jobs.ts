import type { PostgresQuery } from "./postgres-query.js";

type Row = Record<string, unknown>;

export interface DiagnosticJobsRepository {
  listByRunner(runnerId: string, signal: AbortSignal): Promise<readonly Row[]>;
  get(jobId: string, signal: AbortSignal): Promise<Row | null>;
  claim(runnerId: string, signal: AbortSignal): Promise<Row | null>;
  updateStage(jobId: string, runnerId: string, stage: string, now: string, signal: AbortSignal): Promise<Row | null>;
  complete(jobId: string, runnerId: string, now: string, result: Row, signal: AbortSignal): Promise<Row | null>;
  fail(jobId: string, runnerId: string, now: string, errorCode: string, errorMessage: string, signal: AbortSignal): Promise<Row | null>;
}

export class PostgresDiagnosticJobsRepository implements DiagnosticJobsRepository {
  constructor(private readonly database: PostgresQuery) {}

  async listByRunner(runnerId: string, signal: AbortSignal): Promise<readonly Row[]> {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(runnerId)) return [];
    return this.database.rows(`
      SELECT id,runner_id,requested_by,status,type,source_label,target_id,target_label,target_host,
        iperf_port,connection_type,duration_seconds,environment,stage,progress,error_code,error_message,
        created_at,started_at,completed_at,updated_at,network_context,route_context,preflight_context
      FROM public.diagnostic_jobs
      WHERE runner_id=$1 ORDER BY created_at DESC LIMIT 500
    `, [runnerId], signal);
  }

  async get(jobId: string, signal: AbortSignal): Promise<Row | null> {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!UUID.test(jobId)) return null;
    const rows = await this.database.rows(`
      SELECT id,runner_id,requested_by,status,type,source_label,target_id,target_label,target_host,
        iperf_port,connection_type,duration_seconds,environment,stage,progress,error_code,error_message,
        created_at,started_at,completed_at,updated_at,network_context,route_context,preflight_context
      FROM public.diagnostic_jobs WHERE id=$1::uuid
    `, [jobId], signal);
    return rows[0] ?? null;
  }

  async claim(runnerId: string, signal: AbortSignal): Promise<Row | null> {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(runnerId)) return null;
    const rows = await this.database.rows(`
      UPDATE public.diagnostic_jobs SET
        status='running', stage='preparing_runner', started_at=now(), updated_at=now()
      WHERE id = (
        SELECT id FROM public.diagnostic_jobs
        WHERE runner_id=$1 AND status='queued'
        ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
      ) AND status='queued'
      RETURNING *
    `, [runnerId], signal);
    return rows[0] ?? null;
  }

  async updateStage(jobId: string, runnerId: string, stage: string, now: string, signal: AbortSignal): Promise<Row | null> {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const RUNNER = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
    if (!UUID.test(jobId) || !RUNNER.test(runnerId)) return null;
    const rows = await this.database.rows(`
      UPDATE public.diagnostic_jobs SET stage=$3, updated_at=$4::timestamptz
      WHERE id=$1::uuid AND runner_id=$2 AND status IN ('running','queued') RETURNING *
    `, [jobId, runnerId, stage, now], signal);
    return rows[0] ?? null;
  }

  async complete(jobId: string, runnerId: string, now: string, result: Row, signal: AbortSignal): Promise<Row | null> {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const RUNNER = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
    if (!UUID.test(jobId) || !RUNNER.test(runnerId)) return null;
    const rows = await this.database.rows(`
      UPDATE public.diagnostic_jobs SET
        status='completed', stage='complete', completed_at=$3::timestamptz, updated_at=$3::timestamptz,
        network_context=$4::jsonb, route_context=$5::jsonb, preflight_context=$6::jsonb
      WHERE id=$1::uuid AND runner_id=$2 AND status IN ('running','queued') RETURNING *
    `, [jobId, runnerId, now, JSON.stringify(result.network_context ?? {}),
      JSON.stringify(result.route_context ?? {}), JSON.stringify(result.preflight_context ?? {})], signal);
    return rows[0] ?? null;
  }

  async fail(jobId: string, runnerId: string, now: string, errorCode: string, errorMessage: string, signal: AbortSignal): Promise<Row | null> {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const RUNNER = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
    const SAFE_CODE = /^[A-Z0-9_]{1,64}$/;
    if (!UUID.test(jobId) || !RUNNER.test(runnerId) || !SAFE_CODE.test(errorCode)) return null;
    const rows = await this.database.rows(`
      UPDATE public.diagnostic_jobs SET
        status='failed', stage='failed', completed_at=$3::timestamptz, updated_at=$3::timestamptz,
        error_code=$4, error_message=$5
      WHERE id=$1::uuid AND runner_id=$2 AND status IN ('running','queued') RETURNING *
    `, [jobId, runnerId, now, errorCode, errorMessage.slice(0, 300)], signal);
    return rows[0] ?? null;
  }
}