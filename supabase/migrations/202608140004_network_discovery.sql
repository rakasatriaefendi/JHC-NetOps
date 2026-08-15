alter table public.network_nodes
  drop constraint network_nodes_device_type_check;

alter table public.network_nodes
  add constraint network_nodes_device_type_check
  check (
    device_type is null
    or device_type in (
      'gateway',
      'router',
      'layer3_switch',
      'server',
      'firewall',
      'access_point',
      'workstation',
      'printer',
      'other'
    )
  );

create table public.network_discovery_sessions (
  runner_id text primary key references public.diagnostic_runners (id) on delete cascade,
  session_id uuid not null unique default gen_random_uuid(),
  requested_by uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'queued'
    check (status in ('idle', 'queued', 'running', 'completed', 'failed', 'expired')),
  phase text not null default 'prepare'
    check (phase in ('prepare', 'scan')),
  connection_type text
    check (connection_type is null or connection_type in ('wifi', 'ethernet', 'unknown')),
  interface_alias text
    check (interface_alias is null or char_length(interface_alias) between 1 and 256),
  local_ipv4 inet
    check (local_ipv4 is null or masklen(local_ipv4) = 32),
  subnet_cidr cidr,
  total_hosts integer not null default 0
    check (total_hosts between 0 and 254),
  scanned_hosts integer not null default 0
    check (scanned_hosts between 0 and 254),
  found_count integer not null default 0
    check (found_count between 0 and 254),
  results jsonb not null default '[]'::jsonb
    check (jsonb_typeof(results) = 'array' and jsonb_array_length(results) <= 254),
  error_code text
    check (error_code is null or error_code ~ '^[A-Z0-9_]{1,64}$'),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  updated_at timestamptz not null default now()
);

create index network_discovery_expiry_idx
  on public.network_discovery_sessions (expires_at);

create trigger network_discovery_sessions_set_updated_at
before update on public.network_discovery_sessions
for each row execute function public.set_network_node_updated_at();

alter table public.network_discovery_sessions enable row level security;

create policy "Approved admins can read network discovery sessions"
on public.network_discovery_sessions for select to authenticated
using ((select public.is_approved_admin()));

revoke all on public.network_discovery_sessions from anon, authenticated;
grant select on public.network_discovery_sessions to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'network_discovery_sessions'
  ) then
    alter publication supabase_realtime add table public.network_discovery_sessions;
  end if;
end;
$$;

comment on table public.network_discovery_sessions is
  'One bounded, temporary, overwrite-only discovery transport row per runner. It is not inventory or scan history.';
comment on column public.network_discovery_sessions.results is
  'Bounded host metadata for the current on-demand session only; never packet payloads, ports, services, or OS data.';
comment on column public.network_discovery_sessions.subnet_cidr is
  'Runner-detected and runner-validated current Windows subnet. The browser cannot supply this value.';
