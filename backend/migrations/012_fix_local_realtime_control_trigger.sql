\set ON_ERROR_STOP on
BEGIN;

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
     OR NOT EXISTS (SELECT 1 FROM public.application_schema_migrations WHERE version = 11)
     OR to_regprocedure('public.publish_local_realtime_control_invalidation()') IS NULL
     OR to_regclass('public.diagnostic_runners') IS NULL
     OR to_regclass('public.diagnostic_jobs') IS NULL
     OR to_regclass('public.device_inspection_sessions') IS NULL
  THEN
    RAISE EXCEPTION 'P14 realtime control trigger repair requires migration 011 on PostgreSQL 16/jhcnetops:5433';
  END IF;
END $$;

SET ROLE jhc_netops_owner;

CREATE OR REPLACE FUNCTION public.publish_local_realtime_control_invalidation() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  topic_value text;
  aggregate_value text;
  notification_value text;
BEGIN
  IF TG_OP NOT IN ('INSERT', 'UPDATE', 'DELETE') OR TG_NARGS <> 2 THEN
    RAISE EXCEPTION 'local realtime control trigger invocation is invalid';
  END IF;

  topic_value := TG_ARGV[0];
  IF TG_TABLE_NAME = 'diagnostic_runners' THEN
    IF topic_value <> 'diagnostics' OR TG_ARGV[1] <> 'id' THEN
      RAISE EXCEPTION 'local realtime control trigger arguments are invalid';
    END IF;
    IF TG_OP = 'DELETE' THEN
      aggregate_value := OLD.id::text;
    ELSE
      aggregate_value := NEW.id::text;
    END IF;
  ELSIF TG_TABLE_NAME = 'diagnostic_jobs' THEN
    IF topic_value <> 'diagnostics' OR TG_ARGV[1] <> 'id' THEN
      RAISE EXCEPTION 'local realtime control trigger arguments are invalid';
    END IF;
    IF TG_OP = 'DELETE' THEN
      aggregate_value := OLD.id::text;
    ELSE
      aggregate_value := NEW.id::text;
    END IF;
  ELSIF TG_TABLE_NAME = 'device_inspection_sessions' THEN
    IF topic_value <> 'device_inspector' OR TG_ARGV[1] <> 'runner_id' THEN
      RAISE EXCEPTION 'local realtime control trigger arguments are invalid';
    END IF;
    IF TG_OP = 'DELETE' THEN
      aggregate_value := OLD.runner_id::text;
    ELSE
      aggregate_value := NEW.runner_id::text;
    END IF;
  ELSE
    RAISE EXCEPTION 'local realtime control trigger table is invalid';
  END IF;

  IF aggregate_value IS NULL OR aggregate_value !~ '^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$' THEN
    RAISE EXCEPTION 'local realtime aggregate key is invalid';
  END IF;

  notification_value := jsonb_build_object(
    'version', 1,
    'event_id', gen_random_uuid(),
    'topic', topic_value,
    'aggregate_key', aggregate_value,
    'occurred_at', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )::text;
  IF octet_length(notification_value) > 1024 THEN
    RAISE EXCEPTION 'local realtime notification is oversized';
  END IF;
  PERFORM pg_notify('jhc_netops_realtime_v1', notification_value);
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

INSERT INTO public.application_schema_migrations(version) VALUES (12);

RESET ROLE;
COMMIT;
