import type { HealthTrendRange, NetworkHealthSample } from "./network-health-client.ts";

export const HEALTH_HISTORY_MAX_TARGETS = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const HEALTH_HISTORY_ERRORS = ["INVALID_HEALTH_HISTORY_REQUEST", "HEALTH_HISTORY_TARGET_UNAVAILABLE",
  "HEALTH_HISTORY_RESPONSE_TOO_LARGE", "HEALTH_HISTORY_QUERY_FAILED", "UNAUTHORIZED", "LOCAL_APPLICATION_UNAVAILABLE"] as const;
export type HealthHistorySample = NetworkHealthSample & {
  observation_count: number; latency_observation_count: number;
  latency_min_ms: number | null; latency_max_ms: number | null;
  packet_loss_min_percent: number; packet_loss_max_percent: number;
  first_sample_at: string; last_sample_at: string;
};
export type HealthHistoryMetadata = {
  target_ids: string[]; range: HealthTrendRange; from: string; to: string; bucket_seconds: number;
};
export type HealthHistoryResult = {
  data: HealthHistorySample[]; error: boolean; code: string; metadata: HealthHistoryMetadata | null;
};
export function historyFailure(code: string): HealthHistoryResult {
  return { data: [], error: true, code: HEALTH_HISTORY_ERRORS.some((allowed) => allowed === code)
    ? code : "HEALTH_HISTORY_QUERY_FAILED", metadata: null };
}
export function validHistorySelection(ids: unknown, range: unknown): ids is string[] {
  return Array.isArray(ids) && ids.length <= HEALTH_HISTORY_MAX_TARGETS &&
    ids.every((id) => typeof id === "string" && UUID.test(id)) &&
    new Set(ids.map((id) => id.toLowerCase())).size === ids.length &&
    (range === "1h" || range === "6h" || range === "24h" || range === "7d");
}
export function historyKey(ids: readonly string[], range: HealthTrendRange): string {
  return `${range}:${ids.map((id) => id.toLowerCase()).sort().join(",")}`;
}
export function healthHistoryDefaultTarget(allIds: readonly string[]): string {
  return allIds.length <= HEALTH_HISTORY_MAX_TARGETS ? "__all__" : [...allIds].sort()[0]!;
}
export function healthHistorySelection(allIds: string[], selectedId: string) {
  if (selectedId === "__all__") selectedId = healthHistoryDefaultTarget(allIds);
  const missing = selectedId !== "__all__" && !allIds.includes(selectedId);
  return { missing, ids: selectedId === "__all__" ? allIds : missing ? [] : [selectedId] };
}

/** Validates the narrow response; never substitutes a missing measurement with zero. */
export function parseHealthHistory(value: unknown, ids: string[], range: HealthTrendRange): HealthHistoryResult {
  if (!record(value) || !Array.isArray(value.samples) || !validHistorySelection(value.target_ids, value.range) ||
    value.range !== range || historyKey(value.target_ids, range) !== historyKey(ids, range) ||
    !timestamp(value.from) || !timestamp(value.to) || Date.parse(value.from) >= Date.parse(value.to)) {
    return historyFailure("HEALTH_HISTORY_QUERY_FAILED");
  }
  const bucketSeconds = { "1h": 60, "6h": 120, "24h": 360, "7d": 1260 }[range];
  const maxPoints = { "1h": 61, "6h": 181, "24h": 241, "7d": 481 }[range];
  if (value.bucket_seconds !== bucketSeconds || value.samples.length > ids.length * maxPoints) {
    return historyFailure("HEALTH_HISTORY_RESPONSE_TOO_LARGE");
  }
  const samples: HealthHistorySample[] = [];
  const allowedIds = new Set(ids.map((id) => id.toLowerCase()));
  const keys = new Set<string>();
  for (const row of value.samples) {
    if (!record(row) || typeof row.target_id !== "string" || !allowedIds.has(row.target_id) ||
      !timestamp(row.sampled_at) || !timestamp(row.first_sample_at) || !timestamp(row.last_sample_at) ||
      typeof row.status !== "string" || !["online", "degraded", "offline"].includes(row.status) ||
      !nullableLatency(row.latency_ms) || !nullableLatency(row.latency_min_ms) || !nullableLatency(row.latency_max_ms) ||
      !bounded(row.packet_loss_percent, 100) || !bounded(row.packet_loss_min_percent, 100) || !bounded(row.packet_loss_max_percent, 100) ||
      !integer(row.sample_count, 1, 5) || !integer(row.observation_count, 1, 21) ||
      !integer(row.latency_observation_count, 0, row.observation_count) ||
      Date.parse(row.first_sample_at) < Date.parse(value.from) || Date.parse(row.last_sample_at) >= Date.parse(value.to) ||
      Date.parse(row.first_sample_at) > Date.parse(row.last_sample_at)) return historyFailure("HEALTH_HISTORY_QUERY_FAILED");
    const key = `${row.target_id}:${row.sampled_at}`;
    if (keys.has(key)) return historyFailure("HEALTH_HISTORY_QUERY_FAILED");
    keys.add(key);
    samples.push({ target_id: row.target_id, sampled_at: row.sampled_at, status: row.status as NetworkHealthSample["status"],
      latency_ms: row.latency_ms, packet_loss_percent: row.packet_loss_percent, sample_count: row.sample_count,
      observation_count: row.observation_count, latency_observation_count: row.latency_observation_count,
      latency_min_ms: row.latency_min_ms, latency_max_ms: row.latency_max_ms,
      packet_loss_min_percent: row.packet_loss_min_percent, packet_loss_max_percent: row.packet_loss_max_percent,
      first_sample_at: row.first_sample_at, last_sample_at: row.last_sample_at });
  }
  samples.sort((a, b) => Date.parse(a.sampled_at) - Date.parse(b.sampled_at) || a.target_id.localeCompare(b.target_id));
  return { data: samples, error: false, code: "OK", metadata: {
    target_ids: [...value.target_ids], range, from: value.from, to: value.to, bucket_seconds: bucketSeconds,
  } };
}

export function healthMetricState(samples: readonly NetworkHealthSample[], metric: "latency" | "loss") {
  if (!samples.length) return "empty";
  return samples.some((sample) => metric === "latency" ? sample.latency_ms !== null : Number.isFinite(sample.packet_loss_percent))
    ? "ready" : "metric_unavailable";
}
export function healthChartPoints(samples: readonly NetworkHealthSample[]) {
  const targetIds = [...new Set(samples.map((sample) => sample.target_id))].sort();
  const points = new Map<string, { time: string; [key: string]: string | number | null }>();
  for (const sample of samples) {
    const point = points.get(sample.sampled_at) ?? { time: sample.sampled_at };
    point[`latency_${sample.target_id}`] = sample.latency_ms;
    point[`loss_${sample.target_id}`] = sample.packet_loss_percent;
    points.set(sample.sampled_at, point);
  }
  // Explicit nulls are chart gaps, not fabricated observations.
  for (const point of points.values()) for (const id of targetIds) {
    point[`latency_${id}`] ??= null;
    point[`loss_${id}`] ??= null;
  }
  return [...points.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

type Snapshot = { key: string; loading: boolean; result: HealthHistoryResult };
type Request = { ids: string[]; range: HealthTrendRange; key: string; revision: number };
function historySeed(initial: HealthHistoryResult, allIds: string[]) {
  // Successful responses identify the exact SSR request. Empty/error responses have no metadata.
  const ids = initial.metadata?.target_ids ?? healthHistorySelection(allIds, "__all__").ids;
  const range = initial.metadata?.range ?? "1h";
  return { ids: [...ids], range, key: historyKey(ids, range) };
}
function historyEvidence(result: HealthHistoryResult): string {
  // Sliding query bounds alone are not new observations. Retain every measured field.
  return JSON.stringify([result.error, result.code, result.metadata?.range, result.metadata?.bucket_seconds,
    result.metadata?.target_ids.slice().sort(), result.data]);
}
/** One request at a time; newer selections/invalidation replace queued work, not source data. */
export class HealthHistoryController {
  private snapshot: Snapshot;
  private listeners = new Set<() => void>();
  private active: Request;
  private queued: Request | null = null;
  private running = false;
  private revision = 0;
  private seedEvidence: string;
  private seedKey: string;
  private lastManualRefreshAt = -Infinity;
  private now: () => number;
  private loader: (ids: string[], range: HealthTrendRange) => Promise<HealthHistoryResult>;

  constructor(loader: (ids: string[], range: HealthTrendRange) => Promise<HealthHistoryResult>, ids: string[], initial: HealthHistoryResult,
    now: () => number = Date.now) {
    this.loader = loader;
    this.now = now;
    this.seedEvidence = historyEvidence(initial);
    const seed = historySeed(initial, ids);
    this.seedKey = seed.key;
    this.active = { ...seed, revision: 0 };
    this.snapshot = { key: this.seedKey, loading: false, result: initial };
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  update(ids: string[], range: HealthTrendRange, initial: HealthHistoryResult, allIds: string[]) {
    const key = historyKey(ids, range);
    const seedKey = historySeed(initial, allIds).key;
    const evidence = historyEvidence(initial);
    const unchanged = key === this.active.key && this.seedEvidence === evidence && this.seedKey === seedKey;
    this.seedEvidence = evidence;
    this.seedKey = seedKey;
    if (unchanged) return;
    this.active = { ids: [...ids], range, key, revision: ++this.revision };
    if (!validHistorySelection(ids, range)) {
      this.queued = null;
      this.emit({ key, loading: false, result: historyFailure("INVALID_HEALTH_HISTORY_REQUEST") });
    } else if (key === seedKey) {
      // Parent's existing SSE/fallback refetch already loaded this exact SSR selection/range.
      this.queued = null;
      this.emit({ key, loading: false, result: initial });
    } else if (!ids.length) {
      this.queued = null;
      this.emit({ key, loading: false, result: { data: [], error: false, code: "OK", metadata: null } });
    } else {
      this.queued = this.active;
      this.emit({ key, loading: true, result: this.snapshot.result });
      void this.drain();
    }
  }
  refresh(): boolean {
    const { ids, range, key } = this.active;
    const now = this.now();
    if (this.running || this.snapshot.loading || !ids.length || !validHistorySelection(ids, range) ||
      now - this.lastManualRefreshAt < 10_000) return false;
    this.lastManualRefreshAt = now;
    this.active = { ids: [...ids], range, key, revision: ++this.revision };
    this.queued = this.active;
    this.emit({ key, loading: true, result: this.snapshot.result });
    void this.drain();
    return true;
  }
  cancel() { this.revision++; this.queued = null; }
  private emit(snapshot: Snapshot) { this.snapshot = snapshot; for (const listener of this.listeners) listener(); }
  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queued) {
        const request = this.queued;
        this.queued = null;
        const result = await this.loader(request.ids, request.range).catch(() => historyFailure("LOCAL_APPLICATION_UNAVAILABLE"));
        if (request.revision === this.revision) this.emit({ key: request.key, loading: false, result });
      }
    } finally { this.running = false; }
  }
}

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function timestamp(value: unknown): value is string { return typeof value === "string" && /Z$/.test(value) && Number.isFinite(Date.parse(value)); }
function bounded(value: unknown, max: number): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max; }
function integer(value: unknown, min: number, max: number): value is number { return bounded(value, max) && Number.isInteger(value) && value >= min; }
function nullableLatency(value: unknown): value is number | null { return value === null || bounded(value, 60_000); }
