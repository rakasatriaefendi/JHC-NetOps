import type { ConnectionType, DiagnosticEnvironment } from "@/lib/diagnostics";

export type DiagnosticTarget = {
  id: string;
  label: string;
  host: string;
  iperf_port: number;
  environment: DiagnosticEnvironment;
};

export type RunnerCapabilities = {
  source_locations: string[];
  targets: DiagnosticTarget[];
  durations: number[];
  traffic_durations_seconds?: number[];
  operations: ("bandwidth_and_path" | "traffic_live" | "network_discovery" | "device_inspect" | "manual_ping")[];
  device_inspector?: { available: boolean; probe_engine?: string };
  snmp_telemetry?: {
    enabled: boolean;
    max_concurrent?: number;
    poll_intervals_seconds?: number[];
    versions?: string[];
    credential_profiles?: string[];
  };
};

export type NetworkContext = {
  host_name: string;
  interface_alias: string;
  interface_description: string;
  connection_type: ConnectionType | "unknown";
  operational_status: string;
  local_ipv4: string;
  prefix_length: number;
  subnet_mask: string;
  subnet_cidr: string;
  default_gateway: string | null;
  dns_servers: string[];
  link_speed_mbps: number | null;
  ssid?: string;
  wifi_signal_percent?: number;
  wifi_receive_rate_mbps?: number;
  wifi_transmit_rate_mbps?: number;
};

export type RouteContext = {
  target_id: string;
  target_host: string;
  resolved_target_ip: string;
  route_type: "on_link" | "routed";
  source_ip: string;
  interface_alias: string;
  interface_index: number;
  next_hop: string | null;
  route_metric: number;
};

export type ReachabilityObservation = { status: "responded" | "no_response"; latency_ms: number | null };
export type PreflightContext = {
  checked_at: string;
  interface_detected: true;
  route_resolved: true;
  gateway: ReachabilityObservation | null;
  target: ReachabilityObservation;
  iperf: { ready: boolean; port: number; managed_demo?: boolean };
};

export type RunnerPreflight = {
  request_id?: string;
  target_id?: string;
  status?: "queued" | "running" | "completed" | "failed";
  requested_at?: string;
  completed_at?: string;
  error_code?: string;
  network_context?: NetworkContext;
  route_context?: RouteContext;
  checks?: PreflightContext;
};

export type DiagnosticRunner = {
  id: string;
  display_name: string;
  last_seen_at: string;
  health_status: "online" | "degraded";
  health_error_code: string | null;
  capabilities: RunnerCapabilities;
  preflight: RunnerPreflight;
  updated_at: string;
};

export type LiveSample = { second: number; mbps: number };
export type DirectionSummary = {
  direction: "upload" | "download";
  average_mbps: number;
  peak_mbps: number | null;
  minimum_mbps: number | null;
  transferred_mb: number | null;
  retransmits: number | null;
  duration_seconds: number | null;
};
export type DiagnosticProgress = {
  direction?: "upload" | "download";
  elapsed_seconds?: number;
  duration_seconds?: number;
  progress_percent?: number;
  current_mbps?: number;
  average_mbps?: number;
  peak_mbps?: number;
  minimum_mbps?: number;
  transferred_mb?: number;
  retransmits?: number;
  live_samples?: LiveSample[];
  summaries?: Partial<Record<"upload" | "download", DirectionSummary>>;
};

export type DiagnosticJob = {
  id: string;
  runner_id: string;
  requested_by: string;
  status: "queued" | "running" | "completed" | "failed";
  type: "bandwidth_and_path";
  source_label: string;
  target_id: string;
  target_label: string;
  target_host: string;
  iperf_port: number;
  connection_type: ConnectionType;
  duration_seconds: number;
  environment: DiagnosticEnvironment;
  stage: string;
  progress: DiagnosticProgress;
  network_context: NetworkContext | null;
  route_context: RouteContext | null;
  preflight_context: PreflightContext | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
};

export type DiagnosticJobState = {
  runners: DiagnosticRunner[];
  jobs: DiagnosticJob[];
  server_time: string;
};

export function isRunnerFresh(runner: DiagnosticRunner, now = Date.now()) {
  return now - Date.parse(runner.last_seen_at) <= 30_000;
}
