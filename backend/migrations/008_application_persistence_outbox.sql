\set ON_ERROR_STOP on
BEGIN;

-- P13 Batch 5: transactional Realtime shadow outbox and internal cutover canary.
-- Execute explicitly, once, only against PostgreSQL 16/jhcnetops on loopback
-- port 5433 after migration 007. Supabase internal schemas and asset.* stay unchanged.
DO $$
BEGIN
  IF current_database() <> 'jhc_netops'
     OR inet_server_port() IS DISTINCT FROM 5433
     OR host(inet_server_addr()) IS NULL
     OR host(inet_server_addr()) NOT IN ('127.0.0.1', '::1')
     OR current_setting('server_version_num')::integer NOT BETWEEN 160000 AND 169999
     OR to_regclass('asset.assets') IS NULL
     OR to_regclass('public.application_schema_migrations') IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.application_schema_migrations WHERE version = 7)
     OR to_regclass('public.diagnostic_runners') IS NULL
     OR to_regclass('public.network_health_latest') IS NULL
  THEN
    RAISE EXCEPTION 'P13 Batch 5 migration requires migration 007 on PostgreSQL 16/jhcnetops:5433';
  END IF;
END $$;

SET ROLE jhc_netops_owner;

CREATE TABLE public.realtime_outbox (
  id bigserial PRIMARY KEY,
  event_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  aggregate_type text NOT NULL CHECK (char_length(btrim(aggregate_type)) BETWEEN 1 AND 64),
  aggregate_key jsonb NOT NULL CHECK (jsonb_typeof(aggregate_key) = 'object'),
  operation text NOT NULL CHECK (operation IN ('INSERT','UPDATE','DELETE')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 100),
  next_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivered_at timestamptz,
  last_error_category text CHECK (last_error_category IS NULL OR last_error_category IN (
    'transient_network','supabase_unavailable','payload_validation','projection_not_allowed'
  ))
);

CREATE INDEX realtime_outbox_poll_idx
  ON public.realtime_outbox (status, next_attempt_at, id)
  WHERE status IN ('pending','failed');
CREATE INDEX realtime_outbox_aggregate_order_idx
  ON public.realtime_outbox (aggregate_type, aggregate_key, id);

CREATE TABLE public.realtime_projection_watermarks (
  aggregate_type text NOT NULL CHECK (char_length(btrim(aggregate_type)) BETWEEN 1 AND 64),
  aggregate_key jsonb NOT NULL CHECK (jsonb_typeof(aggregate_key) = 'object'),
  last_delivered_outbox_id bigint NOT NULL CHECK (last_delivered_outbox_id > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (aggregate_type, aggregate_key)
);

-- This fixed AFTER ROW trigger makes the domain write and outbox insertion one
-- PostgreSQL transaction. Any outbox failure rolls back the domain statement.
CREATE FUNCTION public.enqueue_realtime_shadow() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  row_value jsonb;
  key_value jsonb;
BEGIN
  row_value := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  -- Credential material is never duplicated into the projection queue.
  IF TG_TABLE_NAME = 'managed_telemetry_targets' THEN
    row_value := row_value - 'snmp2c_community_encrypted';
  END IF;
  CASE TG_TABLE_NAME
    WHEN 'diagnostic_runners' THEN key_value := jsonb_build_object('id', row_value->'id');
    WHEN 'diagnostic_jobs' THEN key_value := jsonb_build_object('id', row_value->'id');
    WHEN 'network_discovery_sessions' THEN key_value := jsonb_build_object('runner_id', row_value->'runner_id');
    WHEN 'device_inspection_sessions' THEN key_value := jsonb_build_object('runner_id', row_value->'runner_id');
    WHEN 'traffic_live_sessions' THEN key_value := jsonb_build_object('id', row_value->'id');
    WHEN 'traffic_live_snapshots' THEN key_value := jsonb_build_object('runner_id', row_value->'runner_id');
    WHEN 'network_targets' THEN key_value := jsonb_build_object('id', row_value->'id');
    WHEN 'network_health_latest' THEN key_value := jsonb_build_object('target_id', row_value->'target_id');
    WHEN 'network_health_ping_jobs' THEN key_value := jsonb_build_object('id', row_value->'id');
    WHEN 'events' THEN key_value := jsonb_build_object('id', row_value->'id');
    WHEN 'managed_device_latest' THEN key_value := jsonb_build_object('target_id', row_value->'target_id');
    WHEN 'managed_interface_latest' THEN key_value := jsonb_build_object('target_id', row_value->'target_id', 'if_index', row_value->'if_index');
    WHEN 'managed_observed_hosts_latest' THEN key_value := jsonb_build_object('target_id', row_value->'target_id', 'ip_address', row_value->'ip_address');
    WHEN 'profiles' THEN key_value := jsonb_build_object('id', row_value->'id');
    WHEN 'network_nodes' THEN key_value := jsonb_build_object('id', row_value->'id');
    WHEN 'managed_telemetry_targets' THEN key_value := jsonb_build_object('id', row_value->'id');
    ELSE RAISE EXCEPTION 'table % is not approved for Realtime shadow projection', TG_TABLE_NAME;
  END CASE;

  INSERT INTO public.realtime_outbox (aggregate_type, aggregate_key, operation, payload)
  VALUES (TG_TABLE_NAME, key_value, TG_OP, row_value);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER shadow_diagnostic_runners AFTER INSERT OR UPDATE OR DELETE ON public.diagnostic_runners FOR EACH ROW EXECUTE FUNCTION public.enqueue_realtime_shadow();
CREATE TRIGGER shadow_diagnostic_jobs AFTER INSERT OR UPDATE OR DELETE ON public.diagnostic_jobs FOR EACH ROW EXECUTE FUNCTION public.enqueue_realtime_shadow();
CREATE TRIGGER shadow_network_discovery_sessions AFTER INSERT OR UPDATE OR DELETE ON public.network_discovery_sessions FOR EACH ROW EXECUTE FUNCTION public.enqueue_realtime_shadow();
CREATE TRIGGER shadow_device_inspection_sessions AFTER INSERT OR UPDATE OR DELETE ON public.device_inspection_sessions FOR EACH ROW EXECUTE FUNCTION public.enqueue_realtime_shadow();
CREATE TRIGGER shadow_traffic_live_sessions AFTER INSERT OR UPDATE OR DELETE ON public.traffic_live_sessions FOR EACH ROW EXECUTE FUNCTION public.enqueue_realtime_shadow();
CREATE TRIGGER shadow_traffic_live_snapshots AFTER INSERT OR UPDATE OR DELETE ON public.traffic_live_snapshots FOR EACH ROW EXECUTE FUNCTION public.enqueue_realtime_shadow();
CREATE TRIGGER shadow_network_targets AFTER INSERT OR UPDATE OR DELETE ON public.network_targets FOR EACH ROW EXECUTE FUNCTION public.enqueue_realtime_shadow();
CREATE TRIGGER shadow_network_health_latest AFTER INSERT OR UPDATE OR DELETE ON public.network_health_latest FOR EACH ROW EXECUTE FUNCTION public.enqueue_realtime_shadow();
CREATE TRIGGER shadow_network_health_ping_jobs AFTER INSERT OR UPDATE OR DELETE ON public.network_health_ping_jobs FOR EACH ROW EXECUTE FUNCTION public.enqueue_realtime_shadow();
CREATE TRIGGER shadow_events AFTER INSERT OR UPDATE OR DELETE ON public.events FOR EACH ROW EXECUTE FUNCTION public.enqueue_realtime_shadow();
CREATE TRIGGER shadow_managed_device_latest AFTER INSERT OR UPDATE OR DELETE ON public.managed_device_latest FOR EACH ROW EXECUTE FUNCTION public.enqueue_realtime_shadow();
CREATE TRIGGER shadow_managed_interface_latest AFTER INSERT OR UPDATE OR DELETE ON public.managed_interface_latest FOR EACH ROW EXECUTE FUNCTION public.enqueue_realtime_shadow();
CREATE TRIGGER shadow_managed_observed_hosts_latest AFTER INSERT OR UPDATE OR DELETE ON public.managed_observed_hosts_latest FOR EACH ROW EXECUTE FUNCTION public.enqueue_realtime_shadow();
CREATE TRIGGER shadow_profiles AFTER INSERT OR UPDATE OR DELETE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.enqueue_realtime_shadow();
CREATE TRIGGER shadow_network_nodes AFTER INSERT OR UPDATE OR DELETE ON public.network_nodes FOR EACH ROW EXECUTE FUNCTION public.enqueue_realtime_shadow();
CREATE TRIGGER shadow_managed_telemetry_targets AFTER INSERT OR UPDATE OR DELETE ON public.managed_telemetry_targets FOR EACH ROW EXECUTE FUNCTION public.enqueue_realtime_shadow();

CREATE TABLE public.cutover_canary (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canary_type text NOT NULL DEFAULT 'internal_cutover_canary' CHECK (canary_type = 'internal_cutover_canary'),
  cutover_identity text NOT NULL UNIQUE CHECK (cutover_identity ~ '^p13-cutover-[0-9]{13}-[a-z0-9]{6}$'),
  payload jsonb NOT NULL CHECK (
    jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 1024
    AND payload->>'test' = 'internal-cutover-canary'),
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes')
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes')
);
CREATE INDEX cutover_canary_expiry_idx ON public.cutover_canary (expires_at);

INSERT INTO public.application_schema_migrations(version) VALUES (8);

GRANT USAGE ON SCHEMA public TO jhc_netops_app;
GRANT SELECT,INSERT,UPDATE ON public.realtime_outbox TO jhc_netops_app;
GRANT SELECT,INSERT,UPDATE ON public.realtime_projection_watermarks TO jhc_netops_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.cutover_canary TO jhc_netops_app;
GRANT USAGE,SELECT ON SEQUENCE public.realtime_outbox_id_seq TO jhc_netops_app;

RESET ROLE;
COMMIT;
