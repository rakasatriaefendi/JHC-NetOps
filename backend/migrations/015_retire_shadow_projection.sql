\set ON_ERROR_STOP on
BEGIN;

-- P15.3: retire only the migration-008 Supabase shadow producers. Historical
-- outbox evidence and every local PostgreSQL NOTIFY trigger remain unchanged.
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
     OR NOT EXISTS (SELECT 1 FROM public.application_schema_migrations WHERE version = 14)
     OR (SELECT max(version) FROM public.application_schema_migrations) <> 14
     OR to_regclass('public.realtime_outbox') IS NULL
     OR to_regclass('public.realtime_projection_watermarks') IS NULL
     OR to_regprocedure('public.enqueue_realtime_shadow()') IS NULL
  THEN
    RAISE EXCEPTION 'P15 shadow retirement requires migration 014 on PostgreSQL 16/jhcnetops:5433';
  END IF;

  IF EXISTS (
    WITH expected(table_name, trigger_name) AS (
      VALUES
        ('diagnostic_runners', 'shadow_diagnostic_runners'),
        ('diagnostic_jobs', 'shadow_diagnostic_jobs'),
        ('network_discovery_sessions', 'shadow_network_discovery_sessions'),
        ('device_inspection_sessions', 'shadow_device_inspection_sessions'),
        ('traffic_live_sessions', 'shadow_traffic_live_sessions'),
        ('traffic_live_snapshots', 'shadow_traffic_live_snapshots'),
        ('network_targets', 'shadow_network_targets'),
        ('network_health_latest', 'shadow_network_health_latest'),
        ('network_health_ping_jobs', 'shadow_network_health_ping_jobs'),
        ('events', 'shadow_events'),
        ('managed_device_latest', 'shadow_managed_device_latest'),
        ('managed_interface_latest', 'shadow_managed_interface_latest'),
        ('managed_observed_hosts_latest', 'shadow_managed_observed_hosts_latest'),
        ('profiles', 'shadow_profiles'),
        ('network_nodes', 'shadow_network_nodes'),
        ('managed_telemetry_targets', 'shadow_managed_telemetry_targets')
    ),
    actual AS (
      SELECT c.relname AS table_name,
             t.tgname AS trigger_name,
             pn.nspname AS function_schema,
             p.proname AS function_name,
             t.tgenabled AS enabled
      FROM pg_trigger AS t
      JOIN pg_class AS c ON c.oid = t.tgrelid
      JOIN pg_namespace AS cn ON cn.oid = c.relnamespace
      JOIN pg_proc AS p ON p.oid = t.tgfoid
      JOIN pg_namespace AS pn ON pn.oid = p.pronamespace
      WHERE NOT t.tgisinternal
        AND cn.nspname = 'public'
        AND (
          left(t.tgname, 7) = 'shadow_'
          OR (pn.nspname = 'public' AND p.proname = 'enqueue_realtime_shadow')
        )
    )
    SELECT 1
    FROM expected
    FULL OUTER JOIN actual USING (table_name, trigger_name)
    WHERE expected.table_name IS NULL
       OR actual.table_name IS NULL
       OR actual.function_schema <> 'public'
       OR actual.function_name <> 'enqueue_realtime_shadow'
       OR actual.enabled <> 'O'
  ) THEN
    RAISE EXCEPTION 'P15 shadow trigger inventory does not match the exact migration-008 surface';
  END IF;
END $$;

SET ROLE jhc_netops_owner;

DROP TRIGGER shadow_diagnostic_runners ON public.diagnostic_runners;
DROP TRIGGER shadow_diagnostic_jobs ON public.diagnostic_jobs;
DROP TRIGGER shadow_network_discovery_sessions ON public.network_discovery_sessions;
DROP TRIGGER shadow_device_inspection_sessions ON public.device_inspection_sessions;
DROP TRIGGER shadow_traffic_live_sessions ON public.traffic_live_sessions;
DROP TRIGGER shadow_traffic_live_snapshots ON public.traffic_live_snapshots;
DROP TRIGGER shadow_network_targets ON public.network_targets;
DROP TRIGGER shadow_network_health_latest ON public.network_health_latest;
DROP TRIGGER shadow_network_health_ping_jobs ON public.network_health_ping_jobs;
DROP TRIGGER shadow_events ON public.events;
DROP TRIGGER shadow_managed_device_latest ON public.managed_device_latest;
DROP TRIGGER shadow_managed_interface_latest ON public.managed_interface_latest;
DROP TRIGGER shadow_managed_observed_hosts_latest ON public.managed_observed_hosts_latest;
DROP TRIGGER shadow_profiles ON public.profiles;
DROP TRIGGER shadow_network_nodes ON public.network_nodes;
DROP TRIGGER shadow_managed_telemetry_targets ON public.managed_telemetry_targets;

INSERT INTO public.application_schema_migrations(version) VALUES (15);

RESET ROLE;
COMMIT;
