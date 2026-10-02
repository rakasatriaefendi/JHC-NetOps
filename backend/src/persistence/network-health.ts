import type { HealthState, HealthTransition } from "../network-health/contract.js";
import {
  coalescedSamples,
  healthEvent,
  NetworkHealthRepositoryError,
  type NetworkHealthRepository,
} from "../network-health/repository.js";
import type { PostgresQuery } from "./postgres-query.js";

type Row = Record<string, unknown>;

export class PostgresNetworkHealthRepository implements NetworkHealthRepository {
  constructor(private readonly database: PostgresQuery) {}

  async listTargets(runnerId: string, signal: AbortSignal): Promise<{ targets: Row[] }> {
    const rows = await this.database.rows(`
      SELECT t.id, t.node_id, t.runner_id, t.critical, t.probe_method,
        t.probe_interval_seconds, t.timeout_ms, t.failure_threshold,
        t.recovery_threshold, t.latency_warning_ms, t.loss_warning_percent,
        t.updated_at AS config_updated_at, host(n.ip_address) AS ip_address,
        n.name, n.device_type, n.location,
        CASE WHEN l.target_id IS NULL THEN NULL ELSE jsonb_build_object(
          'status', l.status, 'latency_ms', l.latency_ms,
          'packet_loss_percent', l.packet_loss_percent,
          'last_checked_at', l.last_checked_at, 'last_success_at', l.last_success_at,
          'consecutive_failures', l.consecutive_failures, 'sample_count', l.sample_count
        ) END AS latest
      FROM public.network_targets t
      JOIN public.network_nodes n ON n.id = t.node_id
      LEFT JOIN public.network_health_latest l ON l.target_id = t.id
      WHERE t.runner_id = $1 AND t.enabled = true
      ORDER BY t.created_at ASC
    `, [runnerId], signal);
    return { targets: rows.map((row) => ({ ...row, config_updated_at: timestamp(row.config_updated_at),
      latest: normalizeLatest(row.latest) })) };
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
    const allowed = await this.database.rows(`
      SELECT t.id, t.critical, n.name, host(n.ip_address) AS ip_address
      FROM public.network_targets t
      JOIN public.network_nodes n ON n.id = t.node_id
      WHERE t.runner_id = $1 AND t.enabled = true AND t.id = ANY($2::uuid[])
    `, [runnerId, targetIds], signal);
    const targets = new Map(allowed.map((row) => [String(row.id), row]));
    if (targetIds.some((id) => !targets.has(id))) throw new NetworkHealthRepositoryError("TARGET_NOT_AUTHORIZED");

    const latest = states.map((state) => ({ ...state, updated_at: now }));
    if (latest.length) await this.database.rows(`
      INSERT INTO public.network_health_latest
        (target_id,status,latency_ms,packet_loss_percent,last_checked_at,last_success_at,
         consecutive_failures,sample_count,updated_at)
      SELECT target_id,status,latency_ms,packet_loss_percent,last_checked_at,last_success_at,
        consecutive_failures,sample_count,updated_at
      FROM jsonb_to_recordset($1::jsonb) AS x(
        target_id uuid,status text,latency_ms double precision,packet_loss_percent numeric,
        last_checked_at timestamptz,last_success_at timestamptz,
        consecutive_failures integer,sample_count integer,updated_at timestamptz)
      ON CONFLICT (target_id) DO UPDATE SET
        status=EXCLUDED.status,latency_ms=EXCLUDED.latency_ms,
        packet_loss_percent=EXCLUDED.packet_loss_percent,last_checked_at=EXCLUDED.last_checked_at,
        last_success_at=EXCLUDED.last_success_at,consecutive_failures=EXCLUDED.consecutive_failures,
        sample_count=EXCLUDED.sample_count,updated_at=EXCLUDED.updated_at
    `, [JSON.stringify(latest)], signal);

    const samples = coalescedSamples(states);
    if (samples.length) await this.database.rows(`
      INSERT INTO public.network_health_samples
        (target_id,sampled_at,status,latency_ms,packet_loss_percent,sample_count)
      SELECT target_id,sampled_at,status,latency_ms,packet_loss_percent,sample_count
      FROM jsonb_to_recordset($1::jsonb) AS x(
        target_id uuid,sampled_at timestamptz,status text,latency_ms double precision,
        packet_loss_percent numeric,sample_count integer)
      ON CONFLICT (target_id,sampled_at) DO UPDATE SET
        status=EXCLUDED.status,latency_ms=EXCLUDED.latency_ms,
        packet_loss_percent=EXCLUDED.packet_loss_percent,sample_count=EXCLUDED.sample_count
    `, [JSON.stringify(samples)], signal);

    let inserted = 0;
    for (const transition of transitions) {
      const target = targets.get(transition.target_id)!;
      const existing = await this.database.rows("SELECT id FROM public.events WHERE id = $1::uuid", [transition.event_id], signal);
      if (existing.length) continue;
      await this.database.rows(`
        UPDATE public.events SET resolved_at = $1::timestamptz
        WHERE source = 'network_health' AND source_ref = $2 AND resolved_at IS NULL
      `, [transition.occurred_at, transition.target_id], signal);
      const event = healthEvent(transition, target, target.critical === true);
      const created = await this.database.rows(`
        INSERT INTO public.events
          (id,created_at,severity,title,description,source,source_ref,resolved_at,raw_context)
        VALUES ($1::uuid,$2::timestamptz,$3,$4,$5,$6,$7,$8::timestamptz,$9::jsonb)
        ON CONFLICT (id) DO NOTHING RETURNING id
      `, [event.id, event.created_at, event.severity, event.title, event.description,
        event.source, event.source_ref, event.resolved_at, JSON.stringify(event.raw_context)], signal);
      inserted += created.length;
    }
    return { states: latest.length, events: inserted };
  }

  async claimManualPing(runnerId: string, signal: AbortSignal): Promise<Row | null> {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(runnerId)) return null;
    await this.database.rows(`
      UPDATE public.network_health_ping_jobs SET
        status='failed', completed_at=now(), updated_at=now(),
        error_code='MANUAL_PING_TARGET_UNAVAILABLE'
      WHERE status IN ('queued','running') AND expires_at < now()
    `, [], signal);
    const rows = await this.database.rows(`
      UPDATE public.network_health_ping_jobs SET
        status='running', started_at=now(), updated_at=now()
      WHERE id = (
        SELECT id FROM public.network_health_ping_jobs
        WHERE runner_id=$1 AND status='queued' AND expires_at >= now()
        ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
      ) AND status='queued' AND expires_at >= now()
      RETURNING *
    `, [runnerId], signal);
    return rows[0] ?? null;
  }

  async completeManualPing(pingId: string, runnerId: string, now: string, result: Row, signal: AbortSignal): Promise<Row | null> {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const RUNNER = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
    if (!UUID.test(pingId) || !RUNNER.test(runnerId)) return null;
    const rows = await this.database.rows(`
      UPDATE public.network_health_ping_jobs SET
        status='completed', completed_at=$3::timestamptz, updated_at=$3::timestamptz,
        result=$4::jsonb
      WHERE id=$1::uuid AND runner_id=$2 AND status='running' AND expires_at >= $3::timestamptz RETURNING *
    `, [pingId, runnerId, now, JSON.stringify(result)], signal);
    return rows[0] ?? null;
  }

  async failManualPing(pingId: string, runnerId: string, now: string, errorCode: string, signal: AbortSignal): Promise<Row | null> {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const RUNNER = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
    const ALLOWED_CODES = new Set(["MANUAL_PING_FAILED", "MANUAL_PING_TARGET_UNAVAILABLE"]);
    if (!UUID.test(pingId) || !RUNNER.test(runnerId) || !ALLOWED_CODES.has(errorCode)) return null;
    const rows = await this.database.rows(`
      UPDATE public.network_health_ping_jobs SET
        status='failed', completed_at=$3::timestamptz, updated_at=$3::timestamptz,
        error_code=$4
      WHERE id=$1::uuid AND runner_id=$2 AND status='running' RETURNING *
    `, [pingId, runnerId, now, errorCode], signal);
    return rows[0] ?? null;
  }
}

function timestamp(value: unknown): string | unknown {
  return value instanceof Date ? value.toISOString() : value;
}

function normalizeLatest(value: unknown): Row | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const latest = value as Row;
  return { ...latest, packet_loss_percent: Number(latest.packet_loss_percent) };
}
