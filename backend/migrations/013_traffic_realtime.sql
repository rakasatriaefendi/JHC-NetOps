\set ON_ERROR_STOP on
BEGIN;

-- P14 Batch 5.1: additive invalidation-only notifications for Traffic.
-- Existing Network Health, Diagnostics, Device Inspector, outbox, and shadow
-- projection behavior remains unchanged.
DO $$
BEGIN
  IF current_database() <> 'jhc_netops'
     OR current_setting('port')::integer <> 5433
     OR (inet_server_addr() IS NOT NULL AND host(inet_server_addr()) NOT IN ('127.0.0.1', '::1'))
     OR current_setting('server_version_num')::integer NOT BETWEEN 160000 AND 169999
     OR current_setting('data_directory') <> '/var/lib/postgresql/16/jhcnetops'
     OR session_user <> 'postgres'
     OR to_regclass('asset.assets') IS NULL
     OR to_regclass('public.application_schema_migrations') IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.application_schema_migrations WHERE version = 12)
     OR to_regclass('public.traffic_live_sessions') IS NULL
     OR to_regclass('public.traffic_live_snapshots') IS NULL
  THEN
    RAISE EXCEPTION 'P14 Traffic realtime migration requires migration 012 on PostgreSQL 16/jhcnetops:5433';
  END IF;
END $$;

SET ROLE jhc_netops_owner;

CREATE FUNCTION public.publish_local_realtime_traffic_invalidation() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  topic_value text;
  aggregate_value text;
  notification_value text;
BEGIN
  IF TG_OP NOT IN ('INSERT', 'UPDATE', 'DELETE') OR TG_NARGS <> 2 OR TG_TABLE_SCHEMA <> 'public' THEN
    RAISE EXCEPTION 'local realtime Traffic trigger invocation is invalid';
  END IF;

  topic_value := TG_ARGV[0];
  IF topic_value <> 'traffic'
     OR TG_ARGV[1] <> 'runner_id'
     OR TG_TABLE_NAME NOT IN ('traffic_live_sessions', 'traffic_live_snapshots')
  THEN
    RAISE EXCEPTION 'local realtime Traffic trigger arguments are invalid';
  END IF;

  IF TG_OP = 'DELETE' THEN
    aggregate_value := OLD.runner_id::text;
  ELSE
    aggregate_value := NEW.runner_id::text;
  END IF;
  IF aggregate_value IS NULL OR aggregate_value !~ '^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$' THEN
    RAISE EXCEPTION 'local realtime Traffic aggregate key is invalid';
  END IF;

  notification_value := jsonb_build_object(
    'version', 1,
    'event_id', gen_random_uuid(),
    'topic', topic_value,
    'aggregate_key', aggregate_value,
    'occurred_at', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )::text;
  IF octet_length(notification_value) > 1024 THEN
    RAISE EXCEPTION 'local realtime Traffic notification is oversized';
  END IF;
  PERFORM pg_notify('jhc_netops_realtime_v1', notification_value);
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE TRIGGER local_realtime_traffic_live_sessions
AFTER INSERT OR UPDATE OR DELETE ON public.traffic_live_sessions
FOR EACH ROW EXECUTE FUNCTION public.publish_local_realtime_traffic_invalidation('traffic', 'runner_id');

CREATE TRIGGER local_realtime_traffic_live_snapshots
AFTER INSERT OR UPDATE OR DELETE ON public.traffic_live_snapshots
FOR EACH ROW EXECUTE FUNCTION public.publish_local_realtime_traffic_invalidation('traffic', 'runner_id');

INSERT INTO public.application_schema_migrations(version) VALUES (13);

RESET ROLE;
COMMIT;
