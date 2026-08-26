import type { SupabaseClient } from "@supabase/supabase-js";

export type ManagedTelemetryStatus =
  | "connected"
  | "partial"
  | "auth_failed"
  | "timeout"
  | "unreachable"
  | "unsupported"
  | "poll_failed"
  | "not_configured";

export const MANAGED_TELEMETRY_STATUS_LABELS: Record<ManagedTelemetryStatus, string> = {
  connected: "Connected",
  partial: "Partial",
  auth_failed: "Auth failed",
  timeout: "Timeout",
  unreachable: "Unreachable",
  unsupported: "Unsupported",
  poll_failed: "Poll failed",
  not_configured: "Not configured",
};

export const MANAGED_TELEMETRY_ERROR_CATEGORIES = ["auth_failure", "timeout", "unreachable", "unsupported", "agent_error"] as const;

export type ManagedDeviceLatest = {
  target_id: string;
  status: ManagedTelemetryStatus;
  sys_name: string | null;
  sys_descr: string | null;
  sys_object_id: string | null;
  uptime_seconds: number | null;
  manufacturer: string | null;
  model: string | null;
  serial_number: string | null;
  last_polled_at: string | null;
  last_success_at: string | null;
  consecutive_poll_failures: number;
  error_category: string | null;
  updated_at: string;
};

export type ManagedInterfaceLatest = {
  target_id: string;
  if_index: number;
  name: string | null;
  description: string | null;
  if_type: number | null;
  is_physical: boolean;
  admin_status: "up" | "down" | "testing" | null;
  oper_status: "up" | "down" | "testing" | "unknown" | null;
  speed_bps: number | null;
  rx_rate_bps: number | null;
  tx_rate_bps: number | null;
  rx_util_percent: number | null;
  tx_util_percent: number | null;
  rx_errors_cumulative: number | null;
  tx_errors_cumulative: number | null;
  in_discards_cumulative: number | null;
  out_discards_cumulative: number | null;
  rx_errors_delta: number | null;
  tx_errors_delta: number | null;
  in_discards_delta: number | null;
  out_discards_delta: number | null;
  last_polled_at: string | null;
  updated_at: string;
};

export type ManagedTelemetryEvent = {
  id: string;
  created_at: string;
  severity: "low" | "medium" | "high" | "critical";
  title: string;
  description: string | null;
  source_ref: string | null;
  resolved_at: string | null;
  raw_context: Record<string, unknown>;
};

export type ManagedTelemetryTarget = {
  id: string;
  node_id: string;
  runner_id: string;
  enabled: boolean;
  credential_profile_ref: string;
  snmp_version: "3" | "2c";
  snmp_port: number;
  poll_interval_seconds: number;
  oper_error_threshold: number;
  discard_threshold: number;
  util_warning_percent: number;
  util_critical_percent: number;
  util_sustained_seconds: number;
  node: {
    id: string;
    ip_address: string;
    name: string;
    device_type: string | null;
    location: string | null;
    detected_fingerprint: import("@/lib/device-inspector").DeviceFingerprint | null;
    last_inspected_at: string | null;
  };
  latest: ManagedDeviceLatest | null;
};

export type ManagedTelemetryThresholds = {
  oper_error_threshold: number;
  discard_threshold: number;
  util_warning_percent: number;
  util_critical_percent: number;
  util_sustained_seconds: number;
};

export type InterfaceSummary = {
  total: number;
  physical: number;
  physical_up: number;
  physical_down: number;
  physical_errors: number;
  physical_discards: number;
  logical: number;
};

export function managedSystemIdentityFields(
  device: ManagedDeviceLatest,
): { label: string; value: string; data: boolean }[] {
  return [
    { label: "sysName", value: device.sys_name ?? "—", data: true },
    { label: "sysDescr", value: device.sys_descr ?? "—", data: false },
    {
      label: "System Object ID",
      value: device.sys_object_id ?? "—",
      data: true,
    },
  ];
}

export function interfaceSummary(interfaces: ManagedInterfaceLatest[]): InterfaceSummary {
  const physical = interfaces.filter((item) => item.is_physical);
  return {
    total: interfaces.length,
    physical: physical.length,
    physical_up: physical.filter((item) => item.oper_status === "up").length,
    physical_down: physical.filter((item) => item.oper_status === "down").length,
    physical_errors: physical.filter((item) => (item.rx_errors_delta ?? 0) > 0 || (item.tx_errors_delta ?? 0) > 0).length,
    physical_discards: physical.filter((item) => (item.in_discards_delta ?? 0) > 0 || (item.out_discards_delta ?? 0) > 0).length,
    logical: interfaces.length - physical.length,
  };
}

export function interfaceWarnings(row: ManagedInterfaceLatest, thresholds: ManagedTelemetryThresholds | null, events: ManagedTelemetryEvent[]): string[] {
  const warnings: string[] = [];
  if (row.admin_status === "up" && row.oper_status === "down") warnings.push("Possible link issue");
  if ((row.rx_errors_delta ?? 0) > 0 || (row.tx_errors_delta ?? 0) > 0) warnings.push("Increasing errors");
  if ((row.in_discards_delta ?? 0) > 0 || (row.out_discards_delta ?? 0) > 0) warnings.push("Increasing discards");
  const critical = Number(thresholds?.util_critical_percent ?? 0);
  const util = Math.max(row.rx_util_percent ?? 0, row.tx_util_percent ?? 0);
  if (critical > 0 && util >= critical) warnings.push("High utilization");
  if (events.some((event) => event.raw_context?.kind === "speed_changed" && Number(event.raw_context.if_index) === row.if_index)) warnings.push("Speed changed");
  return warnings;
}

export function formatRate(bps: number | null): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps) || bps < 0) return "—";
  if (bps >= 1_000_000_000) return `${trim(bps / 1_000_000_000)} Gbps`;
  if (bps >= 1_000_000) return `${trim(bps / 1_000_000)} Mbps`;
  if (bps >= 1_000) return `${trim(bps / 1_000)} kbps`;
  return `${trim(bps)} bps`;
}

export function formatUtil(value: number | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${trim(value)}%`;
}

export function formatUptime(seconds: number | null): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short" }).format(parsed);
}

export function ifNameLabel(row: ManagedInterfaceLatest): string {
  return row.name || `ifIndex ${row.if_index}`;
}

export function credentialProfileStatus(profiles: string[] | null | undefined, ref: string | null | undefined): "available" | "unavailable" | "unknown" {
  if (!ref) return "unknown";
  if (!Array.isArray(profiles)) return "unknown";
  return profiles.includes(ref) ? "available" : "unavailable";
}

export function validateManagedTelemetryForm(values: {
  node_id: string;
  runner_id: string;
  credential_profile_ref: string;
  snmp_version: string;
  snmp_port: number;
  poll_interval_seconds: number;
  oper_error_threshold: number;
  discard_threshold: number;
  util_warning_percent: number;
  util_critical_percent: number;
  util_sustained_seconds: number;
}): string | null {
  const validUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const validRef = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
  const validRunner = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
  if (!validUuid.test(values.node_id)) return "Inventory node tidak valid.";
  if (!validRunner.test(values.runner_id)) return "Runner tidak valid.";
  if (!validRef.test(values.credential_profile_ref)) return "Credential profile reference tidak valid.";
  if (values.snmp_version !== "3" && values.snmp_version !== "2c") return "SNMP version tidak valid.";
  if (!Number.isSafeInteger(values.snmp_port) || values.snmp_port < 1 || values.snmp_port > 65535) return "SNMP port tidak valid.";
  if (values.poll_interval_seconds !== 30 && values.poll_interval_seconds !== 60) return "Polling interval tidak valid.";
  if (!integerBetween(values.oper_error_threshold, 1, 100)) return "Error threshold tidak valid.";
  if (!integerBetween(values.discard_threshold, 1, 100)) return "Discard threshold tidak valid.";
  if (!Number.isFinite(values.util_warning_percent) || values.util_warning_percent < 1 || values.util_warning_percent > 100) return "Utilization warning tidak valid.";
  if (!Number.isFinite(values.util_critical_percent) || values.util_critical_percent < 1 || values.util_critical_percent > 100) return "Utilization critical tidak valid.";
  if (!integerBetween(values.util_sustained_seconds, 60, 3600)) return "Utilization sustained tidak valid.";
  if (values.util_critical_percent < values.util_warning_percent) return "Utilization critical harus lebih besar dari warning.";
  return null;
}

function integerBetween(value: number, minimum: number, maximum: number) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function trim(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
}

export async function loadManagedTelemetry(supabase: SupabaseClient) {
  const [{ data: targets, error }, { data: interfaces, error: interfaceError }, { data: events, error: eventError }] = await Promise.all([
    supabase.from("managed_telemetry_targets")
      .select("id,node_id,runner_id,enabled,credential_profile_ref,snmp_version,snmp_port,poll_interval_seconds,oper_error_threshold,discard_threshold,util_warning_percent,util_critical_percent,util_sustained_seconds,network_nodes!inner(id,ip_address,name,device_type,location,detected_fingerprint,last_inspected_at),managed_device_latest(status,sys_name,sys_descr,sys_object_id,uptime_seconds,manufacturer,model,serial_number,last_polled_at,last_success_at,consecutive_poll_failures,error_category,updated_at)").eq("enabled", true),
    supabase.from("managed_interface_latest").select("*"),
    supabase.from("events").select("id,created_at,severity,title,description,source_ref,resolved_at,raw_context").eq("source", "managed_telemetry").order("created_at", { ascending: false }).limit(30),
  ]);
  if (error || interfaceError || eventError) return { data: [], interfaces: [], events: [], error: true };
  const rows = (targets ?? []).map((row): ManagedTelemetryTarget => {
    const node = relation(row.network_nodes);
    const latest = relation(row.managed_device_latest);
    return {
      ...row,
      node: node as ManagedTelemetryTarget["node"],
      latest: latest as ManagedDeviceLatest | null,
    } as ManagedTelemetryTarget;
  });
  return { data: rows, interfaces: (interfaces ?? []) as ManagedInterfaceLatest[], events: (events ?? []) as ManagedTelemetryEvent[], error: false };
}

function relation(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return Array.isArray(value) && value[0] && typeof value[0] === "object" ? value[0] as Record<string, unknown> : null;
}
