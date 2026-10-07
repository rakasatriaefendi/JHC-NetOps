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
     OR NOT EXISTS (SELECT 1 FROM public.application_schema_migrations WHERE version = 17)
     OR (SELECT max(version) FROM public.application_schema_migrations) <> 17
  THEN
    RAISE EXCEPTION 'SNMP monitoring intervals require migration 017 on PostgreSQL 16/jhcnetops:5433';
  END IF;

  -- Migration 007's unnamed column CHECK receives this PostgreSQL-generated name.
  -- Verify it belongs to exactly the reviewed table/column before replacing it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attname='poll_interval_seconds'
    WHERE c.conrelid=to_regclass('public.managed_telemetry_targets')
      AND c.conname='managed_telemetry_targets_poll_interval_seconds_check'
      AND c.contype='c' AND c.conkey=ARRAY[a.attnum]::smallint[]
  ) THEN
    RAISE EXCEPTION 'Reviewed SNMP poll interval constraint is missing';
  END IF;
END $$;
SET ROLE jhc_netops_owner;
ALTER TABLE public.managed_telemetry_targets
  DROP CONSTRAINT managed_telemetry_targets_poll_interval_seconds_check,
  ADD CONSTRAINT managed_telemetry_targets_poll_interval_seconds_check
    CHECK (poll_interval_seconds IN (15,30,60,900,1800));
INSERT INTO public.application_schema_migrations(version) VALUES (18);
RESET ROLE;
COMMIT;
