import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { OutboxErrorCategory, OutboxEvent, PostgresOutboxRepository } from "./outbox.js";

export type ShadowAllowlistEntry = Readonly<{
  aggregate_type: string;
  supabase_table: string;
  key_columns: readonly string[];
  columns: readonly string[];
}>;

const entry = (aggregate_type: string, key_columns: readonly string[], columns: readonly string[]): ShadowAllowlistEntry =>
  Object.freeze({ aggregate_type, supabase_table: aggregate_type, key_columns, columns });

/** Exact current Auth/RLS/read/Realtime compatibility surface; not all P12 tables. */
export const SHADOW_PROJECTION_ALLOWLIST: readonly ShadowAllowlistEntry[] = Object.freeze([
  entry("diagnostic_runners", ["id"], ["id","display_name","last_seen_at","health_status","health_error_code","capabilities","created_at","updated_at","preflight"]),
  entry("diagnostic_jobs", ["id"], ["id","runner_id","requested_by","status","type","source_label","target_id","target_label","target_host","iperf_port","connection_type","duration_seconds","environment","stage","progress","error_code","error_message","created_at","started_at","completed_at","updated_at","network_context","route_context","preflight_context"]),
  entry("network_discovery_sessions", ["runner_id"], ["runner_id","session_id","requested_by","status","phase","connection_type","interface_alias","local_ipv4","subnet_cidr","total_hosts","scanned_hosts","found_count","results","error_code","created_at","started_at","completed_at","expires_at","updated_at"]),
  entry("device_inspection_sessions", ["runner_id"], ["runner_id","inspection_id","requested_by","target_ip","authorization_source","status","stage","result","error_code","created_at","started_at","completed_at","expires_at","updated_at"]),
  entry("traffic_live_sessions", ["id"], ["id","runner_id","requested_by","status","stage","duration_seconds","capture_scope","created_at","started_at","completed_at","expires_at","updated_at","error_code","error_message"]),
  entry("traffic_live_snapshots", ["runner_id"], ["runner_id","session_id","captured_at","summary","flows","conversations","top_talkers","payload_bytes","updated_at"]),
  entry("network_targets", ["id"], ["id","node_id","runner_id","enabled","critical","probe_method","probe_interval_seconds","timeout_ms","failure_threshold","recovery_threshold","latency_warning_ms","loss_warning_percent","created_by","created_at","updated_at"]),
  entry("network_health_latest", ["target_id"], ["target_id","status","latency_ms","packet_loss_percent","last_checked_at","last_success_at","consecutive_failures","sample_count","updated_at"]),
  entry("network_health_ping_jobs", ["id"], ["id","target_id","runner_id","requested_by","status","result","error_code","created_at","started_at","completed_at","expires_at","updated_at"]),
  entry("events", ["id"], ["id","created_at","severity","title","description","raw_context","ai_summary","resolved_at","source","source_ref"]),
  entry("managed_device_latest", ["target_id"], ["target_id","status","sys_name","sys_descr","sys_object_id","uptime_seconds","manufacturer","model","serial_number","last_polled_at","last_success_at","consecutive_poll_failures","error_category","updated_at","observed_hosts_status"]),
  entry("managed_interface_latest", ["target_id","if_index"], ["target_id","if_index","name","description","if_type","is_physical","admin_status","oper_status","speed_bps","rx_rate_bps","tx_rate_bps","rx_util_percent","tx_util_percent","rx_errors_cumulative","tx_errors_cumulative","in_discards_cumulative","out_discards_cumulative","rx_errors_delta","tx_errors_delta","in_discards_delta","out_discards_delta","last_polled_at","updated_at"]),
  entry("managed_observed_hosts_latest", ["target_id","ip_address"], ["target_id","node_id","ip_address","mac_address","netbios_name","observation_source","enrichment_status","first_seen_at","last_seen_at","status","updated_at"]),
  // Retained for Supabase Auth/RLS and parent/legacy-read compatibility.
  entry("profiles", ["id"], ["id","email","full_name","role","status","created_at","approved_at","approved_by"]),
  entry("network_nodes", ["id"], ["id","ip_address","name","device_type","location","notes","created_by","created_at","updated_at","detected_fingerprint","last_inspected_at"]),
  entry("managed_telemetry_targets", ["id"], ["id","node_id","runner_id","enabled","credential_profile_ref","snmp_version","snmp_port","poll_interval_seconds","oper_error_threshold","discard_threshold","util_warning_percent","util_critical_percent","util_sustained_seconds","created_by","created_at","updated_at"]),
]);

export type ProjectionPlan =
  | Readonly<{ kind: "upsert"; table: string; payload: Record<string, unknown>; onConflict: string }>
  | Readonly<{ kind: "delete"; table: string; match: Record<string, unknown> }>;

export function validateOutboxEvent(event: Pick<OutboxEvent, "aggregate_type" | "operation">): ShadowAllowlistEntry | null {
  if (!["INSERT","UPDATE","DELETE"].includes(event.operation)) return null;
  return SHADOW_PROJECTION_ALLOWLIST.find((item) => item.aggregate_type === event.aggregate_type) ?? null;
}

export function buildProjectionPlan(event: OutboxEvent, approved: ShadowAllowlistEntry): ProjectionPlan {
  const suppliedKeys = Object.keys(event.aggregate_key).sort();
  const approvedKeys = [...approved.key_columns].sort();
  if (suppliedKeys.length !== approvedKeys.length || suppliedKeys.some((key, index) => key !== approvedKeys[index]) ||
      approved.key_columns.some((key) => event.aggregate_key[key] === null || event.aggregate_key[key] === undefined)) {
    throw new Error("Projection aggregate key is invalid");
  }
  const match = Object.fromEntries(approved.key_columns.map((key) => [key, event.aggregate_key[key]]));
  if (event.operation === "DELETE") return { kind: "delete", table: approved.supabase_table, match };
  const payload: Record<string, unknown> = {};
  for (const column of approved.columns) {
    if (column in event.payload) payload[column] = event.payload[column];
    else if (column in match) payload[column] = match[column];
  }
  for (const key of approved.key_columns) if (!(key in payload)) throw new Error("Projection key payload is missing");
  return { kind: "upsert", table: approved.supabase_table, payload, onConflict: approved.key_columns.join(",") };
}

export type ProjectionExecutorResult = Readonly<{
  error: boolean;
  errorCategory?: OutboxErrorCategory;
  backendCode?: string | null;
}>;

export type ProjectionExecutor = (plan: ProjectionPlan) => Promise<ProjectionExecutorResult>;

export type ShadowProjectorRuntimeHealth = Readonly<{
  status: "healthy" | "degraded";
  consecutive_batch_failures: number;
  persistent_batch_failure: boolean;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_failure_code: string | null;
}>;

export interface OutboxProjectionStore {
  fetchPending(limit: number, signal: AbortSignal): Promise<OutboxEvent[]>;
  markDelivered(event: Pick<OutboxEvent, "id" | "aggregate_type" | "aggregate_key">, signal: AbortSignal): Promise<void>;
  markFailed(id: number, errorCategory: OutboxErrorCategory, signal: AbortSignal): Promise<void>;
}

export class SupabaseShadowProjector {
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private stopController: AbortController | null = null;
  private supabase: SupabaseClient | null = null;
  private consecutiveBatchFailures = 0;
  private lastSuccessAt: string | null = null;
  private lastFailureAt: string | null = null;
  private lastFailureCode: string | null = null;

  constructor(
    private readonly outbox: OutboxProjectionStore,
    private readonly supabaseUrl: string,
    private readonly supabaseServiceRoleKey: string,
    private readonly options = { batchSize: 100, maxRetries: 5, retryBaseDelayMs: 1000, maxDelayMs: 30000 },
    private readonly injectedExecutor?: ProjectionExecutor,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopController = new AbortController();
    this.loopPromise = this.runLoop(this.stopController.signal);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopController?.abort();
    await this.loopPromise;
    this.loopPromise = null;
    this.stopController = null;
  }

  getRuntimeHealth(): ShadowProjectorRuntimeHealth {
    return Object.freeze({
      status: this.consecutiveBatchFailures === 0 ? "healthy" : "degraded",
      consecutive_batch_failures: this.consecutiveBatchFailures,
      persistent_batch_failure: this.consecutiveBatchFailures >= 3,
      last_success_at: this.lastSuccessAt,
      last_failure_at: this.lastFailureAt,
      last_failure_code: this.lastFailureCode,
    });
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    while (this.running && !signal.aborted) {
      try {
        await this.processBatch(signal);
        this.consecutiveBatchFailures = 0;
        this.lastSuccessAt = new Date().toISOString();
      } catch (error) {
        if (!signal.aborted) {
          this.consecutiveBatchFailures = Math.min(this.consecutiveBatchFailures + 1, Number.MAX_SAFE_INTEGER);
          this.lastFailureAt = new Date().toISOString();
          const failure = batchFailure(error);
          this.lastFailureCode = failure.reason;
          writeSafeProjectorLog("SHADOW_PROJECTOR_BATCH_FAILED", failure);
        }
      }
      await abortableDelay(5000, signal);
    }
  }

  async processBatch(signal: AbortSignal): Promise<{ delivered: number; failed: number }> {
    let events: OutboxEvent[];
    try {
      events = await this.outbox.fetchPending(this.options.batchSize, signal);
    } catch {
      throw new ProjectorBatchError("OUTBOX_FETCH_FAILED");
    }
    let delivered = 0;
    let failed = 0;
    for (const event of events) {
      if (signal.aborted) break;
      const approved = validateOutboxEvent(event);
      if (!approved) {
        await this.markFailed(event, "projection_not_allowed", signal);
        writeSafeProjectorLog("SHADOW_PROJECTION_EVENT_FAILED", eventFailure(event, "projection_not_allowed", null));
        failed++;
        continue;
      }
      let plan: ProjectionPlan;
      try { plan = buildProjectionPlan(event, approved); }
      catch {
        await this.markFailed(event, "payload_validation", signal);
        writeSafeProjectorLog("SHADOW_PROJECTION_EVENT_FAILED", eventFailure(event, "payload_validation", null));
        failed++;
        continue;
      }
      let projected = false;
      let failureCategory: OutboxErrorCategory = "supabase_unavailable";
      let backendCode: string | null = null;
      for (let attempt = 0; attempt < this.options.maxRetries && !signal.aborted; attempt++) {
        try {
          const result = await this.execute(plan);
          if (!result.error) {
            try { await this.outbox.markDelivered(event, signal); }
            catch { throw new ProjectorBatchError("OUTBOX_DELIVERY_BOOKKEEPING_FAILED", event); }
            delivered++;
            projected = true;
            break;
          }
          failureCategory = result.errorCategory ?? "supabase_unavailable";
          backendCode = safeBackendCode(result.backendCode);
        } catch (error) {
          if (error instanceof ProjectorBatchError) throw error;
          failureCategory = "transient_network";
          backendCode = null;
        }
        if (attempt + 1 < this.options.maxRetries) {
          await abortableDelay(Math.min(this.options.maxDelayMs,
            this.options.retryBaseDelayMs * 2 ** attempt), signal);
        }
      }
      if (!projected && !signal.aborted) {
        await this.markFailed(event, failureCategory, signal);
        writeSafeProjectorLog("SHADOW_PROJECTION_EVENT_FAILED", eventFailure(event, failureCategory, backendCode));
        failed++;
      }
    }
    return { delivered, failed };
  }

  private async execute(plan: ProjectionPlan): Promise<ProjectionExecutorResult> {
    if (this.injectedExecutor) return this.injectedExecutor(plan);
    if (!this.supabase) this.supabase = createClient(this.supabaseUrl, this.supabaseServiceRoleKey,
      { auth: { persistSession: false } });
    const result = plan.kind === "upsert"
      ? await this.supabase.from(plan.table).upsert(plan.payload, {
        onConflict: plan.onConflict,
        defaultToNull: false,
      })
      : await this.supabase.from(plan.table).delete().match(plan.match);
    if (result.error === null) return { error: false };
    const backendCode = safeBackendCode(result.error.code);
    return {
      error: true,
      errorCategory: payloadSupabaseCode(backendCode) ? "payload_validation" : "supabase_unavailable",
      backendCode,
    };
  }

  private async markFailed(event: OutboxEvent, category: OutboxErrorCategory, signal: AbortSignal): Promise<void> {
    try { await this.outbox.markFailed(event.id, category, signal); }
    catch { throw new ProjectorBatchError("OUTBOX_FAILURE_BOOKKEEPING_FAILED", event); }
  }
}

export async function getProjectorHealth(outbox: PostgresOutboxRepository, signal: AbortSignal): Promise<{
  status: "healthy" | "degraded"; failedCount: number; oldestPendingAgeMs: number | null;
}> {
  const health = await outbox.getHealth(signal);
  const degraded = health.failed_count > 0 || health.pending_count > 1000 ||
    (health.oldest_pending_age_ms !== null && health.oldest_pending_age_ms > 300_000);
  return { status: degraded ? "degraded" : "healthy", failedCount: health.failed_count,
    oldestPendingAgeMs: health.oldest_pending_age_ms };
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

class ProjectorBatchError extends Error {
  constructor(
    readonly reason: "OUTBOX_FETCH_FAILED" | "OUTBOX_DELIVERY_BOOKKEEPING_FAILED" | "OUTBOX_FAILURE_BOOKKEEPING_FAILED",
    readonly event?: Pick<OutboxEvent, "id" | "event_id" | "aggregate_type" | "operation">,
  ) {
    super(reason);
    this.name = "ProjectorBatchError";
  }
}

type SafeProjectorFailure = Readonly<{
  reason: string;
  outbox_id?: number;
  event_id?: string;
  aggregate_type?: string;
  operation?: string;
  backend_code?: string;
}>;

function batchFailure(error: unknown): SafeProjectorFailure {
  if (!(error instanceof ProjectorBatchError)) return Object.freeze({ reason: "UNEXPECTED_BATCH_FAILURE" });
  return Object.freeze({
    reason: error.reason,
    ...(error.event ? {
      outbox_id: error.event.id,
      ...(safeUuid(error.event.event_id) ? { event_id: error.event.event_id } : {}),
      aggregate_type: safeIdentifier(error.event.aggregate_type),
      operation: safeOperation(error.event.operation),
    } : {}),
  });
}

function eventFailure(event: OutboxEvent, reason: OutboxErrorCategory, backendCode: string | null): SafeProjectorFailure {
  return Object.freeze({
    reason,
    outbox_id: event.id,
    ...(safeUuid(event.event_id) ? { event_id: event.event_id } : {}),
    aggregate_type: safeIdentifier(event.aggregate_type),
    operation: safeOperation(event.operation),
    ...(backendCode ? { backend_code: backendCode } : {}),
  });
}

function writeSafeProjectorLog(code: "SHADOW_PROJECTOR_BATCH_FAILED" | "SHADOW_PROJECTION_EVENT_FAILED", failure: SafeProjectorFailure): void {
  process.stderr.write(`${JSON.stringify({ level: "error", code, ...failure })}\n`);
}

function safeBackendCode(value: unknown): string | null {
  return typeof value === "string" && /^[A-Z0-9_.-]{1,32}$/i.test(value) ? value : null;
}

function payloadSupabaseCode(value: string | null): boolean {
  return value !== null && (/^(?:22|23|42)/.test(value) || /^PGRST[123]/.test(value));
}

function safeUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function safeIdentifier(value: string): string {
  return /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : "invalid";
}

function safeOperation(value: string): string {
  return ["INSERT", "UPDATE", "DELETE"].includes(value) ? value : "invalid";
}
