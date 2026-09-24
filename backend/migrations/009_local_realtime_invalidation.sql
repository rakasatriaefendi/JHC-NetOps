\set ON_ERROR_STOP on
BEGIN;

-- P14 Batch 2: local, invalidation-only PostgreSQL notifications for the later
-- Network Health SSE pilot. Existing P13 outbox/projector objects stay active.
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
     OR NOT EXISTS (SELECT 1 FROM public.application_schema_migrations WHERE version = 8)
     OR to_regclass('public.network_targets') IS NULL
     OR to_regclass('public.network_health_latest') IS NULL
     OR to_regclass('public.events') IS NULL
     OR to_regclass('public.realtime_outbox') IS NULL
  THEN
    RAISE EXCEPTION 'P14 local realtime migration requires P13 migration 008 on PostgreSQL 16/jhcnetops:5433';
  END IF;
END $$;

SET ROLE jhc_netops_owner;

CREATE FUNCTION public.publish_local_realtime_invalidation() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  row_value jsonb;
  topic_value text;
  aggregate_value text;
  notification_value text;
BEGIN
  row_value := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  topic_value := TG_ARGV[0];

  IF topic_value <> 'network_health' OR TG_NARGS <> 2 THEN
    RAISE EXCEPTION 'local realtime trigger arguments are invalid';
  END IF;
  IF TG_TABLE_NAME = 'events' AND row_value->>'source' <> 'network_health' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  aggregate_value := row_value->>TG_ARGV[1];
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

CREATE TRIGGER local_realtime_network_targets
AFTER INSERT OR UPDATE OR DELETE ON public.network_targets
FOR EACH ROW EXECUTE FUNCTION public.publish_local_realtime_invalidation('network_health', 'id');

CREATE TRIGGER local_realtime_network_health_latest
AFTER INSERT OR UPDATE OR DELETE ON public.network_health_latest
FOR EACH ROW EXECUTE FUNCTION public.publish_local_realtime_invalidation('network_health', 'target_id');

CREATE TRIGGER local_realtime_network_health_events
AFTER INSERT OR UPDATE OR DELETE ON public.events
FOR EACH ROW EXECUTE FUNCTION public.publish_local_realtime_invalidation('network_health', 'id');

INSERT INTO public.application_schema_migrations(version) VALUES (9);

RESET ROLE;
COMMIT;
