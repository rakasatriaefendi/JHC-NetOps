create table public.network_health_ping_jobs (
  id uuid primary key default gen_random_uuid(),
  target_id uuid not null references public.network_targets (id) on delete cascade,
  runner_id text not null references public.diagnostic_runners (id) on delete cascade,
  requested_by uuid not null references auth.users (id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed', 'failed')),
  result jsonb
    check (
      result is null
      or (
        jsonb_typeof(result) = 'object'
        and octet_length(result::text) <= 1024
      )
    ),
  error_code text
    check (
      error_code is null
      or error_code in (
        'MANUAL_PING_FAILED',
        'MANUAL_PING_TARGET_UNAVAILABLE'
      )
    ),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz not null default (now() + interval '30 seconds'),
  updated_at timestamptz not null default now()
);

create unique index network_health_ping_jobs_one_active_target_idx
  on public.network_health_ping_jobs (target_id)
  where status in ('queued', 'running');

create index network_health_ping_jobs_runner_queue_idx
  on public.network_health_ping_jobs (runner_id, status, created_at);

alter table public.network_health_ping_jobs enable row level security;

create policy "Approved admins can read manual ping jobs"
on public.network_health_ping_jobs
for select
to authenticated
using ((select public.is_approved_admin()));

revoke all on public.network_health_ping_jobs from anon, authenticated;
grant select on public.network_health_ping_jobs to authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'network_health_ping_jobs'
  ) then
    alter publication supabase_realtime add table public.network_health_ping_jobs;
  end if;
end;
$$;

comment on table public.network_health_ping_jobs is
  'Short-lived admin-requested one-shot ICMP jobs. Results are diagnostic UI state and never scheduled Health Watch history.';

comment on column public.network_health_ping_jobs.result is
  'Bounded normalized result only: success latency or timeout/unreachable category. Never raw stdout/stderr.';
