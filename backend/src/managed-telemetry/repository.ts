import { SupabaseRestClient, SupabaseRestError, inFilter } from "../supabase-rest.js";
import type { ManagedDevice, ManagedInterface, ManagedTransition } from "./contract.js";
import {
  observedHostNotInFilter,
  prepareObservedHostRows,
  type ExistingObservedHost,
  type InventoryNode,
  type ObservedHostInput,
} from "./observed-hosts.js";

const RECOVERY_KINDS = new Set(["interface_up", "utilization_recovered"]);

export interface ManagedTelemetryRepository {
  listTargets(runnerId: string, signal: AbortSignal): Promise<{ targets: Record<string, unknown>[] }>;
  publish(
    runnerId: string,
    device: ManagedDevice,
    interfaces: ManagedInterface[],
    transitions: ManagedTransition[],
    observedHosts: ObservedHostInput[],
    now: string,
    signal: AbortSignal,
  ): Promise<Record<string, number>>;
}

export class ManagedTelemetryRepositoryError extends Error {
  constructor(readonly code: "TARGET_NOT_AUTHORIZED") {
    super(code);
    this.name = "ManagedTelemetryRepositoryError";
  }
}

export class SupabaseManagedTelemetryRepository implements ManagedTelemetryRepository {
  readonly #client: SupabaseRestClient;

  constructor(supabaseUrl: string, serviceRoleKey: string) {
    this.#client = new SupabaseRestClient(supabaseUrl, serviceRoleKey);
  }

  async listTargets(runnerId: string, signal: AbortSignal): Promise<{ targets: Record<string, unknown>[] }> {
    const rows = await this.#client.table<Record<string, unknown>[]>("managed_telemetry_targets", {
      query: {
        select: "id,node_id,runner_id,enabled,credential_profile_ref,snmp_version,snmp_port,poll_interval_seconds,oper_error_threshold,discard_threshold,util_warning_percent,util_critical_percent,util_sustained_seconds,updated_at,network_nodes!inner(ip_address,name,device_type,location),managed_device_latest(status,last_polled_at)",
        runner_id: `eq.${runnerId}`,
        enabled: "eq.true",
        order: "created_at.asc",
      },
      signal,
    });
    return { targets: rows.map((row) => {
      const node = relation(row.network_nodes);
      const latest = relation(row.managed_device_latest);
      return {
        id: row.id,
        node_id: row.node_id,
        runner_id: row.runner_id,
        enabled: row.enabled,
        credential_profile_ref: row.credential_profile_ref,
        snmp_version: row.snmp_version,
        snmp_port: row.snmp_port,
        poll_interval_seconds: row.poll_interval_seconds,
        oper_error_threshold: row.oper_error_threshold,
        discard_threshold: row.discard_threshold,
        util_warning_percent: Number(row.util_warning_percent),
        util_critical_percent: Number(row.util_critical_percent),
        util_sustained_seconds: row.util_sustained_seconds,
        config_updated_at: row.updated_at,
        ip_address: node?.ip_address,
        name: node?.name,
        device_type: node?.device_type,
        location: node?.location,
        latest: latest ?? null,
      };
    }) };
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
    const targetId = device.target_id;
    const allowed = await this.#client.table<{ id: string }[]>("managed_telemetry_targets", {
      query: { select: "id", runner_id: `eq.${runnerId}`, enabled: "eq.true", id: `eq.${targetId}` },
      signal,
    });
    if (!allowed.length) throw new ManagedTelemetryRepositoryError("TARGET_NOT_AUTHORIZED");

    await this.#client.table("managed_device_latest", {
      method: "POST",
      query: { on_conflict: "target_id" },
      body: {
        target_id: targetId,
        status: device.status,
        sys_name: nullableText(device.sys_name),
        sys_descr: nullableText(device.sys_descr),
        sys_object_id: nullableText(device.sys_object_id),
        uptime_seconds: device.uptime_seconds ?? null,
        manufacturer: nullableText(device.manufacturer),
        model: nullableText(device.model),
        serial_number: nullableText(device.serial_number),
        last_polled_at: device.last_polled_at ?? now,
        last_success_at: device.last_success_at ?? null,
        consecutive_poll_failures: device.consecutive_poll_failures ?? 0,
        error_category: device.error_category ?? null,
        updated_at: now,
        observed_hosts_status: device.observed_hosts_status ?? "unsupported",
      },
      prefer: "resolution=merge-duplicates,return=minimal",
      signal,
    });

    const interfaceRows = interfaces.map((row) => ({
      target_id: targetId,
      if_index: row.if_index,
      name: nullableText(row.name),
      description: nullableText(row.description),
      if_type: row.if_type ?? null,
      is_physical: row.is_physical === true,
      admin_status: row.admin_status ?? null,
      oper_status: row.oper_status ?? null,
      speed_bps: row.speed_bps ?? null,
      rx_rate_bps: row.rx_rate_bps ?? null,
      tx_rate_bps: row.tx_rate_bps ?? null,
      rx_util_percent: row.rx_util_percent ?? null,
      tx_util_percent: row.tx_util_percent ?? null,
      rx_errors_cumulative: row.rx_errors_cumulative ?? null,
      tx_errors_cumulative: row.tx_errors_cumulative ?? null,
      in_discards_cumulative: row.in_discards_cumulative ?? null,
      out_discards_cumulative: row.out_discards_cumulative ?? null,
      rx_errors_delta: row.rx_errors_delta ?? null,
      tx_errors_delta: row.tx_errors_delta ?? null,
      in_discards_delta: row.in_discards_delta ?? null,
      out_discards_delta: row.out_discards_delta ?? null,
      last_polled_at: row.last_polled_at ?? now,
      updated_at: now,
    }));
    if (interfaceRows.length) {
      await this.#client.table("managed_interface_latest", {
        method: "POST",
        query: { on_conflict: "target_id,if_index" },
        body: interfaceRows,
        prefer: "resolution=merge-duplicates,return=minimal",
        signal,
      });
    }
    await this.#client.table("managed_interface_latest", {
      method: "DELETE",
      query: {
        target_id: `eq.${targetId}`,
        ...(interfaceRows.length ? { if_index: `not.${inFilter(interfaceRows.map((row) => row.if_index))}` } : {}),
      },
      prefer: "return=minimal",
      signal,
    });

    const observedIps = observedHosts.map((host) => host.ip_address);
    const [existingHosts, inventory] = await Promise.all([
      this.#client.table<ExistingObservedHost[]>("managed_observed_hosts_latest", {
        query: { select: "ip_address,first_seen_at,netbios_name,enrichment_status", target_id: `eq.${targetId}` },
        signal,
      }),
      observedIps.length
        ? this.#client.table<InventoryNode[]>("network_nodes", {
          query: { select: "id,ip_address", ip_address: inFilter(observedIps) },
          signal,
        })
        : Promise.resolve([]),
    ]);
    const observedRows = prepareObservedHostRows(observedHosts, targetId, now, existingHosts, inventory);
    if (observedRows.stale.length) {
      const currentFilter = observedHostNotInFilter(observedRows.current.map((row) => row.ip_address));
      await this.#client.table("managed_observed_hosts_latest", {
        method: "PATCH",
        query: {
          target_id: `eq.${targetId}`,
          ...(currentFilter ? { ip_address: `not.in.${currentFilter}` } : {}),
        },
        body: { status: "stale", updated_at: now },
        prefer: "return=minimal",
        signal,
      });
    }
    if (observedRows.current.length) {
      await this.#client.table("managed_observed_hosts_latest", {
        method: "POST",
        query: { on_conflict: "target_id,ip_address" },
        body: observedRows.current,
        prefer: "resolution=merge-duplicates,return=minimal",
        signal,
      });
    }

    let inserted = 0;
    const transitionIds = transitions.map((item) => item.event_id);
    const existingEvents = transitionIds.length
      ? await this.#client.table<{ id: string }[]>("events", { query: { select: "id", id: inFilter(transitionIds) }, signal })
      : [];
    const seen = new Set(existingEvents.map((row) => row.id));
    for (const transition of transitions) {
      if (seen.has(transition.event_id)) continue;
      if (RECOVERY_KINDS.has(transition.kind)) await this.#resolveOpenEvents(targetId, transition, signal);
      try {
        await this.#client.table("events", {
          method: "POST",
          body: managedEvent(transition, targetId),
          prefer: "return=minimal",
          signal,
        });
        inserted += 1;
      } catch (error) {
        if (!(error instanceof SupabaseRestError) || error.databaseCode !== "23505") throw error;
      }
    }
    return { devices: 1, interfaces: interfaceRows.length, observed_hosts: observedRows.current.length, events: inserted };
  }

  async #resolveOpenEvents(targetId: string, transition: ManagedTransition, signal: AbortSignal): Promise<void> {
    const openKind = transition.kind === "interface_up" ? "interface_down" : "utilization_high";
    const context = record(transition.raw_context) ? transition.raw_context : {};
    await this.#client.table("events", {
      method: "PATCH",
      query: {
        source: "eq.managed_telemetry",
        source_ref: `eq.${targetId}`,
        resolved_at: "is.null",
        "raw_context->>kind": `eq.${openKind}`,
        ...(Number.isSafeInteger(context.if_index) ? { "raw_context->>if_index": `eq.${String(context.if_index)}` } : {}),
      },
      body: { resolved_at: transition.occurred_at },
      prefer: "return=minimal",
      signal,
    });
  }
}

function managedEvent(item: ManagedTransition, targetId: string) {
  const context = record(item.raw_context) ? item.raw_context : {};
  return {
    id: item.event_id,
    created_at: item.occurred_at,
    severity: item.severity,
    title: item.title,
    description: item.description ?? null,
    source: "managed_telemetry",
    source_ref: targetId,
    resolved_at: null,
    raw_context: { ...context, source: "managed_telemetry", target_id: targetId, event_id: item.event_id, kind: item.kind },
  };
}

function relation(value: unknown): Record<string, unknown> | null {
  if (record(value)) return value;
  return Array.isArray(value) && record(value[0]) ? value[0] : null;
}
function nullableText(value: unknown) { return typeof value === "string" && value.length ? value : null; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
