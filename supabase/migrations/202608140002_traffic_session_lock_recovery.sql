create or replace function public.expire_stale_traffic_sessions(p_runner_id text default null)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  expired_count integer := 0;
begin
  update public.traffic_live_sessions
  set status = 'expired',
      stage = 'expired',
      completed_at = now(),
      updated_at = now(),
      error_code = 'SESSION_ORPHANED',
      error_message = 'Traffic session lost its runner lease and was recovered automatically'
  where (p_runner_id is null or runner_id = p_runner_id)
    and (
      (status = 'queued' and created_at < now() - interval '10 minutes')
      or (
        status = 'stopping'
        and (
          started_at is null
          or expires_at < now()
          or updated_at < now() - interval '30 seconds'
        )
      )
      or (
        status = 'running'
        and (
          expires_at < now()
          or updated_at < now() - interval '45 seconds'
        )
      )
    );
  get diagnostics expired_count = row_count;
  return expired_count;
end;
$$;

revoke all on function public.expire_stale_traffic_sessions(text) from public;
grant execute on function public.expire_stale_traffic_sessions(text) to service_role;

create or replace function public.cleanup_traffic_telemetry()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  expired_active integer := 0;
  removed_flows integer := 0;
  removed_snapshots integer := 0;
  removed_sessions integer := 0;
begin
  expired_active := public.expire_stale_traffic_sessions(null);

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
    'expired_active', expired_active,
    'flows', removed_flows,
    'snapshots', removed_snapshots,
    'sessions', removed_sessions
  );
end;
$$;

comment on function public.expire_stale_traffic_sessions(text) is
  'Releases orphaned bounded Traffic locks. Running sessions renew their lease through live snapshots.';
