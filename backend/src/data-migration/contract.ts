export const P12_RUN_ID_PATTERN = /^[a-z0-9][a-z0-9_]{0,47}$/;
export const P12_DATABASE_PATTERN = /^jhc_netops_p12_[a-z0-9][a-z0-9_]{0,47}$/;
export const P12_DATABASE_PREFIX = "jhc_netops_p12_";
export const P12_POSTGRES_PORT = 5433;
export const P12_ALLOWED_HOSTS = Object.freeze(["127.0.0.1", "localhost", "[::1]"]);
export const P12_FORBIDDEN_DATABASES = Object.freeze([
  "jhc_netops",
  "postgres",
  "template0",
  "template1",
]);

export type P12TableDefinition = Readonly<{
  table: string;
  columns: readonly string[];
  orderingKey: readonly string[];
  numericColumns?: readonly string[];
  jsonColumns?: readonly string[];
  sensitiveColumns?: readonly string[];
}>;

export const P12_TABLES = Object.freeze([
  table("profiles", ["id", "email", "full_name", "role", "status", "created_at", "approved_at", "approved_by"], ["id"]),
  table("diagnostic_runners", ["id", "display_name", "last_seen_at", "health_status", "health_error_code", "capabilities", "created_at", "updated_at", "preflight"], ["id"], [], ["capabilities", "preflight"]),
  table("network_nodes", ["id", "ip_address", "name", "device_type", "location", "notes", "created_by", "created_at", "updated_at", "detected_fingerprint", "last_inspected_at"], ["id"], [], ["detected_fingerprint"]),
  table("network_targets", ["id", "node_id", "runner_id", "enabled", "critical", "probe_method", "probe_interval_seconds", "timeout_ms", "failure_threshold", "recovery_threshold", "latency_warning_ms", "loss_warning_percent", "created_by", "created_at", "updated_at"], ["id"], ["probe_interval_seconds", "timeout_ms", "failure_threshold", "recovery_threshold", "latency_warning_ms", "loss_warning_percent"]),
  table("managed_telemetry_targets", ["id", "node_id", "runner_id", "enabled", "credential_profile_ref", "snmp_version", "snmp_port", "poll_interval_seconds", "oper_error_threshold", "discard_threshold", "util_warning_percent", "util_critical_percent", "util_sustained_seconds", "created_by", "created_at", "updated_at", "snmp2c_community_encrypted"], ["id"], ["snmp_port", "poll_interval_seconds", "oper_error_threshold", "discard_threshold", "util_warning_percent", "util_critical_percent", "util_sustained_seconds"], [], ["snmp2c_community_encrypted"]),
  table("diagnostic_jobs", ["id", "runner_id", "requested_by", "status", "type", "source_label", "target_id", "target_label", "target_host", "iperf_port", "connection_type", "duration_seconds", "environment", "stage", "progress", "error_code", "error_message", "created_at", "started_at", "completed_at", "updated_at", "network_context", "route_context", "preflight_context"], ["id"], ["iperf_port", "duration_seconds"], ["progress", "network_context", "route_context", "preflight_context"]),
  table("traffic_live_sessions", ["id", "runner_id", "requested_by", "status", "duration_seconds", "capture_scope", "stage", "error_code", "error_message", "created_at", "started_at", "expires_at", "completed_at", "updated_at"], ["id"], ["duration_seconds"]),
  table("network_discovery_sessions", ["runner_id", "session_id", "requested_by", "status", "phase", "connection_type", "interface_alias", "local_ipv4", "subnet_cidr", "total_hosts", "scanned_hosts", "found_count", "results", "error_code", "created_at", "started_at", "completed_at", "expires_at", "updated_at"], ["runner_id"], ["total_hosts", "scanned_hosts", "found_count"], ["results"]),
  table("device_inspection_sessions", ["runner_id", "inspection_id", "requested_by", "target_ip", "authorization_source", "status", "stage", "result", "error_code", "created_at", "started_at", "completed_at", "expires_at", "updated_at"], ["runner_id"], [], ["result"]),
  table("network_health_latest", ["target_id", "status", "latency_ms", "packet_loss_percent", "last_checked_at", "last_success_at", "consecutive_failures", "sample_count", "updated_at"], ["target_id"], ["latency_ms", "packet_loss_percent", "consecutive_failures", "sample_count"]),
  table("network_health_samples", ["id", "target_id", "sampled_at", "status", "latency_ms", "packet_loss_percent", "sample_count"], ["id"], ["id", "latency_ms", "packet_loss_percent", "sample_count"]),
  table("network_health_ping_jobs", ["id", "target_id", "runner_id", "requested_by", "status", "result", "error_code", "created_at", "started_at", "completed_at", "expires_at", "updated_at"], ["id"], [], ["result"]),
  table("managed_device_latest", ["target_id", "status", "sys_name", "sys_descr", "sys_object_id", "uptime_seconds", "manufacturer", "model", "serial_number", "last_polled_at", "last_success_at", "consecutive_poll_failures", "error_category", "updated_at", "observed_hosts_status"], ["target_id"], ["uptime_seconds", "consecutive_poll_failures"]),
  table("managed_interface_latest", ["target_id", "if_index", "name", "description", "if_type", "is_physical", "admin_status", "oper_status", "speed_bps", "rx_rate_bps", "tx_rate_bps", "rx_util_percent", "tx_util_percent", "rx_errors_cumulative", "tx_errors_cumulative", "in_discards_cumulative", "out_discards_cumulative", "rx_errors_delta", "tx_errors_delta", "in_discards_delta", "out_discards_delta", "last_polled_at", "updated_at"], ["target_id", "if_index"], ["if_index", "if_type", "speed_bps", "rx_rate_bps", "tx_rate_bps", "rx_util_percent", "tx_util_percent", "rx_errors_cumulative", "tx_errors_cumulative", "in_discards_cumulative", "out_discards_cumulative", "rx_errors_delta", "tx_errors_delta", "in_discards_delta", "out_discards_delta"]),
  table("managed_observed_hosts_latest", ["target_id", "node_id", "ip_address", "mac_address", "netbios_name", "observation_source", "enrichment_status", "first_seen_at", "last_seen_at", "status", "updated_at"], ["target_id", "ip_address"]),
  table("traffic_live_snapshots", ["runner_id", "session_id", "captured_at", "summary", "flows", "conversations", "top_talkers", "payload_bytes", "updated_at"], ["runner_id"], ["payload_bytes"], ["summary", "flows", "conversations", "top_talkers"]),
  table("flows", ["id", "first_seen", "last_seen", "src_ip", "dst_ip", "src_port", "dst_port", "protocol", "total_bytes", "packet_count", "runner_id", "session_id", "flow_key", "peak_rate_mbps"], ["id"], ["src_port", "dst_port", "total_bytes", "packet_count", "peak_rate_mbps"]),
  table("bandwidth_measurements", ["id", "source_label", "target_label", "bitrate_mbps", "jitter_ms", "measured_at", "target_host", "connection_type", "job_id", "direction", "environment", "peak_mbps", "minimum_mbps", "transferred_mb", "retransmits", "duration_seconds"], ["id"], ["bitrate_mbps", "jitter_ms", "peak_mbps", "minimum_mbps", "transferred_mb", "retransmits", "duration_seconds"]),
  table("hop_measurements", ["id", "session_id", "hop_number", "hop_ip", "avg_latency_ms", "loss_percent", "measured_at", "source_label", "target_label", "target_host", "connection_type", "job_id", "environment"], ["id"], ["hop_number", "avg_latency_ms", "loss_percent"]),
  table("traffic_metrics", ["id", "recorded_at", "interval_seconds", "bytes_in", "bytes_out", "packet_count", "avg_latency_ms", "packet_loss_pct", "gateway_reachable", "dns_reachable", "protocol_breakdown", "status"], ["id"], ["interval_seconds", "bytes_in", "bytes_out", "packet_count", "avg_latency_ms", "packet_loss_pct"], ["protocol_breakdown"]),
  table("events", ["id", "created_at", "severity", "title", "description", "raw_context", "ai_summary", "resolved_at", "source", "source_ref"], ["id"], [], ["raw_context"]),
] satisfies readonly P12TableDefinition[]);

export const P12_IMPORT_ORDER = Object.freeze(P12_TABLES.map(({ table: tableName }) => tableName));

export const P12_AUTH_COUPLED_COLUMNS = Object.freeze({
  profiles: Object.freeze(["id", "approved_by"]),
  diagnostic_jobs: Object.freeze(["requested_by"]),
  traffic_live_sessions: Object.freeze(["requested_by"]),
  network_nodes: Object.freeze(["created_by"]),
  network_targets: Object.freeze(["created_by"]),
  network_health_ping_jobs: Object.freeze(["requested_by"]),
  network_discovery_sessions: Object.freeze(["requested_by"]),
  device_inspection_sessions: Object.freeze(["requested_by"]),
  managed_telemetry_targets: Object.freeze(["created_by"]),
});

function table(
  tableName: string,
  columns: readonly string[],
  orderingKey: readonly string[],
  numericColumns?: readonly string[],
  jsonColumns?: readonly string[],
  sensitiveColumns?: readonly string[],
): P12TableDefinition {
  return Object.freeze({
    table: tableName,
    columns: Object.freeze(columns),
    orderingKey: Object.freeze(orderingKey),
    ...(numericColumns?.length ? { numericColumns: Object.freeze(numericColumns) } : {}),
    ...(jsonColumns?.length ? { jsonColumns: Object.freeze(jsonColumns) } : {}),
    ...(sensitiveColumns ? { sensitiveColumns: Object.freeze(sensitiveColumns) } : {}),
  });
}
