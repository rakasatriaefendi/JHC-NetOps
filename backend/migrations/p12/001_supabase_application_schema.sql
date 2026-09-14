\set ON_ERROR_STOP on
BEGIN;
SET ROLE jhc_netops_owner;

-- P12 rehearsal application schema only. The asset schema must already exist
-- from the read-only local baseline clone and is never created or changed here.
-- Supabase Auth, RLS, Realtime publications, cron jobs, and internal schemas are
-- intentionally outside this data-migration rehearsal.

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  full_name text,
  role text NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin', 'operator', 'viewer')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  approved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE public.traffic_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), recorded_at timestamptz NOT NULL DEFAULT now(),
  interval_seconds integer NOT NULL, bytes_in bigint NOT NULL, bytes_out bigint NOT NULL,
  packet_count bigint NOT NULL, avg_latency_ms double precision,
  packet_loss_pct numeric(5,2), gateway_reachable boolean NOT NULL,
  dns_reachable boolean NOT NULL, protocol_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (status IN ('normal','high_traffic','low_traffic','down','not_internet'))
);

CREATE TABLE public.events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now(),
  severity text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  title text NOT NULL, description text, raw_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  ai_summary text, resolved_at timestamptz,
  source text NOT NULL DEFAULT 'network_metrics', source_ref uuid
);

CREATE TABLE public.diagnostic_runners (
  id text PRIMARY KEY, display_name text NOT NULL, last_seen_at timestamptz NOT NULL DEFAULT now(),
  health_status text NOT NULL DEFAULT 'degraded' CHECK (health_status IN ('online','degraded')),
  health_error_code text, capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  preflight jsonb
);

CREATE TABLE public.network_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ip_address inet NOT NULL UNIQUE CHECK (masklen(ip_address) IN (32,128)),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  device_type text CHECK (device_type IS NULL OR device_type IN (
    'gateway','router','layer3_switch','managed_switch','server','firewall','access_point',
    'workstation','printer','camera','iot','phone','unknown','other')),
  location text CHECK (location IS NULL OR char_length(location) <= 200),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  detected_fingerprint jsonb, last_inspected_at timestamptz,
  CHECK (detected_fingerprint IS NULL OR (
    jsonb_typeof(detected_fingerprint) = 'object' AND octet_length(detected_fingerprint::text) <= 32768
    AND detected_fingerprint ? 'ip' AND detected_fingerprint->>'ip' = host(ip_address)
    AND detected_fingerprint->>'confidence' IN ('high','medium','low','unknown'))),
  CHECK ((detected_fingerprint IS NULL AND last_inspected_at IS NULL)
    OR (detected_fingerprint IS NOT NULL AND last_inspected_at IS NOT NULL))
);

CREATE FUNCTION public.set_network_node_updated_at() RETURNS trigger LANGUAGE plpgsql
SET search_path = '' AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TABLE public.network_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), node_id uuid NOT NULL REFERENCES public.network_nodes(id) ON DELETE CASCADE,
  runner_id text NOT NULL REFERENCES public.diagnostic_runners(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true, critical boolean NOT NULL DEFAULT false,
  probe_method text NOT NULL DEFAULT 'icmp' CHECK (probe_method = 'icmp'),
  probe_interval_seconds integer NOT NULL DEFAULT 30 CHECK (probe_interval_seconds BETWEEN 15 AND 3600),
  timeout_ms integer NOT NULL DEFAULT 1000 CHECK (timeout_ms BETWEEN 250 AND 5000),
  failure_threshold integer NOT NULL DEFAULT 3 CHECK (failure_threshold BETWEEN 2 AND 10),
  recovery_threshold integer NOT NULL DEFAULT 2 CHECK (recovery_threshold BETWEEN 1 AND 5),
  latency_warning_ms double precision NOT NULL DEFAULT 100 CHECK (latency_warning_ms BETWEEN 1 AND 60000),
  loss_warning_percent numeric(5,2) NOT NULL DEFAULT 40 CHECK (loss_warning_percent BETWEEN 0 AND 100),
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (runner_id,node_id)
);

CREATE TABLE public.managed_telemetry_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), node_id uuid NOT NULL REFERENCES public.network_nodes(id) ON DELETE CASCADE,
  runner_id text NOT NULL REFERENCES public.diagnostic_runners(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  credential_profile_ref text NOT NULL CHECK (char_length(btrim(credential_profile_ref)) BETWEEN 1 AND 64),
  snmp_version text NOT NULL DEFAULT '3' CHECK (snmp_version IN ('3','2c')),
  snmp_port integer NOT NULL DEFAULT 161 CHECK (snmp_port BETWEEN 1 AND 65535),
  poll_interval_seconds integer NOT NULL DEFAULT 60 CHECK (poll_interval_seconds IN (30,60)),
  oper_error_threshold integer NOT NULL DEFAULT 5 CHECK (oper_error_threshold BETWEEN 1 AND 100),
  discard_threshold integer NOT NULL DEFAULT 10 CHECK (discard_threshold BETWEEN 1 AND 100),
  util_warning_percent numeric(5,2) NOT NULL DEFAULT 80 CHECK (util_warning_percent BETWEEN 1 AND 100),
  util_critical_percent numeric(5,2) NOT NULL DEFAULT 95 CHECK (util_critical_percent BETWEEN 1 AND 100),
  util_sustained_seconds integer NOT NULL DEFAULT 300 CHECK (util_sustained_seconds BETWEEN 60 AND 3600),
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  snmp2c_community_encrypted bytea,
  UNIQUE (runner_id,node_id)
);

CREATE TABLE public.diagnostic_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), runner_id text NOT NULL REFERENCES public.diagnostic_runners(id),
  requested_by uuid NOT NULL, status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed')),
  type text NOT NULL DEFAULT 'bandwidth_and_path' CHECK (type = 'bandwidth_and_path'),
  source_label text NOT NULL, target_id text NOT NULL, target_label text NOT NULL, target_host text NOT NULL,
  iperf_port integer NOT NULL CHECK (iperf_port BETWEEN 1 AND 65535),
  connection_type text NOT NULL CHECK (connection_type IN ('wifi','ethernet')),
  duration_seconds integer NOT NULL CHECK (duration_seconds BETWEEN 1 AND 60),
  environment text NOT NULL CHECK (environment IN ('lan','localhost_demo')),
  stage text NOT NULL DEFAULT 'queued' CHECK (stage IN ('queued','preparing_runner','starting_wsl','checking_target','upload','download','mtr','saving','complete','failed')),
  progress jsonb NOT NULL DEFAULT '{}'::jsonb, error_code text, error_message text,
  created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(), network_context jsonb, route_context jsonb, preflight_context jsonb
);

CREATE TABLE public.traffic_live_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), runner_id text NOT NULL REFERENCES public.diagnostic_runners(id),
  requested_by uuid NOT NULL, status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','stopping','completed','failed','expired')),
  duration_seconds integer NOT NULL CHECK (duration_seconds IN (300,600,900,1800)),
  capture_scope text NOT NULL DEFAULT 'this_device' CHECK (capture_scope = 'this_device'),
  stage text NOT NULL DEFAULT 'queued' CHECK (stage IN ('queued','starting_wsl','capturing','stopping','complete','failed','expired')),
  error_code text, error_message text, created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz,
  expires_at timestamptz, completed_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.network_discovery_sessions (
  runner_id text PRIMARY KEY REFERENCES public.diagnostic_runners(id) ON DELETE CASCADE,
  session_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(), requested_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('idle','queued','running','completed','failed','expired')),
  phase text NOT NULL DEFAULT 'prepare' CHECK (phase IN ('prepare','scan')),
  connection_type text CHECK (connection_type IS NULL OR connection_type IN ('wifi','ethernet','unknown')),
  interface_alias text CHECK (interface_alias IS NULL OR char_length(interface_alias) BETWEEN 1 AND 256),
  local_ipv4 inet CHECK (local_ipv4 IS NULL OR masklen(local_ipv4) = 32), subnet_cidr cidr,
  total_hosts integer NOT NULL DEFAULT 0 CHECK (total_hosts BETWEEN 0 AND 254),
  scanned_hosts integer NOT NULL DEFAULT 0 CHECK (scanned_hosts BETWEEN 0 AND 254),
  found_count integer NOT NULL DEFAULT 0 CHECK (found_count BETWEEN 0 AND 254),
  results jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(results) = 'array' AND jsonb_array_length(results) <= 254),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, completed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.device_inspection_sessions (
  runner_id text PRIMARY KEY REFERENCES public.diagnostic_runners(id) ON DELETE CASCADE,
  inspection_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(), requested_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  target_ip inet NOT NULL CHECK (family(target_ip)=4 AND masklen(target_ip)=32 AND (
    target_ip << inet '10.0.0.0/8' OR target_ip << inet '172.16.0.0/12' OR target_ip << inet '192.168.0.0/16')),
  authorization_source text NOT NULL CHECK (authorization_source IN ('discovery','inventory')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','expired')),
  stage text NOT NULL DEFAULT 'validating_target' CHECK (stage IN ('validating_target','network_role','identity','services','normalizing','complete')),
  result jsonb CHECK (result IS NULL OR (jsonb_typeof(result)='object' AND octet_length(result::text)<=65536)),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, completed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.network_health_latest (
  target_id uuid PRIMARY KEY REFERENCES public.network_targets(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('online','degraded','offline')),
  latency_ms double precision CHECK (latency_ms IS NULL OR latency_ms >= 0),
  packet_loss_percent numeric(5,2) NOT NULL CHECK (packet_loss_percent BETWEEN 0 AND 100),
  last_checked_at timestamptz NOT NULL, last_success_at timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures BETWEEN 0 AND 1000000),
  sample_count integer NOT NULL DEFAULT 0 CHECK (sample_count BETWEEN 0 AND 5),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.network_health_samples (
  id bigserial PRIMARY KEY, target_id uuid NOT NULL REFERENCES public.network_targets(id) ON DELETE CASCADE,
  sampled_at timestamptz NOT NULL CHECK (sampled_at = date_trunc('minute',sampled_at)),
  status text NOT NULL CHECK (status IN ('online','degraded','offline')),
  latency_ms double precision CHECK (latency_ms IS NULL OR latency_ms >= 0),
  packet_loss_percent numeric(5,2) NOT NULL CHECK (packet_loss_percent BETWEEN 0 AND 100),
  sample_count integer NOT NULL DEFAULT 1 CHECK (sample_count BETWEEN 1 AND 5),
  UNIQUE (target_id,sampled_at)
);

CREATE TABLE public.network_health_ping_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), target_id uuid NOT NULL REFERENCES public.network_targets(id) ON DELETE CASCADE,
  runner_id text NOT NULL REFERENCES public.diagnostic_runners(id) ON DELETE CASCADE, requested_by uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed')),
  result jsonb CHECK (result IS NULL OR (jsonb_typeof(result)='object' AND octet_length(result::text)<=1024)),
  error_code text CHECK (error_code IS NULL OR error_code IN ('MANUAL_PING_FAILED','MANUAL_PING_TARGET_UNAVAILABLE')),
  created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, completed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 seconds'), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.managed_device_latest (
  target_id uuid PRIMARY KEY REFERENCES public.managed_telemetry_targets(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('connected','partial','auth_failed','timeout','unreachable','unsupported','poll_failed','not_configured')),
  sys_name text, sys_descr text, sys_object_id text,
  uptime_seconds bigint CHECK (uptime_seconds IS NULL OR uptime_seconds >= 0),
  manufacturer text, model text, serial_number text, last_polled_at timestamptz, last_success_at timestamptz,
  consecutive_poll_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_poll_failures BETWEEN 0 AND 1000000),
  error_category text CHECK (error_category IS NULL OR error_category IN ('auth_failure','timeout','unreachable','unsupported','agent_error')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  observed_hosts_status text NOT NULL DEFAULT 'unsupported' CHECK (observed_hosts_status IN ('available','empty','partial','unsupported'))
);

CREATE TABLE public.managed_interface_latest (
  target_id uuid NOT NULL REFERENCES public.managed_telemetry_targets(id) ON DELETE CASCADE,
  if_index integer NOT NULL, name text, description text, if_type integer, is_physical boolean NOT NULL DEFAULT false,
  admin_status text CHECK (admin_status IS NULL OR admin_status IN ('up','down','testing')),
  oper_status text CHECK (oper_status IS NULL OR oper_status IN ('up','down','testing','unknown')),
  speed_bps bigint CHECK (speed_bps IS NULL OR speed_bps >= 0),
  rx_rate_bps numeric(12,2) CHECK (rx_rate_bps IS NULL OR rx_rate_bps >= 0),
  tx_rate_bps numeric(12,2) CHECK (tx_rate_bps IS NULL OR tx_rate_bps >= 0),
  rx_util_percent numeric(5,2) CHECK (rx_util_percent IS NULL OR rx_util_percent BETWEEN 0 AND 100),
  tx_util_percent numeric(5,2) CHECK (tx_util_percent IS NULL OR tx_util_percent BETWEEN 0 AND 100),
  rx_errors_cumulative bigint CHECK (rx_errors_cumulative IS NULL OR rx_errors_cumulative >= 0),
  tx_errors_cumulative bigint CHECK (tx_errors_cumulative IS NULL OR tx_errors_cumulative >= 0),
  in_discards_cumulative bigint CHECK (in_discards_cumulative IS NULL OR in_discards_cumulative >= 0),
  out_discards_cumulative bigint CHECK (out_discards_cumulative IS NULL OR out_discards_cumulative >= 0),
  rx_errors_delta integer CHECK (rx_errors_delta IS NULL OR rx_errors_delta >= 0),
  tx_errors_delta integer CHECK (tx_errors_delta IS NULL OR tx_errors_delta >= 0),
  in_discards_delta integer CHECK (in_discards_delta IS NULL OR in_discards_delta >= 0),
  out_discards_delta integer CHECK (out_discards_delta IS NULL OR out_discards_delta >= 0),
  last_polled_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (target_id,if_index)
);

CREATE TABLE public.managed_observed_hosts_latest (
  target_id uuid NOT NULL REFERENCES public.managed_telemetry_targets(id) ON DELETE CASCADE,
  node_id uuid REFERENCES public.network_nodes(id) ON DELETE SET NULL, ip_address inet NOT NULL,
  mac_address macaddr, netbios_name text CHECK (netbios_name IS NULL OR char_length(netbios_name) BETWEEN 1 AND 15),
  observation_source text NOT NULL CHECK (observation_source IN ('ip_net_to_physical','ip_net_to_media')),
  enrichment_status text NOT NULL CHECK (enrichment_status IN ('resolved','unavailable','not_attempted')),
  first_seen_at timestamptz NOT NULL, last_seen_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('current','stale')), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (target_id,ip_address),
  CHECK (mac_address IS NULL OR mac_address <> '00:00:00:00:00:00'::macaddr)
);

CREATE TABLE public.traffic_live_snapshots (
  runner_id text PRIMARY KEY REFERENCES public.diagnostic_runners(id) ON DELETE CASCADE,
  session_id uuid NOT NULL UNIQUE REFERENCES public.traffic_live_sessions(id) ON DELETE CASCADE,
  captured_at timestamptz NOT NULL, summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  flows jsonb NOT NULL DEFAULT '[]'::jsonb, conversations jsonb NOT NULL DEFAULT '[]'::jsonb,
  top_talkers jsonb NOT NULL DEFAULT '[]'::jsonb,
  payload_bytes integer NOT NULL CHECK (payload_bytes BETWEEN 1 AND 65536), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.flows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), first_seen timestamptz NOT NULL, last_seen timestamptz NOT NULL,
  src_ip inet NOT NULL, dst_ip inet NOT NULL, src_port integer CHECK (src_port BETWEEN 0 AND 65535),
  dst_port integer CHECK (dst_port BETWEEN 0 AND 65535), protocol text NOT NULL,
  total_bytes bigint NOT NULL, packet_count bigint NOT NULL,
  runner_id text REFERENCES public.diagnostic_runners(id) ON DELETE SET NULL,
  session_id uuid REFERENCES public.traffic_live_sessions(id) ON DELETE CASCADE,
  flow_key text, peak_rate_mbps double precision CHECK (peak_rate_mbps IS NULL OR peak_rate_mbps >= 0),
  UNIQUE (session_id,flow_key)
);

CREATE TABLE public.bandwidth_measurements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_label text NOT NULL, target_label text NOT NULL,
  bitrate_mbps double precision NOT NULL CHECK (bitrate_mbps >= 0),
  jitter_ms double precision CHECK (jitter_ms IS NULL OR jitter_ms >= 0), measured_at timestamptz NOT NULL DEFAULT now(),
  target_host text, connection_type text CHECK (connection_type IS NULL OR connection_type IN ('wifi','ethernet')),
  job_id uuid REFERENCES public.diagnostic_jobs(id) ON DELETE SET NULL,
  direction text CHECK (direction IS NULL OR direction IN ('upload','download')),
  environment text CHECK (environment IS NULL OR environment IN ('lan','localhost_demo')),
  peak_mbps double precision CHECK (peak_mbps IS NULL OR peak_mbps >= 0),
  minimum_mbps double precision CHECK (minimum_mbps IS NULL OR minimum_mbps >= 0),
  transferred_mb double precision CHECK (transferred_mb IS NULL OR transferred_mb >= 0),
  retransmits bigint CHECK (retransmits IS NULL OR retransmits >= 0),
  duration_seconds double precision CHECK (duration_seconds IS NULL OR duration_seconds > 0)
);

CREATE TABLE public.hop_measurements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid NOT NULL,
  hop_number integer NOT NULL CHECK (hop_number > 0), hop_ip inet,
  avg_latency_ms double precision CHECK (avg_latency_ms IS NULL OR avg_latency_ms >= 0),
  loss_percent double precision NOT NULL CHECK (loss_percent BETWEEN 0 AND 100), measured_at timestamptz NOT NULL DEFAULT now(),
  source_label text, target_label text, target_host text,
  connection_type text CHECK (connection_type IS NULL OR connection_type IN ('wifi','ethernet')),
  job_id uuid REFERENCES public.diagnostic_jobs(id) ON DELETE SET NULL,
  environment text CHECK (environment IS NULL OR environment IN ('lan','localhost_demo'))
);

CREATE UNIQUE INDEX diagnostic_jobs_one_active_per_runner_idx ON public.diagnostic_jobs(runner_id) WHERE status IN ('queued','running');
CREATE UNIQUE INDEX traffic_live_sessions_one_active_runner_idx ON public.traffic_live_sessions(runner_id) WHERE status IN ('queued','running','stopping');
CREATE UNIQUE INDEX network_health_ping_jobs_one_active_target_idx ON public.network_health_ping_jobs(target_id) WHERE status IN ('queued','running');
CREATE INDEX network_health_samples_target_time_idx ON public.network_health_samples(target_id,sampled_at DESC);
CREATE INDEX flows_last_seen_idx ON public.flows(last_seen);
CREATE INDEX events_source_ref_created_idx ON public.events(source,source_ref,created_at DESC);
CREATE INDEX managed_observed_hosts_freshness_idx ON public.managed_observed_hosts_latest(target_id,status,last_seen_at DESC);

CREATE TRIGGER network_nodes_set_updated_at BEFORE UPDATE ON public.network_nodes FOR EACH ROW EXECUTE FUNCTION public.set_network_node_updated_at();
CREATE TRIGGER network_targets_set_updated_at BEFORE UPDATE ON public.network_targets FOR EACH ROW EXECUTE FUNCTION public.set_network_node_updated_at();
CREATE TRIGGER managed_telemetry_targets_set_updated_at BEFORE UPDATE ON public.managed_telemetry_targets FOR EACH ROW EXECUTE FUNCTION public.set_network_node_updated_at();
CREATE TRIGGER managed_device_latest_set_updated_at BEFORE UPDATE ON public.managed_device_latest FOR EACH ROW EXECUTE FUNCTION public.set_network_node_updated_at();
CREATE TRIGGER managed_interface_latest_set_updated_at BEFORE UPDATE ON public.managed_interface_latest FOR EACH ROW EXECUTE FUNCTION public.set_network_node_updated_at();
CREATE TRIGGER network_discovery_sessions_set_updated_at BEFORE UPDATE ON public.network_discovery_sessions FOR EACH ROW EXECUTE FUNCTION public.set_network_node_updated_at();
CREATE TRIGGER device_inspection_sessions_set_updated_at BEFORE UPDATE ON public.device_inspection_sessions FOR EACH ROW EXECUTE FUNCTION public.set_network_node_updated_at();

GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO jhc_netops_app;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO jhc_netops_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO jhc_netops_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO jhc_netops_app;

RESET ROLE;
COMMIT;
