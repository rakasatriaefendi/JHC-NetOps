create extension if not exists pg_cron with schema pg_catalog;

create table public.traffic_live_sessions (
  id uuid primary key default gen_random_uuid(),
  runner_id text not null references public.diagnostic_runners (id),
  requested_by uuid not null references auth.users (id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'stopping', 'completed', 'failed', 'expired')),
  duration_seconds integer not null
    check (duration_seconds in (300, 600, 900, 1800)),
  capture_scope text not null default 'this_device'
    check (capture_scope = 'this_device'),
  stage text not null default 'queued'
    check (stage in ('queued', 'starting_wsl', 'capturing', 'stopping', 'complete', 'failed', 'expired')),
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  expires_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create unique index traffic_live_sessions_one_active_runner_idx
  on public.traffic_live_sessions (runner_id)
  where status in ('queued', 'running', 'stopping');
create index traffic_live_sessions_created_idx
  on public.traffic_live_sessions (created_at desc);

create table public.traffic_live_snapshots (
  runner_id text primary key references public.diagnostic_runners (id) on delete cascade,
  session_id uuid not null unique references public.traffic_live_sessions (id) on delete cascade,
  captured_at timestamptz not null,
  summary jsonb not null default '{}'::jsonb,
  flows jsonb not null default '[]'::jsonb,
  conversations jsonb not null default '[]'::jsonb,
  top_talkers jsonb not null default '[]'::jsonb,
  payload_bytes integer not null check (payload_bytes between 1 and 65536),
  updated_at timestamptz not null default now()
);

alter table public.flows
  add column runner_id text references public.diagnostic_runners (id) on delete set null,
  add column session_id uuid references public.traffic_live_sessions (id) on delete cascade,
  add column flow_key text,
  add column peak_rate_mbps double precision
    check (peak_rate_mbps is null or peak_rate_mbps >= 0);

create unique index flows_session_flow_key_idx
  on public.flows (session_id, flow_key);
create index flows_last_seen_idx on public.flows (last_seen);

alter table public.traffic_live_sessions enable row level security;
alter table public.traffic_live_snapshots enable row level security;

create policy "Approved users can read traffic live sessions"
on public.traffic_live_sessions for select to authenticated
using ((select public.is_approved()));

create policy "Approved users can read traffic live snapshots"
on public.traffic_live_snapshots for select to authenticated
using ((select public.is_approved()));

revoke all on public.traffic_live_sessions from anon, authenticated;
revoke all on public.traffic_live_snapshots from anon, authenticated;
grant select on public.traffic_live_sessions to authenticated;
grant select on public.traffic_live_snapshots to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'traffic_live_snapshots'
  ) then
    alter publication supabase_realtime add table public.traffic_live_snapshots;
  end if;
end;
$$;

create or replace function public.traffic_storage_status()
returns table (storage_mb numeric, status text)
language sql stable security definer set search_path = ''
as $$
  select
    round(pg_total_relation_size('public.flows'::regclass)::numeric / 1024 / 1024, 2),
    case
      when pg_total_relation_size('public.flows'::regclass) > 400 * 1024 * 1024 then 'critical'
      when pg_total_relation_size('public.flows'::regclass) > 300 * 1024 * 1024 then 'warning'
      else 'healthy'
    end;
$$;

create or replace function public.cleanup_traffic_telemetry()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  removed_flows integer := 0;
  removed_snapshots integer := 0;
  removed_sessions integer := 0;
begin
  with expired as (
    select id from public.flows
    where last_seen < now() - interval '48 hours'
    order by last_seen asc limit 5000
  )
  delete from public.flows where id in (select id from expired);
  get diagnostics removed_flows = row_count;

  delete from public.traffic_live_snapshots
  where captured_at < now() - interval '2 hours';
  get diagnostics removed_snapshots = row_count;

  with expired as (
    select id from public.traffic_live_sessions
    where status in ('completed', 'failed', 'expired')
      and coalesce(completed_at, updated_at) < now() - interval '7 days'
    order by coalesce(completed_at, updated_at) asc limit 500
  )
  delete from public.traffic_live_sessions where id in (select id from expired);
  get diagnostics removed_sessions = row_count;

  return jsonb_build_object(
    'flows', removed_flows,
    'snapshots', removed_snapshots,
    'sessions', removed_sessions
  );
end;
$$;

revoke all on function public.traffic_storage_status() from public;
revoke all on function public.cleanup_traffic_telemetry() from public;
grant execute on function public.traffic_storage_status() to service_role;
grant execute on function public.cleanup_traffic_telemetry() to service_role;

do $$
declare existing_job bigint;
begin
  select jobid into existing_job from cron.job where jobname = 'traffic-retention-cleanup';
  if existing_job is not null then perform cron.unschedule(existing_job); end if;
  perform cron.schedule(
    'traffic-retention-cleanup',
    '17 * * * *',
    'select public.cleanup_traffic_telemetry();'
  );
end;
$$;

comment on table public.traffic_live_snapshots is
  'Ephemeral bounded current Traffic state; one overwritten row per runner.';
comment on column public.flows.flow_key is
  'Stable directional 5-tuple hash scoped by traffic live session.';
