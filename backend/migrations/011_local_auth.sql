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
     OR to_regclass('public.profiles') IS NULL
     OR to_regclass('public.application_schema_migrations') IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.application_schema_migrations WHERE version = 10)
  THEN
    RAISE EXCEPTION 'P14 local auth migration requires migration 010 on PostgreSQL 16/jhcnetops:5433';
  END IF;
END $$;

SET ROLE jhc_netops_owner;

CREATE TABLE public.local_auth_credentials (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  email text NOT NULL UNIQUE CHECK (
    email = lower(btrim(email)) AND char_length(email) BETWEEN 3 AND 320
    AND email !~ '[[:cntrl:]]' AND email LIKE '%@%'
  ),
  password_record text NOT NULL CHECK (
    char_length(password_record) BETWEEN 100 AND 512
    AND password_record LIKE 'scrypt$v1$%'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.local_auth_sessions (
  token_digest bytea PRIMARY KEY CHECK (octet_length(token_digest) = 32),
  user_id uuid NOT NULL REFERENCES public.local_auth_credentials(user_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '7 days'
  )
);

CREATE INDEX local_auth_sessions_user_expiry_idx
  ON public.local_auth_sessions(user_id, expires_at);
CREATE INDEX local_auth_sessions_expiry_idx
  ON public.local_auth_sessions(expires_at);

GRANT SELECT,INSERT,UPDATE,DELETE ON public.local_auth_credentials TO jhc_netops_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.local_auth_sessions TO jhc_netops_app;

INSERT INTO public.application_schema_migrations(version) VALUES (11);

RESET ROLE;
COMMIT;
