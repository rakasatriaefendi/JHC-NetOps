alter table public.diagnostic_runners
  add column preflight jsonb not null default '{}'::jsonb
    check (jsonb_typeof(preflight) = 'object');

alter table public.diagnostic_jobs
  add column network_context jsonb
    check (network_context is null or jsonb_typeof(network_context) = 'object'),
  add column route_context jsonb
    check (route_context is null or jsonb_typeof(route_context) = 'object'),
  add column preflight_context jsonb
    check (preflight_context is null or jsonb_typeof(preflight_context) = 'object');

comment on column public.diagnostic_runners.preflight is
  'Ephemeral single-slot authorized target preflight state. Never contains secrets or executable commands.';
comment on column public.diagnostic_jobs.network_context is
  'Bounded Windows host network snapshot captured for this diagnostic job.';
comment on column public.diagnostic_jobs.route_context is
  'Bounded Windows route-to-authorized-target snapshot captured for this diagnostic job.';
comment on column public.diagnostic_jobs.preflight_context is
  'Bounded gateway, target ICMP, and iperf3 TCP readiness observations captured before active measurement.';
