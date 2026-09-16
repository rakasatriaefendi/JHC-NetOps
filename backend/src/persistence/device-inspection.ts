import type { PostgresTransactionalQuery } from "./postgres-query.js";

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
  requestedBy: string;
  targetIp: string;
  authorizationSource: "discovery" | "inventory";
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
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!UUID.test(actorId)) throw new Error("Invalid actor");
    if (!/^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/.test(input.targetIp)) {
      throw new Error("Invalid target IP");
    }
    if (!["discovery", "inventory"].includes(input.authorizationSource)) {
      throw new Error("Invalid authorization source");
    }
    const rows = await this.database.rows(`
      INSERT INTO public.device_inspection_sessions
        (runner_id,requested_by,target_ip,authorization_source,status,stage)
      VALUES ($1,$2,$3::inet,$4,'queued','validating_target')
      ON CONFLICT (runner_id) DO UPDATE SET
        requested_by=EXCLUDED.requested_by,
        target_ip=EXCLUDED.target_ip,
        authorization_source=EXCLUDED.authorization_source,
        status='queued',stage='validating_target',
        expires_at=now() + interval '10 minutes', updated_at=now()
      RETURNING *
    `, [input.runnerId, actorId, input.targetIp, input.authorizationSource], signal);
    if (!rows[0]) throw new Error("Inspection session create failed");
    return rows[0];
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