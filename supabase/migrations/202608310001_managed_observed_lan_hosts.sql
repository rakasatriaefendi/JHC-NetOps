alter table public.managed_device_latest
  add column if not exists observed_hosts_status text not null default 'unsupported'
  check (observed_hosts_status in ('available', 'empty', 'partial', 'unsupported'));

create table if not exists public.managed_observed_hosts_latest (
  target_id uuid not null references public.managed_telemetry_targets(id) on delete cascade,
  node_id uuid references public.network_nodes(id) on delete set null,
  ip_address inet not null,
  mac_address macaddr,
  netbios_name text check (netbios_name is null or char_length(netbios_name) between 1 and 15),
  observation_source text not null check (observation_source in ('ip_net_to_physical', 'ip_net_to_media')),
  enrichment_status text not null check (enrichment_status in ('resolved', 'unavailable', 'not_attempted')),
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  status text not null check (status in ('current', 'stale')),
  updated_at timestamptz not null default now(),
  primary key (target_id, ip_address),
  check (mac_address is null or mac_address <> '00:00:00:00:00:00'::macaddr)
);

comment on table public.managed_observed_hosts_latest is
  'Read-only latest Layer-3 neighbor evidence from a managed SNMP target. Rows do not prove physical port attachment.';
comment on column public.managed_observed_hosts_latest.netbios_name is
  'Best-effort NetBIOS workstation-name enrichment for an IP already observed through SNMP; never inventory membership evidence.';

create index if not exists managed_observed_hosts_node_idx
  on public.managed_observed_hosts_latest(node_id) where node_id is not null;
create index if not exists managed_observed_hosts_freshness_idx
  on public.managed_observed_hosts_latest(target_id, status, last_seen_at desc);

alter table public.managed_observed_hosts_latest enable row level security;

create policy managed_observed_hosts_approved_read
  on public.managed_observed_hosts_latest for select to authenticated
  using ((select public.is_approved()));

revoke all on public.managed_observed_hosts_latest from anon, authenticated;
grant select on public.managed_observed_hosts_latest to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'managed_observed_hosts_latest'
  ) then
    alter publication supabase_realtime add table public.managed_observed_hosts_latest;
  end if;
end $$;
