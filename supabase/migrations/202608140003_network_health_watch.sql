create table public.network_targets (
  id uuid primary key default gen_random_uuid(),
  node_id uuid not null references public.network_nodes (id) on delete cascade,
  runner_id text not null references public.diagnostic_runners (id) on delete cascade,
  enabled boolean not null default true,
  critical boolean not null default false,
  probe_method text not null default 'icmp'
    check (probe_method = 'icmp'),
  probe_interval_seconds integer not null default 30
    check (probe_interval_seconds between 15 and 3600),
  timeout_ms integer not null default 1000
    check (timeout_ms between 250 and 5000),
  failure_threshold integer not null default 3
    check (failure_threshold between 2 and 10),
  recovery_threshold integer not null default 2
    check (recovery_threshold between 1 and 5),
  latency_warning_ms double precision not null default 100
    check (latency_warning_ms between 1 and 60000),
  loss_warning_percent numeric(5, 2) not null default 40
    check (loss_warning_percent between 0 and 100),
  created_by uuid default auth.uid()
    references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (runner_id, node_id)
);

create table public.network_health_latest (
  target_id uuid primary key references public.network_targets (id) on delete cascade,
  status text not null
    check (status in ('online', 'degraded', 'offline')),
  latency_ms double precision
    check (latency_ms is null or latency_ms >= 0),
  packet_loss_percent numeric(5, 2) not null
    check (packet_loss_percent between 0 and 100),
  last_checked_at timestamptz not null,
  last_success_at timestamptz,
  consecutive_failures integer not null default 0
    check (consecutive_failures between 0 and 1000000),
  sample_count integer not null default 0
    check (sample_count between 0 and 5),
  updated_at timestamptz not null default now()
);

alter table public.events
  add column source text not null default 'network_metrics',
  add column source_ref uuid;

create index network_targets_runner_enabled_idx
  on public.network_targets (runner_id, enabled);
create index network_health_latest_checked_idx
  on public.network_health_latest (last_checked_at desc);
create index events_source_ref_created_idx
  on public.events (source, source_ref, created_at desc);

create trigger network_targets_set_updated_at
before update on public.network_targets
for each row execute function public.set_network_node_updated_at();

alter table public.network_targets enable row level security;
alter table public.network_health_latest enable row level security;

create policy "Approved users can read network targets"
on public.network_targets for select to authenticated
using ((select public.is_approved()));

create policy "Approved admins can create network targets"
on public.network_targets for insert to authenticated
with check (
  (select public.is_approved_admin())
  and (created_by is null or created_by = (select auth.uid()))
);

create policy "Approved admins can update network targets"
on public.network_targets for update to authenticated
using ((select public.is_approved_admin()))
with check ((select public.is_approved_admin()));

create policy "Approved admins can delete network targets"
on public.network_targets for delete to authenticated
using ((select public.is_approved_admin()));

create policy "Approved users can read latest network health"
on public.network_health_latest for select to authenticated
using ((select public.is_approved()));

revoke all on public.network_targets from anon, authenticated;
revoke all on public.network_health_latest from anon, authenticated;
grant select, insert, update, delete on public.network_targets to authenticated;
grant select on public.network_health_latest to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'network_health_latest'
  ) then
    alter publication supabase_realtime add table public.network_health_latest;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'events'
  ) then
    alter publication supabase_realtime add table public.events;
  end if;
end;
$$;

comment on table public.network_targets is
  'Explicit allow-list of known inventory nodes monitored by an existing Windows runner.';
comment on column public.network_targets.probe_method is
  'MVP accepts icmp only; SNMP is future scope and has no credentials or telemetry fields here.';
comment on table public.network_health_latest is
  'One coalesced current health row per monitored target; individual ping samples are not persisted.';
comment on column public.events.source is
  'Typed event origin. network_health is separate from network_metrics baseline/severity processing.';
