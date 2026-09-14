export type P12ForeignKeyDefinition = Readonly<{
  table: string;
  columns: readonly string[];
  parentTable: string;
  parentColumns: readonly string[];
  nullable?: boolean;
}>;

export type P12UniqueDefinition = Readonly<{
  name: string;
  table: string;
  columns: readonly string[];
  activeStatuses?: readonly string[];
}>;

export const P12_REQUIRED_COLUMNS = Object.freeze({
  profiles: ["id", "email", "role", "status", "created_at"],
  diagnostic_runners: ["id", "display_name", "last_seen_at", "health_status", "capabilities", "created_at", "updated_at"],
  network_nodes: ["id", "ip_address", "name", "created_at", "updated_at"],
  network_targets: ["id", "node_id", "runner_id", "enabled", "critical", "probe_method", "probe_interval_seconds", "timeout_ms", "failure_threshold", "recovery_threshold", "latency_warning_ms", "loss_warning_percent", "created_at", "updated_at"],
  managed_telemetry_targets: ["id", "node_id", "runner_id", "enabled", "credential_profile_ref", "snmp_version", "snmp_port", "poll_interval_seconds", "oper_error_threshold", "discard_threshold", "util_warning_percent", "util_critical_percent", "util_sustained_seconds", "created_at", "updated_at"],
  diagnostic_jobs: ["id", "runner_id", "requested_by", "status", "type", "source_label", "target_id", "target_label", "target_host", "iperf_port", "connection_type", "duration_seconds", "environment", "stage", "progress", "created_at", "updated_at"],
  traffic_live_sessions: ["id", "runner_id", "requested_by", "status", "duration_seconds", "capture_scope", "stage", "created_at", "updated_at"],
  network_discovery_sessions: ["runner_id", "session_id", "requested_by", "status", "phase", "total_hosts", "scanned_hosts", "found_count", "results", "created_at", "expires_at", "updated_at"],
  device_inspection_sessions: ["runner_id", "inspection_id", "requested_by", "target_ip", "authorization_source", "status", "stage", "created_at", "expires_at", "updated_at"],
  network_health_latest: ["target_id", "status", "packet_loss_percent", "last_checked_at", "consecutive_failures", "sample_count", "updated_at"],
  network_health_samples: ["id", "target_id", "sampled_at", "status", "packet_loss_percent", "sample_count"],
  network_health_ping_jobs: ["id", "target_id", "runner_id", "requested_by", "status", "created_at", "expires_at", "updated_at"],
  managed_device_latest: ["target_id", "status", "consecutive_poll_failures", "updated_at", "observed_hosts_status"],
  managed_interface_latest: ["target_id", "if_index", "is_physical", "updated_at"],
  managed_observed_hosts_latest: ["target_id", "ip_address", "observation_source", "enrichment_status", "first_seen_at", "last_seen_at", "status", "updated_at"],
  traffic_live_snapshots: ["runner_id", "session_id", "captured_at", "summary", "flows", "conversations", "top_talkers", "payload_bytes", "updated_at"],
  flows: ["id", "first_seen", "last_seen", "src_ip", "dst_ip", "protocol", "total_bytes", "packet_count"],
  bandwidth_measurements: ["id", "source_label", "target_label", "bitrate_mbps", "measured_at"],
  hop_measurements: ["id", "session_id", "hop_number", "loss_percent", "measured_at"],
  traffic_metrics: ["id", "recorded_at", "interval_seconds", "bytes_in", "bytes_out", "packet_count", "gateway_reachable", "dns_reachable", "protocol_breakdown", "status"],
  events: ["id", "created_at", "severity", "title", "raw_context", "source"],
} satisfies Readonly<Record<string, readonly string[]>>);

export const P12_FOREIGN_KEYS = Object.freeze([
  fk("network_targets", ["node_id"], "network_nodes", ["id"]),
  fk("network_targets", ["runner_id"], "diagnostic_runners", ["id"]),
  fk("managed_telemetry_targets", ["node_id"], "network_nodes", ["id"]),
  fk("managed_telemetry_targets", ["runner_id"], "diagnostic_runners", ["id"]),
  fk("diagnostic_jobs", ["runner_id"], "diagnostic_runners", ["id"]),
  fk("traffic_live_sessions", ["runner_id"], "diagnostic_runners", ["id"]),
  fk("network_discovery_sessions", ["runner_id"], "diagnostic_runners", ["id"]),
  fk("device_inspection_sessions", ["runner_id"], "diagnostic_runners", ["id"]),
  fk("network_health_latest", ["target_id"], "network_targets", ["id"]),
  fk("network_health_samples", ["target_id"], "network_targets", ["id"]),
  fk("network_health_ping_jobs", ["target_id"], "network_targets", ["id"]),
  fk("network_health_ping_jobs", ["runner_id"], "diagnostic_runners", ["id"]),
  fk("managed_device_latest", ["target_id"], "managed_telemetry_targets", ["id"]),
  fk("managed_interface_latest", ["target_id"], "managed_telemetry_targets", ["id"]),
  fk("managed_observed_hosts_latest", ["target_id"], "managed_telemetry_targets", ["id"]),
  fk("managed_observed_hosts_latest", ["node_id"], "network_nodes", ["id"], true),
  fk("traffic_live_snapshots", ["runner_id"], "diagnostic_runners", ["id"]),
  fk("traffic_live_snapshots", ["session_id"], "traffic_live_sessions", ["id"]),
  fk("flows", ["runner_id"], "diagnostic_runners", ["id"], true),
  fk("flows", ["session_id"], "traffic_live_sessions", ["id"], true),
  fk("bandwidth_measurements", ["job_id"], "diagnostic_jobs", ["id"], true),
  fk("hop_measurements", ["job_id"], "diagnostic_jobs", ["id"], true),
] satisfies readonly P12ForeignKeyDefinition[]);

export const P12_UNIQUE_KEYS = Object.freeze([
  unique("network_nodes_ip", "network_nodes", ["ip_address"]),
  unique("network_targets_runner_node", "network_targets", ["runner_id", "node_id"]),
  unique("managed_targets_runner_node", "managed_telemetry_targets", ["runner_id", "node_id"]),
  unique("network_discovery_session", "network_discovery_sessions", ["session_id"]),
  unique("device_inspection_session", "device_inspection_sessions", ["inspection_id"]),
  unique("network_health_sample_bucket", "network_health_samples", ["target_id", "sampled_at"]),
  unique("traffic_snapshot_session", "traffic_live_snapshots", ["session_id"]),
  unique("flow_session_key", "flows", ["session_id", "flow_key"]),
  unique("diagnostic_active_runner", "diagnostic_jobs", ["runner_id"], ["queued", "running"]),
  unique("traffic_active_runner", "traffic_live_sessions", ["runner_id"], ["queued", "running", "stopping"]),
  unique("manual_ping_active_target", "network_health_ping_jobs", ["target_id"], ["queued", "running"]),
] satisfies readonly P12UniqueDefinition[]);

export const P12_NATIVE_TYPE_EXPECTATIONS = Object.freeze({
  profiles: { id: "uuid", approved_by: "uuid", created_at: "timestamptz" },
  diagnostic_runners: { capabilities: "jsonb", preflight: "jsonb", last_seen_at: "timestamptz" },
  network_nodes: { id: "uuid", ip_address: "inet", created_by: "uuid", detected_fingerprint: "jsonb" },
  network_targets: { id: "uuid", node_id: "uuid", created_by: "uuid", loss_warning_percent: "numeric" },
  managed_telemetry_targets: { id: "uuid", node_id: "uuid", created_by: "uuid", util_warning_percent: "numeric", util_critical_percent: "numeric", snmp2c_community_encrypted: "bytea" },
  diagnostic_jobs: { id: "uuid", requested_by: "uuid", progress: "jsonb", network_context: "jsonb", route_context: "jsonb", preflight_context: "jsonb" },
  traffic_live_sessions: { id: "uuid", requested_by: "uuid" },
  network_discovery_sessions: { session_id: "uuid", requested_by: "uuid", local_ipv4: "inet", subnet_cidr: "cidr", results: "jsonb" },
  device_inspection_sessions: { inspection_id: "uuid", requested_by: "uuid", target_ip: "inet", result: "jsonb" },
  network_health_latest: { target_id: "uuid", packet_loss_percent: "numeric" },
  network_health_samples: { id: "int8", target_id: "uuid", packet_loss_percent: "numeric" },
  network_health_ping_jobs: { id: "uuid", target_id: "uuid", requested_by: "uuid", result: "jsonb" },
  managed_device_latest: { target_id: "uuid", uptime_seconds: "int8" },
  managed_interface_latest: { target_id: "uuid", speed_bps: "int8", rx_rate_bps: "numeric", tx_rate_bps: "numeric", rx_util_percent: "numeric", tx_util_percent: "numeric", rx_errors_cumulative: "int8", tx_errors_cumulative: "int8", in_discards_cumulative: "int8", out_discards_cumulative: "int8" },
  managed_observed_hosts_latest: { target_id: "uuid", node_id: "uuid", ip_address: "inet", mac_address: "macaddr" },
  traffic_live_snapshots: { session_id: "uuid", summary: "jsonb", flows: "jsonb", conversations: "jsonb", top_talkers: "jsonb" },
  flows: { id: "uuid", src_ip: "inet", dst_ip: "inet", total_bytes: "int8", packet_count: "int8", session_id: "uuid" },
  bandwidth_measurements: { id: "uuid", job_id: "uuid", retransmits: "int8" },
  hop_measurements: { id: "uuid", session_id: "uuid", job_id: "uuid" },
  traffic_metrics: { id: "uuid", bytes_in: "int8", bytes_out: "int8", packet_count: "int8", packet_loss_pct: "numeric", protocol_breakdown: "jsonb" },
  events: { id: "uuid", raw_context: "jsonb", source_ref: "uuid" },
} satisfies Readonly<Record<string, Readonly<Record<string, string>>>>);

function fk(
  table: string,
  columns: readonly string[],
  parentTable: string,
  parentColumns: readonly string[],
  nullable = false,
): P12ForeignKeyDefinition {
  return Object.freeze({ table, columns: Object.freeze(columns), parentTable, parentColumns: Object.freeze(parentColumns), ...(nullable ? { nullable: true } : {}) });
}

function unique(name: string, table: string, columns: readonly string[], activeStatuses?: readonly string[]): P12UniqueDefinition {
  return Object.freeze({ name, table, columns: Object.freeze(columns), ...(activeStatuses ? { activeStatuses: Object.freeze(activeStatuses) } : {}) });
}
