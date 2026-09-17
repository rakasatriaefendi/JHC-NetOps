import type { PostgresTransactionalQuery } from "./postgres-query.js";
import { ControlPlanePersistenceError, RUNNER_ID, UUID, requireFreshRunner, requireOperator } from "./control-plane.js";

type Row = Record<string, unknown>;

export interface NetworkDiscoveryRepository {
  get(runnerId: string, signal: AbortSignal): Promise<Row | null>;
  create(actorId: string, input: DiscoveryCreateInput, signal: AbortSignal): Promise<Row>;
  start(actorId: string, runnerId: string, sessionId: string, signal: AbortSignal): Promise<Row>;
  update(runnerId: string, patch: DiscoveryUpdateInput, signal: AbortSignal): Promise<Row | null>;
  complete(runnerId: string, now: string, results: Row, signal: AbortSignal): Promise<Row | null>;
  fail(runnerId: string, now: string, errorCode: string, signal: AbortSignal): Promise<Row | null>;
  expireStale(signal: AbortSignal): Promise<void>;
}

export type DiscoveryCreateInput = Readonly<{
  runnerId: string;
}>;

export type DiscoveryUpdateInput = Readonly<{
  status?: "idle" | "queued" | "running" | "completed" | "failed" | "expired";
  phase?: "prepare" | "scan";
  connectionType?: "wifi" | "ethernet" | "unknown" | null;
  interfaceAlias?: string | null;
  localIpv4?: string | null;
  subnetCidr?: string | null;
  totalHosts?: number;
  scannedHosts?: number;
  foundCount?: number;
  results?: Row;
  errorCode?: string | null;
}>;

export class PostgresNetworkDiscoveryRepository implements NetworkDiscoveryRepository {
  constructor(private readonly database: PostgresTransactionalQuery) {}

  async get(runnerId: string, signal: AbortSignal): Promise<Row | null> {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(runnerId)) return null;
    const rows = await this.database.rows(`
      SELECT runner_id,session_id,requested_by,status,phase,connection_type,interface_alias,
        local_ipv4,subnet_cidr,total_hosts,scanned_hosts,found_count,results,error_code,
        created_at,started_at,completed_at,expires_at,updated_at
      FROM public.network_discovery_sessions WHERE runner_id=$1
    `, [runnerId], signal);
    return rows[0] ?? null;
  }

  async create(actorId: string, input: DiscoveryCreateInput, signal: AbortSignal): Promise<Row> {
    if (!UUID.test(actorId) || !RUNNER_ID.test(input.runnerId)) {
      throw new ControlPlanePersistenceError("INVALID_CONTROL_PLANE_INPUT");
    }
    return this.database.transaction(signal, async (query) => {
      await requireOperator(query, actorId, signal);
      await query.rows(`
        UPDATE public.network_discovery_sessions SET status='expired',connection_type=NULL,interface_alias=NULL,
          local_ipv4=NULL,subnet_cidr=NULL,total_hosts=0,scanned_hosts=0,found_count=0,results='[]'::jsonb,updated_at=now()
        WHERE expires_at < now() AND status <> 'expired'
      `, [], signal);
      await requireFreshRunner(query, input.runnerId, "network_discovery", signal);
      const current = await query.rows(`
        SELECT * FROM public.network_discovery_sessions
        WHERE runner_id=$1 AND status IN ('queued','running')
      `, [input.runnerId], signal);
      if (current[0]) return current[0];
      const rows = await query.rows(`
        INSERT INTO public.network_discovery_sessions
          (runner_id,session_id,requested_by,status,phase,connection_type,interface_alias,local_ipv4,subnet_cidr,
           total_hosts,scanned_hosts,found_count,results,error_code,created_at,started_at,completed_at,expires_at,updated_at)
        VALUES ($1,gen_random_uuid(),$2::uuid,'queued','prepare',NULL,NULL,NULL,NULL,0,0,0,'[]'::jsonb,NULL,
          now(),NULL,NULL,now() + interval '10 minutes',now())
        ON CONFLICT (runner_id) DO UPDATE SET
          session_id=gen_random_uuid(),requested_by=EXCLUDED.requested_by,status='queued',phase='prepare',
          connection_type=NULL,interface_alias=NULL,local_ipv4=NULL,subnet_cidr=NULL,total_hosts=0,
          scanned_hosts=0,found_count=0,results='[]'::jsonb,error_code=NULL,created_at=now(),started_at=NULL,
          completed_at=NULL,expires_at=now() + interval '10 minutes',updated_at=now()
        RETURNING *
      `, [input.runnerId, actorId], signal);
      if (!rows[0]) throw new ControlPlanePersistenceError("OPERATION_NOT_READY");
      return rows[0];
    });
  }

  async start(actorId: string, runnerId: string, sessionId: string, signal: AbortSignal): Promise<Row> {
    if (!UUID.test(actorId) || !RUNNER_ID.test(runnerId) || !UUID.test(sessionId)) {
      throw new ControlPlanePersistenceError("INVALID_CONTROL_PLANE_INPUT");
    }
    return this.database.transaction(signal, async (query) => {
      await requireOperator(query, actorId, signal);
      await requireFreshRunner(query, runnerId, "network_discovery", signal);
      const busy = await query.rows(`
        SELECT
          EXISTS(SELECT 1 FROM public.diagnostic_jobs WHERE runner_id=$1 AND status IN ('queued','running')) AS diagnostic,
          EXISTS(SELECT 1 FROM public.traffic_live_sessions WHERE runner_id=$1 AND status IN ('queued','running','stopping')) AS traffic,
          EXISTS(SELECT 1 FROM public.device_inspection_sessions WHERE runner_id=$1 AND status IN ('queued','running')) AS inspection
      `, [runnerId], signal);
      if (busy[0]?.diagnostic === true || busy[0]?.traffic === true || busy[0]?.inspection === true) {
        throw new ControlPlanePersistenceError("RUNNER_BUSY");
      }
      const rows = await query.rows(`
        UPDATE public.network_discovery_sessions SET status='queued',phase='scan',scanned_hosts=0,found_count=0,
          results='[]'::jsonb,error_code=NULL,started_at=NULL,completed_at=NULL,
          expires_at=now() + interval '10 minutes',updated_at=now()
        WHERE runner_id=$1 AND session_id=$2::uuid AND status IN ('idle','completed','failed')
        RETURNING *
      `, [runnerId, sessionId], signal);
      if (!rows[0]) throw new ControlPlanePersistenceError("OPERATION_NOT_READY");
      return rows[0];
    });
  }

  async update(runnerId: string, patch: DiscoveryUpdateInput, signal: AbortSignal): Promise<Row | null> {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(runnerId)) return null;
    const fields: string[] = [];
    const values: unknown[] = [runnerId];
    let paramIndex = 2;
    if (patch.status !== undefined) { fields.push(`status=$${paramIndex++}`); values.push(patch.status); }
    if (patch.phase !== undefined) { fields.push(`phase=$${paramIndex++}`); values.push(patch.phase); }
    if (patch.connectionType !== undefined) { fields.push(`connection_type=$${paramIndex++}`); values.push(patch.connectionType); }
    if (patch.interfaceAlias !== undefined) { fields.push(`interface_alias=$${paramIndex++}`); values.push(patch.interfaceAlias); }
    if (patch.localIpv4 !== undefined) { fields.push(`local_ipv4=$${paramIndex++}`); values.push(patch.localIpv4); }
    if (patch.subnetCidr !== undefined) { fields.push(`subnet_cidr=$${paramIndex++}`); values.push(patch.subnetCidr); }
    if (patch.totalHosts !== undefined) { fields.push(`total_hosts=$${paramIndex++}`); values.push(patch.totalHosts); }
    if (patch.scannedHosts !== undefined) { fields.push(`scanned_hosts=$${paramIndex++}`); values.push(patch.scannedHosts); }
    if (patch.foundCount !== undefined) { fields.push(`found_count=$${paramIndex++}`); values.push(patch.foundCount); }
    if (patch.results !== undefined) { fields.push(`results=$${paramIndex++}::jsonb`); values.push(JSON.stringify(patch.results)); }
    if (patch.errorCode !== undefined) { fields.push(`error_code=$${paramIndex++}`); values.push(patch.errorCode); }
    if (!fields.length) return this.get(runnerId, signal);
    fields.push(`updated_at=now()`);
    const rows = await this.database.rows(`
      UPDATE public.network_discovery_sessions SET ${fields.join(",")}
      WHERE runner_id=$1 RETURNING *
    `, values, signal);
    return rows[0] ?? null;
  }

  async complete(runnerId: string, now: string, results: Row, signal: AbortSignal): Promise<Row | null> {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(runnerId)) return null;
    const rows = await this.database.rows(`
      UPDATE public.network_discovery_sessions SET
        status='completed', phase='scan', completed_at=$2::timestamptz, updated_at=$2::timestamptz,
        results=$3::jsonb, found_count=$4
      WHERE runner_id=$1 AND status IN ('queued','running') RETURNING *
    `, [runnerId, now, JSON.stringify(results), Number(results.found_count ?? 0)], signal);
    return rows[0] ?? null;
  }

  async fail(runnerId: string, now: string, errorCode: string, signal: AbortSignal): Promise<Row | null> {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(runnerId) || !/^[A-Z0-9_]{1,64}$/.test(errorCode)) return null;
    const rows = await this.database.rows(`
      UPDATE public.network_discovery_sessions SET
        status='failed', phase='scan', completed_at=$2::timestamptz, updated_at=$2::timestamptz,
        error_code=$3
      WHERE runner_id=$1 AND status IN ('queued','running') RETURNING *
    `, [runnerId, now, errorCode], signal);
    return rows[0] ?? null;
  }

  async expireStale(signal: AbortSignal): Promise<void> {
    await this.database.rows(`
      UPDATE public.network_discovery_sessions SET
        status='expired', phase='scan', completed_at=now(), updated_at=now(),
        error_code='SESSION_ORPHANED'
      WHERE status IN ('queued','running') AND expires_at < now()
    `, [], signal);
  }
}
