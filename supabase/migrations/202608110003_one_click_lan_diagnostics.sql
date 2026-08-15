create table public.diagnostic_runners (
  id text primary key,
  display_name text not null,
  last_seen_at timestamptz not null default now(),
  health_status text not null default 'degraded'
    check (health_status in ('online', 'degraded')),
  health_error_code text,
  capabilities jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.diagnostic_jobs (
  id uuid primary key default gen_random_uuid(),
  runner_id text not null references public.diagnostic_runners (id),
  requested_by uuid not null references auth.users (id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed', 'failed')),
  type text not null default 'bandwidth_and_path'
    check (type = 'bandwidth_and_path'),
  source_label text not null,
  target_id text not null,
  target_label text not null,
  target_host text not null,
  iperf_port integer not null
    check (iperf_port between 1 and 65535),
  connection_type text not null
    check (connection_type in ('wifi', 'ethernet')),
  duration_seconds integer not null
    check (duration_seconds between 1 and 60),
  environment text not null
    check (environment in ('lan', 'localhost_demo')),
  stage text not null default 'queued'
    check (
      stage in (
        'queued',
        'preparing_runner',
        'starting_wsl',
        'checking_target',
        'upload',
        'download',
        'mtr',
        'saving',
        'complete',
        'failed'
      )
    ),
  progress jsonb not null default '{}'::jsonb,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create unique index diagnostic_jobs_one_active_per_runner_idx
  on public.diagnostic_jobs (runner_id)
  where status in ('queued', 'running');

create index diagnostic_jobs_requested_created_idx
  on public.diagnostic_jobs (requested_by, created_at desc);

create index diagnostic_jobs_runner_created_idx
  on public.diagnostic_jobs (runner_id, created_at desc);

alter table public.bandwidth_measurements
  add column job_id uuid references public.diagnostic_jobs (id) on delete set null,
  add column direction text
    check (direction is null or direction in ('upload', 'download')),
  add column environment text
    check (environment is null or environment in ('lan', 'localhost_demo')),
  add column peak_mbps double precision
    check (peak_mbps is null or peak_mbps >= 0),
  add column minimum_mbps double precision
    check (minimum_mbps is null or minimum_mbps >= 0),
  add column transferred_mb double precision
    check (transferred_mb is null or transferred_mb >= 0),
  add column retransmits bigint
    check (retransmits is null or retransmits >= 0),
  add column duration_seconds double precision
    check (duration_seconds is null or duration_seconds > 0);

alter table public.hop_measurements
  add column job_id uuid references public.diagnostic_jobs (id) on delete set null,
  add column environment text
    check (environment is null or environment in ('lan', 'localhost_demo'));

create index bandwidth_measurements_job_direction_idx
  on public.bandwidth_measurements (job_id, direction);

create index hop_measurements_job_hop_idx
  on public.hop_measurements (job_id, session_id, hop_number);

alter table public.diagnostic_runners enable row level security;
alter table public.diagnostic_jobs enable row level security;

create policy "Approved users can read diagnostic runners"
on public.diagnostic_runners
for select
to authenticated
using ((select public.is_approved()));

create policy "Approved users can read diagnostic jobs"
on public.diagnostic_jobs
for select
to authenticated
using ((select public.is_approved()));

revoke all on public.diagnostic_runners from anon, authenticated;
revoke all on public.diagnostic_jobs from anon, authenticated;
grant select on public.diagnostic_runners to authenticated;
grant select on public.diagnostic_jobs to authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'diagnostic_runners'
  ) then
    alter publication supabase_realtime add table public.diagnostic_runners;
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'diagnostic_jobs'
  ) then
    alter publication supabase_realtime add table public.diagnostic_jobs;
  end if;
end;
$$;

comment on column public.diagnostic_jobs.progress is
  'Bounded temporary live state. Clear live_samples when a job finishes.';
comment on column public.bandwidth_measurements.bitrate_mbps is
  'Final average receiver throughput for the row direction.';
comment on column public.bandwidth_measurements.retransmits is
  'Sender-side TCP retransmits when iperf3 provides the value; otherwise NULL.';
