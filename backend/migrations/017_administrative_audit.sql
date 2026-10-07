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
     OR NOT EXISTS (SELECT 1 FROM public.application_schema_migrations WHERE version = 16)
     OR (SELECT max(version) FROM public.application_schema_migrations) <> 16
  THEN
    RAISE EXCEPTION 'Administrative audit requires migration 016 on PostgreSQL 16/jhcnetops:5433';
  END IF;
END $$;
SET ROLE jhc_netops_owner;

-- Fixed branding summaries only. No unrestricted metadata or resource/profile FK.
CREATE TABLE public.administrative_audit (
  id bigserial PRIMARY KEY,
  actor_id uuid NOT NULL,
  resource_type text NOT NULL CHECK (resource_type = 'report_branding'),
  resource_key text NOT NULL CHECK (resource_key = 'institution'),
  action text NOT NULL CHECK (action IN ('branding_identity_updated', 'branding_logo_updated', 'branding_logo_removed')),
  before_state jsonb NOT NULL,
  after_state jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT administrative_audit_summary_check CHECK (
    COALESCE(jsonb_typeof(before_state) = 'object' AND jsonb_typeof(after_state) = 'object'
    AND octet_length(before_state::text) <= 2048 AND octet_length(after_state::text) <= 2048
    AND before_state ?& ARRAY['institution_name','division_name','logo_available','logo_mime_type']
    AND after_state ?& ARRAY['institution_name','division_name','logo_available','logo_mime_type']
    AND before_state - ARRAY['institution_name','division_name','logo_available','logo_mime_type'] = '{}'::jsonb
    AND after_state - ARRAY['institution_name','division_name','logo_available','logo_mime_type'] = '{}'::jsonb
    AND jsonb_typeof(before_state->'institution_name') = 'string'
    AND jsonb_typeof(after_state->'institution_name') = 'string'
    AND length(before_state->>'institution_name') BETWEEN 1 AND 160
    AND length(after_state->>'institution_name') BETWEEN 1 AND 160
    AND jsonb_typeof(before_state->'division_name') = 'string'
    AND jsonb_typeof(after_state->'division_name') = 'string'
    AND length(before_state->>'division_name') <= 160 AND length(after_state->>'division_name') <= 160
    AND jsonb_typeof(before_state->'logo_available') = 'boolean'
    AND jsonb_typeof(after_state->'logo_available') = 'boolean'
    AND (before_state->'logo_mime_type' = 'null'::jsonb OR before_state->>'logo_mime_type' IN ('image/png','image/jpeg'))
    AND (after_state->'logo_mime_type' = 'null'::jsonb OR after_state->>'logo_mime_type' IN ('image/png','image/jpeg')), false)
  )
);
CREATE INDEX administrative_audit_time_idx ON public.administrative_audit(occurred_at DESC,id DESC);
CREATE INDEX administrative_audit_actor_time_idx ON public.administrative_audit(actor_id,occurred_at DESC);
REVOKE ALL ON public.administrative_audit FROM PUBLIC, jhc_netops_app;
REVOKE UPDATE, DELETE ON public.administrative_audit FROM jhc_netops_app;
GRANT SELECT, INSERT ON public.administrative_audit TO jhc_netops_app;
REVOKE ALL ON SEQUENCE public.administrative_audit_id_seq FROM PUBLIC, jhc_netops_app;
GRANT USAGE, SELECT ON SEQUENCE public.administrative_audit_id_seq TO jhc_netops_app;
INSERT INTO public.application_schema_migrations(version) VALUES (17);
RESET ROLE;
COMMIT;
