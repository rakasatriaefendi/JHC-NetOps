create table public.bandwidth_measurements (
  id uuid primary key default gen_random_uuid(),
  source_label text not null,
  target_label text not null,
  bitrate_mbps double precision not null
    check (bitrate_mbps >= 0),
  jitter_ms double precision
    check (jitter_ms is null or jitter_ms >= 0),
  measured_at timestamptz not null default now()
);

create table public.hop_measurements (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  hop_number integer not null
    check (hop_number > 0),
  hop_ip inet,
  avg_latency_ms double precision
    check (avg_latency_ms is null or avg_latency_ms >= 0),
  loss_percent double precision not null
    check (loss_percent between 0 and 100),
  measured_at timestamptz not null default now()
);

create index bandwidth_measurements_target_measured_at_idx
  on public.bandwidth_measurements (target_label, measured_at desc);

create index hop_measurements_session_hop_idx
  on public.hop_measurements (session_id, hop_number);

create index hop_measurements_measured_at_idx
  on public.hop_measurements (measured_at desc);

alter table public.bandwidth_measurements enable row level security;
alter table public.hop_measurements enable row level security;

create policy "Approved users can read bandwidth measurements"
on public.bandwidth_measurements
for select
to authenticated
using ((select public.is_approved()));

create policy "Approved users can read hop measurements"
on public.hop_measurements
for select
to authenticated
using ((select public.is_approved()));

revoke all on public.bandwidth_measurements from anon, authenticated;
revoke all on public.hop_measurements from anon, authenticated;
grant select on public.bandwidth_measurements to authenticated;
grant select on public.hop_measurements to authenticated;

