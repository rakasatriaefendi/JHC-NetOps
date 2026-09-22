import type { PostgresTransactionalQuery } from "./postgres-query.js";
import { ControlPlanePersistenceError, RUNNER_ID, UUID, requireFreshRunner, requireOperator } from "./control-plane.js";
import type { DiscoveryContext, DiscoveryHost } from "../network-discovery/contract.js";

type Row = Record<string, unknown>;

export interface NetworkDiscoveryRepository {
  get(runnerId: string, signal: AbortSignal): Promise<Row | null>;
  create(actorId: string, input: DiscoveryCreateInput, signal: AbortSignal): Promise<Row>;
  start(actorId: string, runnerId: string, sessionId: string, signal: AbortSignal): Promise<Row>;
  claim(runnerId: string, now: string, signal: AbortSignal): Promise<Row | null>;
  contextReady(runnerId: string, sessionId: string, context: DiscoveryContext, now: string, signal: AbortSignal): Promise<Row | null>;
  progress(runnerId: string, sessionId: string, context: DiscoveryContext, scannedHosts: number, results: readonly DiscoveryHost[], now: string, signal: AbortSignal): Promise<Row | null>;
  complete(runnerId: string, sessionId: string, scannedHosts: number, now: string, signal: AbortSignal): Promise<Row | null>;
  fail(runnerId: string, sessionId: string, errorCode: string, now: string, signal: AbortSignal): Promise<Row | null>;
  expireStale(signal: AbortSignal): Promise<void>;
}

export type DiscoveryCreateInput = Readonly<{
  runnerId: string;
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

  async claim(runnerId: string, now: string, signal: AbortSignal): Promise<Row | null> {
    if (!RUNNER_ID.test(runnerId)) return null;
    await this.expireStale(signal);
    const rows = await this.database.rows(`
      UPDATE public.network_discovery_sessions AS session SET
        status='running',started_at=$2::timestamptz,updated_at=$2::timestamptz
      WHERE session.runner_id=$1 AND session.status='queued'
        AND session.session_id=(
          SELECT queued.session_id FROM public.network_discovery_sessions AS queued
          WHERE queued.runner_id=$1 AND queued.status='queued'
          FOR UPDATE SKIP LOCKED LIMIT 1
        )
      RETURNING session.*
    `, [runnerId, now], signal);
    return rows[0] ?? null;
  }

  async contextReady(runnerId: string, sessionId: string, context: DiscoveryContext, now: string, signal: AbortSignal): Promise<Row | null> {
    if (!RUNNER_ID.test(runnerId) || !UUID.test(sessionId)) return null;
    const rows = await this.database.rows(`
      UPDATE public.network_discovery_sessions SET
        connection_type=$3,interface_alias=$4,local_ipv4=$5,subnet_cidr=$6,total_hosts=$7,
        status='idle',completed_at=$8::timestamptz,expires_at=$8::timestamptz + interval '10 minutes',updated_at=$8::timestamptz
      WHERE runner_id=$1 AND session_id=$2::uuid AND status='running' AND phase='prepare'
      RETURNING *
    `, [runnerId, sessionId, context.connection_type, context.interface_alias, context.local_ipv4,
      context.subnet_cidr, context.total_hosts, now], signal);
    return rows[0] ?? null;
  }

  async progress(runnerId: string, sessionId: string, context: DiscoveryContext, scannedHosts: number,
    results: readonly DiscoveryHost[], now: string, signal: AbortSignal): Promise<Row | null> {
    if (!RUNNER_ID.test(runnerId) || !UUID.test(sessionId)) return null;
    const rows = await this.database.rows(`
      UPDATE public.network_discovery_sessions SET
        connection_type=$3,interface_alias=$4,local_ipv4=$5,subnet_cidr=$6,total_hosts=$7,
        scanned_hosts=$8,found_count=$9,results=$10::jsonb,
        expires_at=$11::timestamptz + interval '10 minutes',updated_at=$11::timestamptz
      WHERE runner_id=$1 AND session_id=$2::uuid AND status='running' AND phase='scan'
      RETURNING *
    `, [runnerId, sessionId, context.connection_type, context.interface_alias, context.local_ipv4,
      context.subnet_cidr, context.total_hosts, scannedHosts, results.length, JSON.stringify(results), now], signal);
    return rows[0] ?? null;
  }

  async complete(runnerId: string, sessionId: string, scannedHosts: number, now: string, signal: AbortSignal): Promise<Row | null> {
    if (!RUNNER_ID.test(runnerId) || !UUID.test(sessionId)) return null;
    const rows = await this.database.rows(`
      UPDATE public.network_discovery_sessions SET
        status='completed',scanned_hosts=$3,completed_at=$4::timestamptz,
        expires_at=$4::timestamptz + interval '10 minutes',updated_at=$4::timestamptz
      WHERE runner_id=$1 AND session_id=$2::uuid AND status='running' AND phase='scan'
      RETURNING *
    `, [runnerId, sessionId, scannedHosts, now], signal);
    return rows[0] ?? null;
  }

  async fail(runnerId: string, sessionId: string, errorCode: string, now: string, signal: AbortSignal): Promise<Row | null> {
    if (!RUNNER_ID.test(runnerId) || !UUID.test(sessionId) || !/^[A-Z0-9_]{1,64}$/.test(errorCode)) return null;
    const rows = await this.database.rows(`
      UPDATE public.network_discovery_sessions SET
        status='failed',error_code=$3,completed_at=$4::timestamptz,
        expires_at=$4::timestamptz + interval '10 minutes',updated_at=$4::timestamptz
      WHERE runner_id=$1 AND session_id=$2::uuid AND status='running'
      RETURNING *
    `, [runnerId, sessionId, errorCode, now], signal);
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
