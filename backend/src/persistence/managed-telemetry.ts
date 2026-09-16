import type { ManagedDevice, ManagedInterface, ManagedTransition } from "../managed-telemetry/contract.js";
import {
  managedEvent,
  ManagedTelemetryRepositoryError,
  nullableText,
  type ManagedTelemetryRepository,
} from "../managed-telemetry/repository.js";
import {
  prepareObservedHostRows,
  type ExistingObservedHost,
  type InventoryNode,
  type ObservedHostInput,
} from "../managed-telemetry/observed-hosts.js";
import type { PostgresQuery, PostgresTransactionalQuery } from "./postgres-query.js";

const RECOVERY_KINDS = new Set(["interface_up", "utilization_recovered"]);

export class PostgresManagedTelemetryRepository implements ManagedTelemetryRepository {
  constructor(private readonly database: PostgresTransactionalQuery) {}

  async listTargets(runnerId: string, signal: AbortSignal): Promise<{ targets: Record<string, unknown>[] }> {
    const rows = await this.database.rows(`
      SELECT t.id,t.node_id,t.runner_id,t.enabled,t.credential_profile_ref,t.snmp_version,
        t.snmp_port,t.poll_interval_seconds,t.oper_error_threshold,t.discard_threshold,
        t.util_warning_percent,t.util_critical_percent,t.util_sustained_seconds,
        t.updated_at AS config_updated_at,host(n.ip_address) AS ip_address,n.name,n.device_type,n.location,
        CASE WHEN d.target_id IS NULL THEN NULL ELSE jsonb_build_object(
          'status',d.status,'last_polled_at',d.last_polled_at) END AS latest
      FROM public.managed_telemetry_targets t
      JOIN public.network_nodes n ON n.id=t.node_id
      LEFT JOIN public.managed_device_latest d ON d.target_id=t.id
      WHERE t.runner_id=$1 AND t.enabled=true ORDER BY t.created_at ASC
    `, [runnerId], signal);
    return { targets: rows.map((row) => ({ ...row,
      util_warning_percent: Number(row.util_warning_percent),
      util_critical_percent: Number(row.util_critical_percent),
      config_updated_at: iso(row.config_updated_at), latest: row.latest ?? null,
    })) };
  }

  async publish(
    runnerId: string,
    device: ManagedDevice,
    interfaces: ManagedInterface[],
    transitions: ManagedTransition[],
    observedHosts: ObservedHostInput[],
    now: string,
    signal: AbortSignal,
  ): Promise<Record<string, number>> {
    return this.database.transaction(signal, async (query) => {
      const targetId = device.target_id;
      const allowed = await query.rows(`
        SELECT id FROM public.managed_telemetry_targets
        WHERE id=$2::uuid AND runner_id=$1 AND enabled=true FOR UPDATE
      `, [runnerId, targetId], signal);
      if (!allowed.length) throw new ManagedTelemetryRepositoryError("TARGET_NOT_AUTHORIZED");

      await query.rows(`
        INSERT INTO public.managed_device_latest
          (target_id,status,sys_name,sys_descr,sys_object_id,uptime_seconds,manufacturer,model,
           serial_number,last_polled_at,last_success_at,consecutive_poll_failures,error_category,
           updated_at,observed_hosts_status)
        VALUES ($1::uuid,$2,$3,$4,$5,$6::bigint,$7,$8,$9,$10::timestamptz,$11::timestamptz,
          $12,$13,$14::timestamptz,$15)
        ON CONFLICT (target_id) DO UPDATE SET
          status=EXCLUDED.status,sys_name=EXCLUDED.sys_name,sys_descr=EXCLUDED.sys_descr,
          sys_object_id=EXCLUDED.sys_object_id,uptime_seconds=EXCLUDED.uptime_seconds,
          manufacturer=EXCLUDED.manufacturer,model=EXCLUDED.model,serial_number=EXCLUDED.serial_number,
          last_polled_at=EXCLUDED.last_polled_at,last_success_at=EXCLUDED.last_success_at,
          consecutive_poll_failures=EXCLUDED.consecutive_poll_failures,
          error_category=EXCLUDED.error_category,updated_at=EXCLUDED.updated_at,
          observed_hosts_status=EXCLUDED.observed_hosts_status
      `, [targetId, device.status, nullableText(device.sys_name), nullableText(device.sys_descr),
        nullableText(device.sys_object_id), device.uptime_seconds ?? null, nullableText(device.manufacturer),
        nullableText(device.model), nullableText(device.serial_number), device.last_polled_at ?? now,
        device.last_success_at ?? null, device.consecutive_poll_failures ?? 0,
        device.error_category ?? null, now, device.observed_hosts_status ?? "unsupported"], signal);

      const interfaceRows = interfaces.map((row) => ({
        target_id: targetId, if_index: row.if_index, name: nullableText(row.name),
        description: nullableText(row.description), if_type: row.if_type ?? null,
        is_physical: row.is_physical === true, admin_status: row.admin_status ?? null,
        oper_status: row.oper_status ?? null, speed_bps: row.speed_bps ?? null,
        rx_rate_bps: row.rx_rate_bps ?? null, tx_rate_bps: row.tx_rate_bps ?? null,
        rx_util_percent: row.rx_util_percent ?? null, tx_util_percent: row.tx_util_percent ?? null,
        rx_errors_cumulative: row.rx_errors_cumulative ?? null,
        tx_errors_cumulative: row.tx_errors_cumulative ?? null,
        in_discards_cumulative: row.in_discards_cumulative ?? null,
        out_discards_cumulative: row.out_discards_cumulative ?? null,
        rx_errors_delta: row.rx_errors_delta ?? null, tx_errors_delta: row.tx_errors_delta ?? null,
        in_discards_delta: row.in_discards_delta ?? null,
        out_discards_delta: row.out_discards_delta ?? null,
        last_polled_at: row.last_polled_at ?? now, updated_at: now,
      }));
      if (interfaceRows.length) await query.rows(`
        INSERT INTO public.managed_interface_latest
          (target_id,if_index,name,description,if_type,is_physical,admin_status,oper_status,
           speed_bps,rx_rate_bps,tx_rate_bps,rx_util_percent,tx_util_percent,
           rx_errors_cumulative,tx_errors_cumulative,in_discards_cumulative,out_discards_cumulative,
           rx_errors_delta,tx_errors_delta,in_discards_delta,out_discards_delta,last_polled_at,updated_at)
        SELECT target_id,if_index,name,description,if_type,is_physical,admin_status,oper_status,
          speed_bps,rx_rate_bps,tx_rate_bps,rx_util_percent,tx_util_percent,
          rx_errors_cumulative,tx_errors_cumulative,in_discards_cumulative,out_discards_cumulative,
          rx_errors_delta,tx_errors_delta,in_discards_delta,out_discards_delta,last_polled_at,updated_at
        FROM jsonb_to_recordset($1::jsonb) AS x(
          target_id uuid,if_index integer,name text,description text,if_type integer,is_physical boolean,
          admin_status text,oper_status text,speed_bps bigint,rx_rate_bps numeric,tx_rate_bps numeric,
          rx_util_percent numeric,tx_util_percent numeric,rx_errors_cumulative bigint,
          tx_errors_cumulative bigint,in_discards_cumulative bigint,out_discards_cumulative bigint,
          rx_errors_delta integer,tx_errors_delta integer,in_discards_delta integer,out_discards_delta integer,
          last_polled_at timestamptz,updated_at timestamptz)
        ON CONFLICT (target_id,if_index) DO UPDATE SET
          name=EXCLUDED.name,description=EXCLUDED.description,if_type=EXCLUDED.if_type,
          is_physical=EXCLUDED.is_physical,admin_status=EXCLUDED.admin_status,
          oper_status=EXCLUDED.oper_status,speed_bps=EXCLUDED.speed_bps,
          rx_rate_bps=EXCLUDED.rx_rate_bps,tx_rate_bps=EXCLUDED.tx_rate_bps,
          rx_util_percent=EXCLUDED.rx_util_percent,tx_util_percent=EXCLUDED.tx_util_percent,
          rx_errors_cumulative=EXCLUDED.rx_errors_cumulative,
          tx_errors_cumulative=EXCLUDED.tx_errors_cumulative,
          in_discards_cumulative=EXCLUDED.in_discards_cumulative,
          out_discards_cumulative=EXCLUDED.out_discards_cumulative,
          rx_errors_delta=EXCLUDED.rx_errors_delta,tx_errors_delta=EXCLUDED.tx_errors_delta,
          in_discards_delta=EXCLUDED.in_discards_delta,out_discards_delta=EXCLUDED.out_discards_delta,
          last_polled_at=EXCLUDED.last_polled_at,updated_at=EXCLUDED.updated_at
      `, [JSON.stringify(interfaceRows)], signal);
      await query.rows(`
        DELETE FROM public.managed_interface_latest
        WHERE target_id=$1::uuid AND if_index <> ALL($2::integer[])
      `, [targetId, interfaceRows.map((row) => row.if_index)], signal);

      const observedIps = observedHosts.map((host) => host.ip_address);
      const existing = await query.rows(`
        SELECT host(ip_address) AS ip_address,first_seen_at,netbios_name,enrichment_status
        FROM public.managed_observed_hosts_latest WHERE target_id=$1::uuid
      `, [targetId], signal);
      const inventory = observedIps.length ? await query.rows(`
        SELECT id,host(ip_address) AS ip_address FROM public.network_nodes
        WHERE host(ip_address) = ANY($1::text[])
      `, [observedIps], signal) : [];
      const observedRows = prepareObservedHostRows(observedHosts, targetId, now,
        existing.map((row) => ({ ...row, first_seen_at: iso(row.first_seen_at) })) as ExistingObservedHost[],
        inventory as InventoryNode[]);
      if (observedRows.stale.length) await query.rows(`
        UPDATE public.managed_observed_hosts_latest SET status='stale',updated_at=$3::timestamptz
        WHERE target_id=$1::uuid AND NOT (host(ip_address) = ANY($2::text[]))
      `, [targetId, observedRows.current.map((row) => row.ip_address), now], signal);
      if (observedRows.current.length) await query.rows(`
        INSERT INTO public.managed_observed_hosts_latest
          (target_id,node_id,ip_address,mac_address,netbios_name,observation_source,
           enrichment_status,first_seen_at,last_seen_at,status,updated_at)
        SELECT target_id,node_id,ip_address,mac_address,netbios_name,observation_source,
          enrichment_status,first_seen_at,last_seen_at,status,updated_at
        FROM jsonb_to_recordset($1::jsonb) AS x(
          target_id uuid,node_id uuid,ip_address inet,mac_address macaddr,netbios_name text,
          observation_source text,enrichment_status text,first_seen_at timestamptz,
          last_seen_at timestamptz,status text,updated_at timestamptz)
        ON CONFLICT (target_id,ip_address) DO UPDATE SET
          node_id=EXCLUDED.node_id,mac_address=EXCLUDED.mac_address,
          netbios_name=EXCLUDED.netbios_name,observation_source=EXCLUDED.observation_source,
          enrichment_status=EXCLUDED.enrichment_status,
          first_seen_at=public.managed_observed_hosts_latest.first_seen_at,
          last_seen_at=EXCLUDED.last_seen_at,status=EXCLUDED.status,updated_at=EXCLUDED.updated_at
      `, [JSON.stringify(observedRows.current)], signal);

      const inserted = await persistManagedEvents(query, targetId, transitions, signal);
      return { devices: 1, interfaces: interfaceRows.length, observed_hosts: observedRows.current.length, events: inserted };
    });
  }
}

async function persistManagedEvents(query: PostgresQuery, targetId: string, transitions: ManagedTransition[], signal: AbortSignal): Promise<number> {
  let inserted = 0;
  for (const transition of transitions) {
    const existing = await query.rows("SELECT id FROM public.events WHERE id=$1::uuid", [transition.event_id], signal);
    if (existing.length) continue;
    if (RECOVERY_KINDS.has(transition.kind)) {
      const openKind = transition.kind === "interface_up" ? "interface_down" : "utilization_high";
      const context = isRecord(transition.raw_context) ? transition.raw_context : {};
      await query.rows(`
        UPDATE public.events SET resolved_at=$3::timestamptz
        WHERE source='managed_telemetry' AND source_ref=$1 AND resolved_at IS NULL
          AND raw_context->>'kind'=$2
          AND ($4::integer IS NULL OR raw_context->>'if_index'=$4::text)
      `, [targetId, openKind, transition.occurred_at,
        Number.isSafeInteger(context.if_index) ? context.if_index : null], signal);
    }
    const event = managedEvent(transition, targetId);
    const created = await query.rows(`
      INSERT INTO public.events
        (id,created_at,severity,title,description,source,source_ref,resolved_at,raw_context)
      VALUES ($1::uuid,$2::timestamptz,$3,$4,$5,$6,$7,$8::timestamptz,$9::jsonb)
      ON CONFLICT (id) DO NOTHING RETURNING id
    `, [event.id,event.created_at,event.severity,event.title,event.description,
      event.source,event.source_ref,event.resolved_at,JSON.stringify(event.raw_context)], signal);
    inserted += created.length;
  }
  return inserted;
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
