\set ON_ERROR_STOP on
BEGIN;

-- P14 Batch 4.1: additive invalidation-only notifications for Diagnostics and
-- Device Inspector. Migration 009 and its Network Health triggers stay intact.
DO $$
BEGIN
  IF current_database() <> 'jhc_netops'
     OR current_setting('port')::integer <> 5433
     OR (
       inet_server_addr() IS NOT NULL
       AND host(inet_server_addr()) NOT IN ('127.0.0.1', '::1')
     )
     OR current_setting('server_version_num')::integer NOT BETWEEN 160000 AND 169999
     OR current_setting('data_directory') <> '/var/lib/postgresql/16/jhcnetops'
     OR session_user <> 'postgres'
     OR to_regclass('asset.assets') IS NULL
     OR to_regclass('public.application_schema_migrations') IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.application_schema_migrations WHERE version = 9)
     OR to_regprocedure('public.publish_local_realtime_invalidation()') IS NULL
     OR to_regclass('public.diagnostic_runners') IS NULL
     OR to_regclass('public.diagnostic_jobs') IS NULL
     OR to_regclass('public.device_inspection_sessions') IS NULL
  THEN
    RAISE EXCEPTION 'P14 control-plane realtime migration requires migration 009 on PostgreSQL 16/jhcnetops:5433';
  END IF;
END $$;

SET ROLE jhc_netops_owner;

CREATE FUNCTION public.publish_local_realtime_control_invalidation() RETURNS trigger
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
  IF NOT (
    (topic_value = 'diagnostics' AND TG_TABLE_NAME = 'diagnostic_runners' AND TG_ARGV[1] = 'id')
    OR (topic_value = 'diagnostics' AND TG_TABLE_NAME = 'diagnostic_jobs' AND TG_ARGV[1] = 'id')
    OR (topic_value = 'device_inspector' AND TG_TABLE_NAME = 'device_inspection_sessions' AND TG_ARGV[1] = 'runner_id')
  ) THEN
    RAISE EXCEPTION 'local realtime control trigger arguments are invalid';
  END IF;

  IF TG_OP = 'DELETE' THEN
    aggregate_value := CASE
      WHEN TG_TABLE_NAME IN ('diagnostic_runners', 'diagnostic_jobs') THEN OLD.id::text
      WHEN TG_TABLE_NAME = 'device_inspection_sessions' THEN OLD.runner_id::text
    END;
  ELSE
    aggregate_value := CASE
      WHEN TG_TABLE_NAME IN ('diagnostic_runners', 'diagnostic_jobs') THEN NEW.id::text
      WHEN TG_TABLE_NAME = 'device_inspection_sessions' THEN NEW.runner_id::text
    END;
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

CREATE TRIGGER local_realtime_diagnostic_runners
AFTER INSERT OR UPDATE OR DELETE ON public.diagnostic_runners
FOR EACH ROW EXECUTE FUNCTION public.publish_local_realtime_control_invalidation('diagnostics', 'id');

CREATE TRIGGER local_realtime_diagnostic_jobs
AFTER INSERT OR UPDATE OR DELETE ON public.diagnostic_jobs
FOR EACH ROW EXECUTE FUNCTION public.publish_local_realtime_control_invalidation('diagnostics', 'id');

CREATE TRIGGER local_realtime_device_inspection_sessions
AFTER INSERT OR UPDATE OR DELETE ON public.device_inspection_sessions
FOR EACH ROW EXECUTE FUNCTION public.publish_local_realtime_control_invalidation('device_inspector', 'runner_id');

INSERT INTO public.application_schema_migrations(version) VALUES (10);

RESET ROLE;
COMMIT;
