create table public.managed_telemetry_targets (
  id uuid primary key default gen_random_uuid(),
  node_id uuid not null references public.network_nodes (id) on delete cascade,
  runner_id text not null references public.diagnostic_runners (id) on delete cascade,
  enabled boolean not null default false,
  credential_profile_ref text not null
    check (char_length(btrim(credential_profile_ref)) between 1 and 64),
  snmp_version text not null default '3'
    check (snmp_version in ('3', '2c')),
  snmp_port integer not null default 161
    check (snmp_port between 1 and 65535),
  poll_interval_seconds integer not null default 60
    check (poll_interval_seconds in (30, 60)),
  oper_error_threshold integer not null default 5
    check (oper_error_threshold between 1 and 100),
  discard_threshold integer not null default 10
    check (discard_threshold between 1 and 100),
  util_warning_percent numeric(5, 2) not null default 80.00
    check (util_warning_percent between 1 and 100),
  util_critical_percent numeric(5, 2) not null default 95.00
    check (util_critical_percent between 1 and 100),
  util_sustained_seconds integer not null default 300
    check (util_sustained_seconds between 60 and 3600),
  created_by uuid default auth.uid()
    references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (runner_id, node_id)
);

create table public.managed_device_latest (
  target_id uuid primary key references public.managed_telemetry_targets (id) on delete cascade,
  status text not null
    check (status in ('connected', 'partial', 'auth_failed', 'timeout', 'unreachable', 'unsupported', 'poll_failed', 'not_configured')),
  sys_name text,
  sys_descr text,
  sys_object_id text,
  uptime_seconds bigint
    check (uptime_seconds is null or uptime_seconds >= 0),
  manufacturer text,
  model text,
  serial_number text,
  last_polled_at timestamptz,
  last_success_at timestamptz,
  consecutive_poll_failures integer not null default 0
    check (consecutive_poll_failures between 0 and 1000000),
  error_category text
    check (error_category is null or error_category in ('auth_failure', 'timeout', 'unreachable', 'unsupported', 'agent_error')),
  updated_at timestamptz not null default now()
);

create table public.managed_interface_latest (
  target_id uuid not null references public.managed_telemetry_targets (id) on delete cascade,
  if_index integer not null,
  name text,
  description text,
  if_type integer,
  is_physical boolean not null default false,
  admin_status text
    check (admin_status is null or admin_status in ('up', 'down', 'testing')),
  oper_status text
    check (oper_status is null or oper_status in ('up', 'down', 'testing', 'unknown')),
  speed_bps bigint
    check (speed_bps is null or speed_bps >= 0),
  rx_rate_bps numeric(12, 2)
    check (rx_rate_bps is null or rx_rate_bps >= 0),
  tx_rate_bps numeric(12, 2)
    check (tx_rate_bps is null or tx_rate_bps >= 0),
  rx_util_percent numeric(5, 2)
    check (rx_util_percent is null or (rx_util_percent between 0 and 100)),
  tx_util_percent numeric(5, 2)
    check (tx_util_percent is null or (tx_util_percent between 0 and 100)),
  rx_errors_cumulative bigint
    check (rx_errors_cumulative is null or rx_errors_cumulative >= 0),
  tx_errors_cumulative bigint
    check (tx_errors_cumulative is null or tx_errors_cumulative >= 0),
  in_discards_cumulative bigint
    check (in_discards_cumulative is null or in_discards_cumulative >= 0),
  out_discards_cumulative bigint
    check (out_discards_cumulative is null or out_discards_cumulative >= 0),
  rx_errors_delta integer
    check (rx_errors_delta is null or rx_errors_delta >= 0),
  tx_errors_delta integer
    check (tx_errors_delta is null or tx_errors_delta >= 0),
  in_discards_delta integer
    check (in_discards_delta is null or in_discards_delta >= 0),
  out_discards_delta integer
    check (out_discards_delta is null or out_discards_delta >= 0),
  last_polled_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (target_id, if_index)
);

alter table public.managed_telemetry_targets
  add column if not exists snmp2c_community_encrypted bytea;

create index managed_telemetry_targets_runner_idx
  on public.managed_telemetry_targets (runner_id, enabled);
create index managed_telemetry_targets_node_idx
  on public.managed_telemetry_targets (node_id);
create index managed_device_latest_polled_idx
  on public.managed_device_latest (last_polled_at desc);
create index managed_interface_latest_target_idx
  on public.managed_interface_latest (target_id, is_physical desc);
create index events_managed_source_idx
  on public.events (source, source_ref, created_at desc)
  where source = 'managed_telemetry';

create trigger managed_telemetry_targets_set_updated_at
  before update on public.managed_telemetry_targets
  for each row execute function public.set_network_node_updated_at();

create trigger managed_device_latest_set_updated_at
  before update on public.managed_device_latest
  for each row execute function public.set_network_node_updated_at();

create trigger managed_interface_latest_set_updated_at
  before update on public.managed_interface_latest
  for each row execute function public.set_network_node_updated_at();

alter table public.managed_telemetry_targets enable row level security;
alter table public.managed_device_latest enable row level security;
alter table public.managed_interface_latest enable row level security;

create policy "Approved users can read managed telemetry targets"
  on public.managed_telemetry_targets
  for select
  to authenticated
  using ((select public.is_approved()));

create policy "Approved admins can create managed telemetry targets"
  on public.managed_telemetry_targets
  for insert
  to authenticated
  with check (
    (select public.is_approved_admin())
    and (created_by is null or created_by = (select auth.uid()))
  );

create policy "Approved admins can update managed telemetry targets"
  on public.managed_telemetry_targets
  for update
  to authenticated
  using ((select public.is_approved_admin()))
  with check ((select public.is_approved_admin()));

create policy "Approved admins can delete managed telemetry targets"
  on public.managed_telemetry_targets
  for delete
  to authenticated
  using ((select public.is_approved_admin()));

create policy "Approved users can read managed device latest"
  on public.managed_device_latest
  for select
  to authenticated
  using ((select public.is_approved()));

create policy "Approved users can read managed interface latest"
  on public.managed_interface_latest
  for select
  to authenticated
  using ((select public.is_approved()));

revoke all on public.managed_telemetry_targets from anon, authenticated;
revoke all on public.managed_device_latest from anon, authenticated;
revoke all on public.managed_interface_latest from anon, authenticated;
grant select, insert, update, delete on public.managed_telemetry_targets to authenticated;
grant select on public.managed_device_latest to authenticated;
grant select on public.managed_interface_latest to authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'managed_device_latest'
  ) then
    alter publication supabase_realtime add table public.managed_device_latest;
  end if;
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'managed_interface_latest'
  ) then
    alter publication supabase_realtime add table public.managed_interface_latest;
  end if;
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'events'
  ) then
    alter publication supabase_realtime add table public.events;
  end if;
end;
$$;

comment on table public.managed_telemetry_targets is
  'Explicit allow-list of known inventory nodes for SNMP read-only telemetry. Browser cannot publish telemetry; service-role runner only. Secret credential values are never stored here — only a local runner credential_profile_ref.';
comment on column public.managed_telemetry_targets.credential_profile_ref is
  'Non-secret reference name resolved to local runner secrets. The browser never sees actual SNMP community/credentials.';
comment on column public.managed_telemetry_targets.snmp_version is
  '3 = SNMPv3 (default), 2c = SNMPv2c. Never auto-discovered.';
comment on column public.managed_telemetry_targets.snmp2c_community_encrypted is
  'Deprecated encrypted legacy placeholder for v2c communities. Actual secrets live in runner-local config. Never returned to browser or Edge Function.';
comment on table public.managed_device_latest is
  'One latest telemetry row per managed target — NOT one row per poll cycle. Cumulative counters are not persisted here; per-interface state lives in managed_interface_latest.';
comment on column public.managed_device_latest.status is
  'connected|partial|auth_failed|timeout|unreachable|unsupported|poll_failed|not_configured. NOT coupled to network_health status or traffic baseline severity.';
comment on table public.managed_interface_latest is
  'Current normalized state per interface index per managed target. Rate/utilization/delta fields, not raw counter history.';
comment on column public.managed_interface_latest.is_physical is
  'Conservative physical-port classification. VLAN*, Loopback*, Port-channel*, Tunnel* are non-physical even if ifType reports ethernet.';
comment on column public.events.source is
  'Extended to type managed_telemetry events separately from network_health and network_metrics baseline/severity processing.';
