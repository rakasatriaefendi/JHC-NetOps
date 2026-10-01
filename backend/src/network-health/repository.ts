import type { HealthState, HealthTransition } from "./contract.js";
import { inFilter, SupabaseRestClient, SupabaseRestError } from "../supabase-rest.js";

type Row = Record<string, unknown>;

export interface NetworkHealthRepository {
  listTargets(runnerId: string, signal: AbortSignal): Promise<{ targets: Row[] }>;
  publish(
    runnerId: string,
    states: HealthState[],
    transitions: HealthTransition[],
    now: string,
    signal: AbortSignal,
  ): Promise<{ states: number; events: number }>;
  claimManualPing(runnerId: string, signal: AbortSignal): Promise<Row | null>;
  completeManualPing(pingId: string, runnerId: string, now: string, result: Row, signal: AbortSignal): Promise<Row | null>;
  failManualPing(pingId: string, runnerId: string, now: string, errorCode: string, signal: AbortSignal): Promise<Row | null>;
}

export class SupabaseNetworkHealthRepository implements NetworkHealthRepository {
  readonly #client: SupabaseRestClient;

  constructor(supabaseUrl: string, serviceRoleKey: string) {
    this.#client = new SupabaseRestClient(supabaseUrl, serviceRoleKey, "supabase");
  }

  async listTargets(runnerId: string, signal: AbortSignal): Promise<{ targets: Row[] }> {
    const data = await this.#client.table<Row[]>("network_targets", {
      query: {
        select: "id,node_id,runner_id,enabled,critical,probe_method,probe_interval_seconds,timeout_ms,failure_threshold,recovery_threshold,latency_warning_ms,loss_warning_percent,updated_at,network_nodes!inner(ip_address,name,device_type,location),network_health_latest(status,latency_ms,packet_loss_percent,last_checked_at,last_success_at,consecutive_failures,sample_count)",
        runner_id: `eq.${runnerId}`,
        enabled: "eq.true",
        order: "created_at.asc",
      },
      signal,
    });
    return { targets: data.map((row) => {
      const node = relation(row.network_nodes);
      const latest = relation(row.network_health_latest);
      return {
        id: row.id,
        node_id: row.node_id,
        runner_id: row.runner_id,
        critical: row.critical,
        probe_method: row.probe_method,
        probe_interval_seconds: row.probe_interval_seconds,
        timeout_ms: row.timeout_ms,
        failure_threshold: row.failure_threshold,
        recovery_threshold: row.recovery_threshold,
        latency_warning_ms: row.latency_warning_ms,
        loss_warning_percent: row.loss_warning_percent,
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
    states: HealthState[],
    transitions: HealthTransition[],
    now: string,
    signal: AbortSignal,
  ): Promise<{ states: number; events: number }> {
    const targetIds = [...new Set([...states, ...transitions].map(({ target_id }) => target_id))];
    if (!targetIds.length) return { states: 0, events: 0 };
    const allowed = await this.#client.table<Row[]>("network_targets", {
      query: {
        select: "id,critical,network_nodes!inner(ip_address,name)",
        runner_id: `eq.${runnerId}`,
        enabled: "eq.true",
        id: inFilter(targetIds),
      },
      signal,
    });
    const allowedMap = new Map(allowed.map((row) => [String(row.id), row]));
    if (targetIds.some((id) => !allowedMap.has(id))) throw new NetworkHealthRepositoryError("TARGET_NOT_AUTHORIZED");

    const latestRows = states.map((state) => ({
      target_id: state.target_id,
      status: state.status,
      latency_ms: state.latency_ms,
      packet_loss_percent: state.packet_loss_percent,
      last_checked_at: state.last_checked_at,
      last_success_at: state.last_success_at,
      consecutive_failures: state.consecutive_failures,
      sample_count: state.sample_count,
      updated_at: now,
    }));
    if (latestRows.length) await this.#client.table("network_health_latest", {
      method: "POST",
      query: { on_conflict: "target_id" },
      prefer: "resolution=merge-duplicates,return=minimal",
      body: latestRows,
      signal,
    });

    const sampleRows = coalescedSamples(states);
    if (sampleRows.length) await this.#client.table("network_health_samples", {
      method: "POST",
      query: { on_conflict: "target_id,sampled_at" },
      prefer: "resolution=merge-duplicates,return=minimal",
      body: sampleRows,
      signal,
    });

    const transitionIds = transitions.map(({ event_id }) => event_id);
    const existing = transitionIds.length
      ? await this.#client.table<Row[]>("events", {
        query: { select: "id", id: inFilter(transitionIds) },
        signal,
      })
      : [];
    const seen = new Set(existing.map(({ id }) => String(id)));
    let inserted = 0;
    for (const transition of transitions) {
      if (seen.has(transition.event_id)) continue;
      const target = allowedMap.get(transition.target_id);
      if (!target) throw new NetworkHealthRepositoryError("TARGET_NOT_AUTHORIZED");
      await this.#client.table("events", {
        method: "PATCH",
        query: {
          source: "eq.network_health",
          source_ref: `eq.${transition.target_id}`,
          resolved_at: "is.null",
        },
        prefer: "return=minimal",
        body: { resolved_at: transition.occurred_at },
        signal,
      });
      try {
        await this.#client.table("events", {
          method: "POST",
          prefer: "return=minimal",
          body: healthEvent(transition, relation(target.network_nodes), target.critical === true),
          signal,
        });
        inserted += 1;
      } catch (error) {
        if (!(error instanceof SupabaseRestError) || error.databaseCode !== "23505") throw error;
      }
      if (transition.new_status === "online") seen.add(transition.event_id);
    }
    return { states: latestRows.length, events: inserted };
  }

  async claimManualPing(runnerId: string, signal: AbortSignal): Promise<Row | null> {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(runnerId)) return null;
    const rows = await this.#client.table<Row[]>("network_health_ping_jobs", {
      method: "PATCH",
      query: {
        runner_id: `eq.${runnerId}`,
        status: "eq.queued",
        order: "created_at.asc",
        limit: 1,
      },
      prefer: "return=representation",
      body: { status: "running", started_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      signal,
    });
    return rows[0] ?? null;
  }

  async completeManualPing(pingId: string, runnerId: string, now: string, result: Row, signal: AbortSignal): Promise<Row | null> {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const RUNNER = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
    if (!UUID.test(pingId) || !RUNNER.test(runnerId)) return null;
    const rows = await this.#client.table<Row[]>("network_health_ping_jobs", {
      method: "PATCH",
      query: {
        id: `eq.${pingId}`,
        runner_id: `eq.${runnerId}`,
        status: "in.(queued,running)",
      },
      prefer: "return=representation",
      body: { status: "completed", completed_at: now, updated_at: now, result: JSON.stringify(result) },
      signal,
    });
    return rows[0] ?? null;
  }

  async failManualPing(pingId: string, runnerId: string, now: string, errorCode: string, signal: AbortSignal): Promise<Row | null> {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const RUNNER = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
    const ALLOWED_CODES = new Set(["MANUAL_PING_FAILED", "MANUAL_PING_TARGET_UNAVAILABLE"]);
    if (!UUID.test(pingId) || !RUNNER.test(runnerId) || !ALLOWED_CODES.has(errorCode)) return null;
    const rows = await this.#client.table<Row[]>("network_health_ping_jobs", {
      method: "PATCH",
      query: {
        id: `eq.${pingId}`,
        runner_id: `eq.${runnerId}`,
        status: "in.(queued,running)",
      },
      prefer: "return=representation",
      body: { status: "failed", completed_at: now, updated_at: now, error_code: errorCode },
      signal,
    });
    return rows[0] ?? null;
  }
}

export class NetworkHealthRepositoryError extends Error {
  constructor(readonly code: "TARGET_NOT_AUTHORIZED") {
    super("Network health persistence failed");
    this.name = "NetworkHealthRepositoryError";
  }
}

export function coalescedSamples(states: HealthState[]) {
  const buckets = new Map<string, { checkedAt: number; row: Record<string, unknown> }>();
  for (const state of states) {
    const checkedAt = new Date(state.last_checked_at);
    const sampledAt = new Date(Date.UTC(
      checkedAt.getUTCFullYear(), checkedAt.getUTCMonth(), checkedAt.getUTCDate(),
      checkedAt.getUTCHours(), checkedAt.getUTCMinutes(), 0, 0,
    )).toISOString();
    const key = `${state.target_id}|${sampledAt}`;
    const existing = buckets.get(key);
    if (!existing || existing.checkedAt < checkedAt.getTime()) {
      buckets.set(key, {
        checkedAt: checkedAt.getTime(),
        row: {
          target_id: state.target_id,
          sampled_at: sampledAt,
          status: state.status,
          latency_ms: state.latency_ms,
          packet_loss_percent: state.packet_loss_percent,
          sample_count: state.sample_count,
        },
      });
    }
  }
  return [...buckets.values()].map(({ row }) => row);
}

export function healthEvent(item: HealthTransition, node: Row | null, critical: boolean) {
  const name = typeof node?.name === "string" ? node.name : "Known network target";
  const ipAddress = typeof node?.ip_address === "string" ? node.ip_address : null;
  const status = item.new_status;
  const title = status === "offline" ? `${name} tidak merespons ICMP`
    : status === "degraded" ? `${name} health degraded` : `${name} recovered`;
  const description = status === "offline"
    ? "Target melewati ambang kegagalan ICMP. Ini tidak membuktikan perangkat mati; ICMP dapat diblokir atau jalur dapat bermasalah."
    : status === "degraded"
      ? "Target masih merespons, tetapi latency atau packet-loss short window melewati threshold yang dikonfigurasi."
      : "Target kembali memenuhi recovery threshold dan merespons secara konsisten.";
  return {
    id: item.event_id,
    created_at: item.occurred_at,
    severity: status === "offline" ? (critical ? "critical" : "high") : status === "degraded" ? "medium" : "low",
    title,
    description,
    source: "network_health",
    source_ref: item.target_id,
    resolved_at: status === "online" ? item.occurred_at : null,
    raw_context: {
      source: "network_health",
      target_id: item.target_id,
      ip_address: ipAddress,
      previous_status: item.previous_status,
      new_status: status,
      critical,
      latency_ms: item.latency_ms,
      packet_loss_percent: item.packet_loss_percent,
      consecutive_failures: item.consecutive_failures,
      transition_id: item.event_id,
    },
  };
}

function relation(value: unknown): Row | null {
  if (record(value)) return value;
  return Array.isArray(value) && record(value[0]) ? value[0] : null;
}
function record(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
