import type { PostgresTransactionalQuery } from "./postgres-query.js";
import { ControlPlanePersistenceError, RUNNER_ID, UUID, privateIpv4, record, requireFreshRunner, requireOperator } from "./control-plane.js";

type Row = Record<string, unknown>;

export interface DeviceInspectionRepository {
  get(runnerId: string, signal: AbortSignal): Promise<Row | null>;
  create(actorId: string, input: InspectionCreateInput, signal: AbortSignal): Promise<Row>;
  update(runnerId: string, patch: InspectionUpdateInput, signal: AbortSignal): Promise<Row | null>;
  complete(runnerId: string, now: string, result: Row, signal: AbortSignal): Promise<Row | null>;
  fail(runnerId: string, now: string, errorCode: string, signal: AbortSignal): Promise<Row | null>;
  expireStale(signal: AbortSignal): Promise<void>;
}

export type InspectionCreateInput = Readonly<{
  runnerId: string;
  targetIp: string;
}>;

export type InspectionUpdateInput = Readonly<{
  status?: "queued" | "running" | "completed" | "failed" | "expired";
  stage?: "validating_target" | "network_role" | "identity" | "services" | "normalizing" | "complete";
  result?: Row | null;
  errorCode?: string | null;
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

  async update(runnerId: string, patch: InspectionUpdateInput, signal: AbortSignal): Promise<Row | null> {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(runnerId)) return null;
    const fields: string[] = [];
    const values: unknown[] = [runnerId];
    let paramIndex = 2;
    if (patch.status !== undefined) { fields.push(`status=$${paramIndex++}`); values.push(patch.status); }
    if (patch.stage !== undefined) { fields.push(`stage=$${paramIndex++}`); values.push(patch.stage); }
    if (patch.result !== undefined) { fields.push(`result=$${paramIndex++}::jsonb`); values.push(JSON.stringify(patch.result)); }
    if (patch.errorCode !== undefined) { fields.push(`error_code=$${paramIndex++}`); values.push(patch.errorCode); }
    if (!fields.length) return this.get(runnerId, signal);
    fields.push(`updated_at=now()`);
    const rows = await this.database.rows(`
      UPDATE public.device_inspection_sessions SET ${fields.join(",")}
      WHERE runner_id=$1 RETURNING *
    `, values, signal);
    return rows[0] ?? null;
  }

  async complete(runnerId: string, now: string, result: Row, signal: AbortSignal): Promise<Row | null> {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(runnerId)) return null;
    const rows = await this.database.rows(`
      UPDATE public.device_inspection_sessions SET
        status='completed', stage='complete', completed_at=$2::timestamptz, updated_at=$2::timestamptz,
        result=$3::jsonb
      WHERE runner_id=$1 AND status IN ('queued','running') RETURNING *
    `, [runnerId, now, JSON.stringify(result)], signal);
    return rows[0] ?? null;
  }

  async fail(runnerId: string, now: string, errorCode: string, signal: AbortSignal): Promise<Row | null> {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(runnerId) || !/^[A-Z0-9_]{1,64}$/.test(errorCode)) return null;
    const rows = await this.database.rows(`
      UPDATE public.device_inspection_sessions SET
        status='failed', stage='complete', completed_at=$2::timestamptz, updated_at=$2::timestamptz,
        error_code=$3
      WHERE runner_id=$1 AND status IN ('queued','running') RETURNING *
    `, [runnerId, now, errorCode], signal);
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
