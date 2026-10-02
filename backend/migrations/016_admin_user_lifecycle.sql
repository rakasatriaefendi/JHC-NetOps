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
     OR NOT EXISTS (SELECT 1 FROM public.application_schema_migrations WHERE version = 15)
     OR (SELECT max(version) FROM public.application_schema_migrations) <> 15
  THEN
    RAISE EXCEPTION 'Admin lifecycle migration requires migration 015 on PostgreSQL 16/jhcnetops:5433';
  END IF;
END $$;

SET ROLE jhc_netops_owner;

ALTER TABLE public.profiles
  DROP CONSTRAINT profiles_status_check,
  ADD CONSTRAINT profiles_status_check CHECK (status IN ('pending', 'approved', 'rejected', 'disabled')),
  ADD COLUMN disabled_at timestamptz,
  ADD COLUMN disabled_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT profiles_disabled_consistency_check CHECK (
    (status = 'disabled' AND disabled_at IS NOT NULL)
    OR (status <> 'disabled' AND disabled_at IS NULL AND disabled_by IS NULL)
  );

-- SET NULL also requires nullable requester columns. Existing history is retained.
ALTER TABLE public.device_inspection_sessions
  DROP CONSTRAINT device_inspection_sessions_requested_by_fkey,
  ALTER COLUMN requested_by DROP NOT NULL,
  ADD CONSTRAINT device_inspection_sessions_requested_by_fkey
    FOREIGN KEY (requested_by) REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE public.network_discovery_sessions
  DROP CONSTRAINT network_discovery_sessions_requested_by_fkey,
  ALTER COLUMN requested_by DROP NOT NULL,
  ADD CONSTRAINT network_discovery_sessions_requested_by_fkey
    FOREIGN KEY (requested_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- Deliberately no profile FK: deletion cannot erase audit identities.
CREATE TABLE public.account_lifecycle_audit (
  id bigserial PRIMARY KEY,
  actor_id uuid,
  target_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN (
    'access_changed', 'account_disabled', 'account_reenabled', 'account_deleted'
  )),
  previous_role text CHECK (previous_role IN ('admin', 'operator', 'viewer')),
  next_role text CHECK (next_role IN ('admin', 'operator', 'viewer')),
  previous_status text CHECK (previous_status IN ('pending', 'approved', 'rejected', 'disabled')),
  next_status text CHECK (next_status IN ('pending', 'approved', 'rejected', 'disabled')),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_lifecycle_audit_target_time_idx
  ON public.account_lifecycle_audit(target_id, occurred_at DESC);
CREATE INDEX account_lifecycle_audit_actor_time_idx
  ON public.account_lifecycle_audit(actor_id, occurred_at DESC);

-- Override inherited default grants: runtime can append/read, never rewrite.
REVOKE ALL ON public.account_lifecycle_audit FROM PUBLIC, jhc_netops_app;
GRANT SELECT, INSERT ON public.account_lifecycle_audit TO jhc_netops_app;
REVOKE ALL ON SEQUENCE public.account_lifecycle_audit_id_seq FROM PUBLIC, jhc_netops_app;
GRANT USAGE, SELECT ON SEQUENCE public.account_lifecycle_audit_id_seq TO jhc_netops_app;

INSERT INTO public.application_schema_migrations(version) VALUES (16);
RESET ROLE;
COMMIT;
