import { ControlPlanePersistenceError, RUNNER_ID, UUID, record, requireFreshRunner, requireOperator } from "./control-plane.js";
import type { PostgresTransactionalQuery } from "./postgres-query.js";

type Row = Record<string, unknown>;

export type DiagnosticJobCreateInput = Readonly<{
  runnerId: string;
  sourceLabel: string;
  targetId: string;
  durationSeconds: number;
}>;

export interface DiagnosticJobsRepository {
  listByRunner(runnerId: string, signal: AbortSignal): Promise<readonly Row[]>;
  get(jobId: string, signal: AbortSignal): Promise<Row | null>;
  requestPreflight(actorId: string, runnerId: string, targetId: string, signal: AbortSignal): Promise<Row>;
  create(actorId: string, input: DiagnosticJobCreateInput, signal: AbortSignal): Promise<Row>;
  claim(runnerId: string, signal: AbortSignal): Promise<Row | null>;
  updateStage(jobId: string, runnerId: string, stage: string, now: string, signal: AbortSignal): Promise<Row | null>;
  complete(jobId: string, runnerId: string, now: string, result: Row, signal: AbortSignal): Promise<Row | null>;
  fail(jobId: string, runnerId: string, now: string, errorCode: string, errorMessage: string, signal: AbortSignal): Promise<Row | null>;
}

export class PostgresDiagnosticJobsRepository implements DiagnosticJobsRepository {
  constructor(private readonly database: PostgresTransactionalQuery) {}

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

  async create(actorId: string, input: DiagnosticJobCreateInput, signal: AbortSignal): Promise<Row> {
    const SAFE_LABEL = /^.{1,200}$/;
    if (!UUID.test(actorId) || !RUNNER_ID.test(input.runnerId) || !SAFE_LABEL.test(input.sourceLabel) ||
        !RUNNER_ID.test(input.targetId) || ![5, 10].includes(input.durationSeconds)) {
      throw new ControlPlanePersistenceError("INVALID_CONTROL_PLANE_INPUT");
    }
    try {
      return await this.database.transaction(signal, async (query) => {
        await requireOperator(query, actorId, signal);
        const runner = await requireFreshRunner(query, input.runnerId, "bandwidth_and_path", signal);
        const target = diagnosticTarget(runner.capabilities, input.targetId);
        const sourceLocations = runner.capabilities.source_locations;
        const durations = runner.capabilities.durations;
        if (!target || !Array.isArray(sourceLocations) || !sourceLocations.includes(input.sourceLabel) ||
            !Array.isArray(durations) || !durations.includes(input.durationSeconds)) {
          throw new ControlPlanePersistenceError("TARGET_NOT_AUTHORIZED");
        }
        const ready = readyPreflight(runner.preflight, target.id);
        if (!ready) throw new ControlPlanePersistenceError("OPERATION_NOT_READY");
        await expireStaleTraffic(query, input.runnerId, signal);
        const busy = await query.rows(`
          SELECT
            EXISTS(SELECT 1 FROM public.traffic_live_sessions WHERE runner_id=$1 AND status IN ('queued','running','stopping')) AS traffic,
            EXISTS(SELECT 1 FROM public.network_discovery_sessions WHERE runner_id=$1 AND status IN ('queued','running')) AS discovery,
            EXISTS(SELECT 1 FROM public.device_inspection_sessions WHERE runner_id=$1 AND status IN ('queued','running')) AS inspection
        `, [input.runnerId], signal);
        if (busy[0]?.traffic === true || busy[0]?.discovery === true || busy[0]?.inspection === true) {
          throw new ControlPlanePersistenceError("RUNNER_BUSY");
        }
        const rows = await query.rows(`
          INSERT INTO public.diagnostic_jobs
            (runner_id,requested_by,status,type,source_label,target_id,target_label,target_host,
             iperf_port,connection_type,duration_seconds,environment,stage,progress,
             network_context,route_context,preflight_context)
          VALUES ($1,$2::uuid,'queued','bandwidth_and_path',$3,$4,$5,$6,$7,$8,$9,$10,
            'queued','{}'::jsonb,$11::jsonb,$12::jsonb,$13::jsonb)
          RETURNING *
        `, [input.runnerId, actorId, input.sourceLabel, target.id, target.label, target.host,
          target.iperf_port, ready.connectionType, input.durationSeconds, target.environment,
          JSON.stringify(ready.networkContext), JSON.stringify(ready.routeContext), JSON.stringify(runner.preflight)], signal);
        if (!rows[0]) throw new ControlPlanePersistenceError("RUNNER_BUSY");
        return rows[0];
      });
    } catch (error) {
      if (record(error)?.code === "23505") throw new ControlPlanePersistenceError("RUNNER_BUSY");
      throw error;
    }
  }

  async requestPreflight(actorId: string, runnerId: string, targetId: string, signal: AbortSignal): Promise<Row> {
    if (!UUID.test(actorId) || !RUNNER_ID.test(runnerId) || !RUNNER_ID.test(targetId)) {
      throw new ControlPlanePersistenceError("INVALID_CONTROL_PLANE_INPUT");
    }
    return this.database.transaction(signal, async (query) => {
      await requireOperator(query, actorId, signal);
      const runner = await requireFreshRunner(query, runnerId, "bandwidth_and_path", signal);
      const target = diagnosticTarget(runner.capabilities, targetId);
      if (!target) throw new ControlPlanePersistenceError("TARGET_NOT_AUTHORIZED");
      const existing = runner.preflight;
      const stateTime = existing?.status === "completed" ? existing.completed_at : existing?.requested_at;
      if (existing?.target_id === target.id && ["queued", "running", "completed"].includes(String(existing.status)) &&
          typeof stateTime === "string" && Date.now() - Date.parse(stateTime) < 90_000) return existing;
      const state = { request_id: crypto.randomUUID(), target_id: target.id, status: "queued",
        requested_at: new Date().toISOString() };
      const rows = await query.rows(`
        UPDATE public.diagnostic_runners SET preflight=$2::jsonb,updated_at=now()
        WHERE id=$1 RETURNING preflight
      `, [runnerId, JSON.stringify(state)], signal);
      const stored = record(rows[0]?.preflight);
      if (!stored) throw new ControlPlanePersistenceError("OPERATION_NOT_READY");
      return stored;
    });
  }
}

type DiagnosticTarget = Readonly<{ id: string; label: string; host: string; iperf_port: number;
  environment: "lan" | "localhost_demo" }>;

function diagnosticTarget(capabilities: Record<string, unknown>, targetId: string): DiagnosticTarget | null {
  if (!Array.isArray(capabilities.targets)) return null;
  const target = capabilities.targets.map(record).find((item) => item?.id === targetId);
  if (!target || typeof target.id !== "string" || typeof target.label !== "string" ||
      typeof target.host !== "string" || !Number.isSafeInteger(target.iperf_port) ||
      (target.environment !== "lan" && target.environment !== "localhost_demo")) return null;
  return { id: target.id, label: target.label, host: target.host,
    iperf_port: Number(target.iperf_port), environment: target.environment };
}

function readyPreflight(value: Record<string, unknown> | null, targetId: string): Readonly<{
  connectionType: "wifi" | "ethernet";
  networkContext: Record<string, unknown>;
  routeContext: Record<string, unknown>;
}> | null {
  if (!value || value.target_id !== targetId || value.status !== "completed" ||
      typeof value.completed_at !== "string" || Date.now() - Date.parse(value.completed_at) > 90_000) return null;
  const networkContext = record(value.network_context);
  const routeContext = record(value.route_context);
  const checks = record(value.checks);
  const iperf = record(checks?.iperf);
  if (!networkContext || !routeContext || !iperf || iperf.ready !== true ||
      (networkContext.connection_type !== "wifi" && networkContext.connection_type !== "ethernet")) return null;
  return { connectionType: networkContext.connection_type, networkContext, routeContext };
}

async function expireStaleTraffic(query: import("./postgres-query.js").PostgresQuery, runnerId: string,
  signal: AbortSignal): Promise<void> {
  await query.rows(`
    UPDATE public.traffic_live_sessions SET status='expired',stage='expired',completed_at=now(),updated_at=now(),
      error_code='SESSION_ORPHANED',error_message='Traffic session lost its runner lease and was recovered automatically'
    WHERE runner_id=$1 AND ((status='queued' AND created_at < now() - interval '10 minutes') OR
      (status='stopping' AND (started_at IS NULL OR expires_at < now() OR updated_at < now() - interval '30 seconds')) OR
      (status='running' AND (expires_at < now() OR updated_at < now() - interval '45 seconds')))
  `, [runnerId], signal);
}
