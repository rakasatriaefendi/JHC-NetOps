import type { PostgresTransactionalQuery } from "./postgres-query.js";
import { ControlPlanePersistenceError, RUNNER_ID, UUID, privateIpv4, record, requireFreshRunner, requireOperator } from "./control-plane.js";
import type { DeviceFingerprint, DeviceInspectionStage } from "../device-inspector/contract.js";

type Row = Record<string, unknown>;

export interface DeviceInspectionRepository {
  get(runnerId: string, signal: AbortSignal): Promise<Row | null>;
  create(actorId: string, input: InspectionCreateInput, signal: AbortSignal): Promise<Row>;
  claim(runnerId: string, now: string, signal: AbortSignal): Promise<Row | null>;
  updateStage(runnerId: string, inspectionId: string, stage: DeviceInspectionStage,
    now: string, signal: AbortSignal): Promise<Row | null>;
  complete(runnerId: string, inspectionId: string, result: DeviceFingerprint,
    now: string, signal: AbortSignal): Promise<Row | null>;
  fail(runnerId: string, inspectionId: string, errorCode: string,
    now: string, signal: AbortSignal): Promise<Row | null>;
  expireStale(signal: AbortSignal): Promise<void>;
}

export type InspectionCreateInput = Readonly<{
  runnerId: string;
  targetIp: string;
}>;

export class PostgresDeviceInspectionRepository implements DeviceInspectionRepository {
  constructor(private readonly database: PostgresTransactionalQuery) {}

  async get(runnerId: string, signal: AbortSignal): Promise<Row | null> {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(runnerId)) return null;
    const rows = await this.database.rows(`
      SELECT runner_id,inspection_id,requested_by,target_ip,authorization_source,status,stage,
        result,error_code,created_at,started_at,completed_at,expires_at,updated_at
      FROM public.device_inspection_sessions WHERE runner_id=$1
    `, [runnerId], signal);
    return rows[0] ?? null;
  }

  async create(actorId: string, input: InspectionCreateInput, signal: AbortSignal): Promise<Row> {
    if (!UUID.test(actorId) || !RUNNER_ID.test(input.runnerId) || !privateIpv4(input.targetIp)) {
      throw new ControlPlanePersistenceError("INVALID_CONTROL_PLANE_INPUT");
    }
    return this.database.transaction(signal, async (query) => {
      await requireOperator(query, actorId, signal);
      await query.rows(`
        UPDATE public.device_inspection_sessions SET status='expired',result=NULL,error_code=NULL,updated_at=now()
        WHERE expires_at < now() AND status <> 'expired'
      `, [], signal);
      const runner = await requireFreshRunner(query, input.runnerId, "device_inspect", signal);
      const inspector = record(runner.capabilities.device_inspector);
      if (inspector && inspector.available !== true) {
        throw new ControlPlanePersistenceError("OPERATION_NOT_AUTHORIZED");
      }
      let authorizationSource: "inventory" | "discovery" | null = null;
      const inventory = await query.rows(`
        SELECT id FROM public.network_nodes WHERE ip_address=$1::inet LIMIT 1
      `, [input.targetIp], signal);
      if (inventory[0]) authorizationSource = "inventory";
      if (!authorizationSource) {
        const discovery = await query.rows(`
          SELECT status,expires_at,results FROM public.network_discovery_sessions
          WHERE runner_id=$1 AND expires_at > now() AND status IN ('idle','running','completed')
        `, [input.runnerId], signal);
        const results = discovery[0]?.results;
        if (Array.isArray(results) && results.some((item) => record(item)?.ip_address === input.targetIp)) {
          authorizationSource = "discovery";
        }
      }
      if (!authorizationSource) throw new ControlPlanePersistenceError("TARGET_NOT_AUTHORIZED");
      const busy = await query.rows(`
        SELECT
          EXISTS(SELECT 1 FROM public.diagnostic_jobs WHERE runner_id=$1 AND status IN ('queued','running')) AS diagnostic,
          EXISTS(SELECT 1 FROM public.traffic_live_sessions WHERE runner_id=$1 AND status IN ('queued','running','stopping')) AS traffic,
          EXISTS(SELECT 1 FROM public.network_discovery_sessions WHERE runner_id=$1 AND status IN ('queued','running')) AS discovery,
          EXISTS(SELECT 1 FROM public.device_inspection_sessions WHERE runner_id=$1 AND status IN ('queued','running')) AS inspection
      `, [input.runnerId], signal);
      if (busy[0]?.diagnostic === true || busy[0]?.traffic === true || busy[0]?.discovery === true ||
          busy[0]?.inspection === true) throw new ControlPlanePersistenceError("RUNNER_BUSY");
      const rows = await query.rows(`
        INSERT INTO public.device_inspection_sessions
          (runner_id,inspection_id,requested_by,target_ip,authorization_source,status,stage,result,error_code,
           created_at,started_at,completed_at,expires_at,updated_at)
        VALUES ($1,gen_random_uuid(),$2::uuid,$3::inet,$4,'queued','validating_target',NULL,NULL,
          now(),NULL,NULL,now() + interval '10 minutes',now())
        ON CONFLICT (runner_id) DO UPDATE SET inspection_id=gen_random_uuid(),requested_by=EXCLUDED.requested_by,
          target_ip=EXCLUDED.target_ip,authorization_source=EXCLUDED.authorization_source,status='queued',
          stage='validating_target',result=NULL,error_code=NULL,created_at=now(),started_at=NULL,completed_at=NULL,
          expires_at=now() + interval '10 minutes',updated_at=now()
        RETURNING *
      `, [input.runnerId, actorId, input.targetIp, authorizationSource], signal);
      if (!rows[0]) throw new ControlPlanePersistenceError("OPERATION_NOT_READY");
      return rows[0];
    });
  }

  async claim(runnerId: string, now: string, signal: AbortSignal): Promise<Row | null> {
    if (!RUNNER_ID.test(runnerId)) return null;
    await this.expireStale(signal);
    const rows = await this.database.rows(`
      UPDATE public.device_inspection_sessions AS session SET
        status='running',started_at=$2::timestamptz,updated_at=$2::timestamptz
      WHERE session.runner_id=$1 AND session.status='queued'
        AND session.inspection_id=(
          SELECT queued.inspection_id FROM public.device_inspection_sessions AS queued
          WHERE queued.runner_id=$1 AND queued.status='queued'
          ORDER BY queued.created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
        )
      RETURNING *
    `, [runnerId, now], signal);
    return rows[0] ?? null;
  }

  async updateStage(runnerId: string, inspectionId: string, stage: DeviceInspectionStage,
    now: string, signal: AbortSignal): Promise<Row | null> {
    if (!RUNNER_ID.test(runnerId) || !UUID.test(inspectionId)) return null;
    const rows = await this.database.rows(`
      UPDATE public.device_inspection_sessions SET stage=$3,updated_at=$4::timestamptz
      WHERE runner_id=$1 AND inspection_id=$2::uuid AND status='running'
      RETURNING *
    `, [runnerId, inspectionId, stage, now], signal);
    return rows[0] ?? null;
  }

  async complete(runnerId: string, inspectionId: string, result: DeviceFingerprint,
    now: string, signal: AbortSignal): Promise<Row | null> {
    if (!RUNNER_ID.test(runnerId) || !UUID.test(inspectionId)) return null;
    const rows = await this.database.rows(`
      UPDATE public.device_inspection_sessions SET
        status='completed',stage='complete',completed_at=$5::timestamptz,
        expires_at=$5::timestamptz + interval '10 minutes',updated_at=$5::timestamptz,
        result=$3::jsonb,error_code=NULL
      WHERE runner_id=$1 AND inspection_id=$2::uuid AND status='running' AND target_ip=$4::inet
      RETURNING *
    `, [runnerId, inspectionId, JSON.stringify(result), result.ip, now], signal);
    return rows[0] ?? null;
  }

  async fail(runnerId: string, inspectionId: string, errorCode: string,
    now: string, signal: AbortSignal): Promise<Row | null> {
    if (!RUNNER_ID.test(runnerId) || !UUID.test(inspectionId) || !/^[A-Z0-9_]{1,64}$/.test(errorCode)) return null;
    const rows = await this.database.rows(`
      UPDATE public.device_inspection_sessions SET
        status='failed',stage='complete',completed_at=$4::timestamptz,
        expires_at=$4::timestamptz + interval '10 minutes',updated_at=$4::timestamptz,
        result=NULL,error_code=$3
      WHERE runner_id=$1 AND inspection_id=$2::uuid AND status='running'
      RETURNING *
    `, [runnerId, inspectionId, errorCode, now], signal);
    return rows[0] ?? null;
  }

  async expireStale(signal: AbortSignal): Promise<void> {
    await this.database.rows(`
      UPDATE public.device_inspection_sessions SET
        status='expired', stage='complete', completed_at=now(), updated_at=now(),
        error_code='SESSION_ORPHANED'
      WHERE status IN ('queued','running') AND expires_at < now()
    `, [], signal);
  }
}
