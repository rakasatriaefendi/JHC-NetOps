import type { PostgresTransactionalQuery } from "./postgres-query.js";

type Row = Record<string, unknown>;

export interface NetworkDiscoveryRepository {
  get(runnerId: string, signal: AbortSignal): Promise<Row | null>;
  create(actorId: string, input: DiscoveryCreateInput, signal: AbortSignal): Promise<Row>;
  update(runnerId: string, patch: DiscoveryUpdateInput, signal: AbortSignal): Promise<Row | null>;
  complete(runnerId: string, now: string, results: Row, signal: AbortSignal): Promise<Row | null>;
  fail(runnerId: string, now: string, errorCode: string, signal: AbortSignal): Promise<Row | null>;
  expireStale(signal: AbortSignal): Promise<void>;
}

export type DiscoveryCreateInput = Readonly<{
  runnerId: string;
  requestedBy: string;
  connectionType?: "wifi" | "ethernet" | "unknown";
  interfaceAlias?: string;
  localIpv4?: string;
  subnetCidr?: string;
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
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!UUID.test(actorId)) throw new Error("Invalid actor");
    const rows = await this.database.rows(`
      INSERT INTO public.network_discovery_sessions
        (runner_id,requested_by,connection_type,interface_alias,local_ipv4,subnet_cidr,status,phase)
      VALUES ($1,$2,$3,$4,$5::inet,$6::cidr,'queued','prepare')
      ON CONFLICT (runner_id) DO UPDATE SET
        requested_by=EXCLUDED.requested_by,
        connection_type=EXCLUDED.connection_type,
        interface_alias=EXCLUDED.interface_alias,
        local_ipv4=EXCLUDED.local_ipv4,
        subnet_cidr=EXCLUDED.subnet_cidr,
        status='queued',phase='prepare',
        expires_at=now() + interval '10 minutes', updated_at=now()
      RETURNING *
    `, [input.runnerId, actorId, input.connectionType ?? null,
      input.interfaceAlias ?? null, input.localIpv4 ?? null, input.subnetCidr ?? null], signal);
    if (!rows[0]) throw new Error("Discovery session create failed");
    return rows[0];
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