export type HealthStatus = "online" | "degraded" | "offline";

export type NetworkHealthTarget = {
  id: string;
  runner_id: string;
  enabled: boolean;
  critical: boolean;
  probe_interval_seconds: number;
  timeout_ms: number;
  failure_threshold: number;
  recovery_threshold: number;
  latency_warning_ms: number;
  loss_warning_percent: number;
  node: { id: string; ip_address: string; name: string; device_type: string | null; location: string | null; detected_fingerprint: import("@/lib/device-inspector").DeviceFingerprint | null; last_inspected_at: string | null };
  latest: { status: HealthStatus; latency_ms: number | null; packet_loss_percent: number; last_checked_at: string; last_success_at: string | null; consecutive_failures: number; sample_count: number } | null;
  diagnostic_target_id: string | null;
  manual_ping_available: boolean;
};

export type NetworkHealthEvent = {
  id: string;
  created_at: string;
  severity: "low" | "medium" | "high" | "critical";
  title: string;
  description: string;
  source_ref: string | null;
  resolved_at: string | null;
  raw_context: Record<string, unknown>;
};

export type NetworkHealthSample = {
  target_id: string;
  sampled_at: string;
  status: HealthStatus;
  latency_ms: number | null;
  packet_loss_percent: number;
  sample_count: number;
};

export type HealthTrendRange = "1h" | "6h" | "24h" | "7d";

export const HEALTH_TREND_RANGES: { value: HealthTrendRange; label: string; maxPoints: number }[] = [
  { value: "1h", label: "Last hour", maxPoints: 60 },
  { value: "6h", label: "Last 6 hours", maxPoints: 180 },
  { value: "24h", label: "Last 24 hours", maxPoints: 240 },
  { value: "7d", label: "Last 7 days", maxPoints: 480 },
];

export const HEALTH_TARGET_PAGE_SIZE = 10;

export function healthTargetPagination(total: number, requestedPage: number, pageSize = HEALTH_TARGET_PAGE_SIZE) {
  const boundedTotal = Math.max(0, Math.trunc(total));
  const boundedPageSize = Math.max(1, Math.trunc(pageSize));
  const pageCount = Math.max(1, Math.ceil(boundedTotal / boundedPageSize));
  const candidatePage = Number.isFinite(requestedPage) ? Math.trunc(requestedPage) : 0;
  const page = Math.min(Math.max(0, candidatePage), pageCount - 1);
  const start = page * boundedPageSize;
  const end = Math.min(start + boundedPageSize, boundedTotal);
  return { page, pageCount, start, end };
}

export function relation(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return Array.isArray(value) && value[0] && typeof value[0] === "object" ? value[0] as Record<string, unknown> : null;
}