alter table public.network_nodes
  drop constraint network_nodes_device_type_check;

alter table public.network_nodes
  add constraint network_nodes_device_type_check
  check (
    device_type is null
    or device_type in (
      'gateway', 'router', 'layer3_switch', 'managed_switch', 'server',
      'firewall', 'access_point', 'workstation', 'printer', 'camera',
      'iot', 'phone', 'unknown', 'other'
    )
  ),
  add column detected_fingerprint jsonb,
  add column last_inspected_at timestamptz,
  add constraint network_nodes_detected_fingerprint_check
  check (
    detected_fingerprint is null
    or (
      jsonb_typeof(detected_fingerprint) = 'object'
      and octet_length(detected_fingerprint::text) <= 32768
      and detected_fingerprint ? 'ip'
      and detected_fingerprint->>'ip' = host(ip_address)
      and detected_fingerprint->>'confidence' in ('high', 'medium', 'low', 'unknown')
    )
  ),
  add constraint network_nodes_inspection_pair_check
  check (
    (detected_fingerprint is null and last_inspected_at is null)
    or (detected_fingerprint is not null and last_inspected_at is not null)
  );

comment on column public.network_nodes.detected_fingerprint is
  'Admin-persisted normalized Device Inspector evidence only (max 32 KiB). Raw tool output, HTML/XML/body, packet content, credentials, and secrets are prohibited.';
comment on column public.network_nodes.last_inspected_at is
  'Time of the fingerprint saved by an explicit admin action. Operator identity fields remain independent.';

create table public.device_inspection_sessions (
  runner_id text primary key references public.diagnostic_runners (id) on delete cascade,
  inspection_id uuid not null unique default gen_random_uuid(),
  requested_by uuid not null references public.profiles (id) on delete cascade,
  target_ip inet not null
    check (
      family(target_ip) = 4
      and masklen(target_ip) = 32
      and (
        target_ip << inet '10.0.0.0/8'
        or target_ip << inet '172.16.0.0/12'
        or target_ip << inet '192.168.0.0/16'
      )
    ),
  authorization_source text not null
    check (authorization_source in ('discovery', 'inventory')),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed', 'failed', 'expired')),
  stage text not null default 'validating_target'
    check (stage in (
      'validating_target', 'network_role', 'identity', 'services',
      'normalizing', 'complete'
    )),
  result jsonb
    check (
      result is null
      or (jsonb_typeof(result) = 'object' and octet_length(result::text) <= 65536)
    ),
  error_code text
    check (error_code is null or error_code ~ '^[A-Z0-9_]{1,64}$'),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  updated_at timestamptz not null default now()
);

create index device_inspection_sessions_expiry_idx
  on public.device_inspection_sessions (expires_at);

create trigger device_inspection_sessions_set_updated_at
before update on public.device_inspection_sessions
for each row execute function public.set_network_node_updated_at();

alter table public.device_inspection_sessions enable row level security;

create policy "Approved admins can read device inspection sessions"
on public.device_inspection_sessions for select to authenticated
using ((select public.is_approved_admin()));

revoke all on public.device_inspection_sessions from anon, authenticated;
grant select on public.device_inspection_sessions to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'device_inspection_sessions'
  ) then
    alter publication supabase_realtime add table public.device_inspection_sessions;
  end if;
end;
$$;

comment on table public.device_inspection_sessions is
  'One temporary overwrite-only Quick Device Inspector transport row per runner. It is not scan history and never creates inventory automatically.';
comment on column public.device_inspection_sessions.target_ip is
  'Private IPv4 host selected from current discovery results or existing inventory and revalidated by runner.';
comment on column public.device_inspection_sessions.result is
  'Bounded normalized fingerprint only (max 64 KiB). Raw tool output and application content are prohibited.';
