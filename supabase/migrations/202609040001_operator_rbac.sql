alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('admin', 'operator', 'viewer'));

create or replace function public.can_operate_network()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid())
      and status = 'approved'
      and role in ('admin', 'operator')
  );
$$;

revoke all on function public.can_operate_network() from public;
grant execute on function public.can_operate_network() to authenticated;

drop policy if exists "Approved admins can update profiles" on public.profiles;
revoke update on public.profiles from authenticated;

create or replace function public.admin_update_profile_access(
  p_target_id uuid,
  p_role text,
  p_access_status text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := (select auth.uid());
  next_status text;
  target_role text;
  target_status text;
begin
  if not public.is_approved_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('admin', 'operator', 'viewer') then
    raise exception 'Invalid role' using errcode = '22023';
  end if;
  if p_access_status is null or p_access_status not in ('pending', 'active', 'suspended') then
    raise exception 'Invalid access status' using errcode = '22023';
  end if;

  next_status := case p_access_status
    when 'active' then 'approved'
    when 'suspended' then 'rejected'
    else 'pending'
  end;

  lock table public.profiles in share row exclusive mode;
  select role, status into target_role, target_status
  from public.profiles where id = p_target_id;
  if not found then
    raise exception 'Profile not found' using errcode = 'P0002';
  end if;

  if actor_id = p_target_id and (p_role <> 'admin' or next_status <> 'approved') then
    raise exception 'An active admin cannot remove their own access' using errcode = '23514';
  end if;
  if target_role = 'admin' and target_status = 'approved'
     and (p_role <> 'admin' or next_status <> 'approved')
     and (select count(*) from public.profiles where role = 'admin' and status = 'approved') <= 1 then
    raise exception 'The last active admin cannot be changed' using errcode = '23514';
  end if;

  update public.profiles set
    role = p_role,
    status = next_status,
    approved_at = case
      when next_status = 'approved' and target_status = 'approved' then approved_at
      when next_status = 'approved' then now()
      else null
    end,
    approved_by = case
      when next_status = 'approved' and target_status = 'approved' then approved_by
      when next_status = 'approved' then actor_id
      else null
    end
  where id = p_target_id;
  return p_target_id;
end;
$$;

revoke all on function public.admin_update_profile_access(uuid, text, text) from public;
grant execute on function public.admin_update_profile_access(uuid, text, text) to authenticated;

drop policy if exists "Approved admins can create network nodes" on public.network_nodes;
drop policy if exists "Approved admins can update network nodes" on public.network_nodes;
drop policy if exists "Approved admins can delete network nodes" on public.network_nodes;
create policy "Active operators can create network nodes" on public.network_nodes for insert to authenticated
with check ((select public.can_operate_network()) and (created_by is null or created_by = (select auth.uid())));
create policy "Active operators can update network nodes" on public.network_nodes for update to authenticated
using ((select public.can_operate_network())) with check ((select public.can_operate_network()));
create policy "Active operators can delete network nodes" on public.network_nodes for delete to authenticated
using ((select public.can_operate_network()));

drop policy if exists "Approved admins can create network targets" on public.network_targets;
drop policy if exists "Approved admins can update network targets" on public.network_targets;
drop policy if exists "Approved admins can delete network targets" on public.network_targets;
create policy "Active operators can create network targets" on public.network_targets for insert to authenticated
with check ((select public.can_operate_network()) and (created_by is null or created_by = (select auth.uid())));
create policy "Active operators can update network targets" on public.network_targets for update to authenticated
using ((select public.can_operate_network())) with check ((select public.can_operate_network()));
create policy "Active operators can delete network targets" on public.network_targets for delete to authenticated
using ((select public.can_operate_network()));

drop policy if exists "Approved admins can create managed telemetry targets" on public.managed_telemetry_targets;
drop policy if exists "Approved admins can update managed telemetry targets" on public.managed_telemetry_targets;
drop policy if exists "Approved admins can delete managed telemetry targets" on public.managed_telemetry_targets;
create policy "Active operators can create managed telemetry targets" on public.managed_telemetry_targets for insert to authenticated
with check ((select public.can_operate_network()) and (created_by is null or created_by = (select auth.uid())));
create policy "Active operators can update managed telemetry targets" on public.managed_telemetry_targets for update to authenticated
using ((select public.can_operate_network())) with check ((select public.can_operate_network()));
create policy "Active operators can delete managed telemetry targets" on public.managed_telemetry_targets for delete to authenticated
using ((select public.can_operate_network()));

drop policy if exists "Approved admins can read network discovery sessions" on public.network_discovery_sessions;
create policy "Active operators can read network discovery sessions" on public.network_discovery_sessions for select to authenticated
using ((select public.can_operate_network()));
drop policy if exists "Approved admins can read device inspection sessions" on public.device_inspection_sessions;
create policy "Active operators can read device inspection sessions" on public.device_inspection_sessions for select to authenticated
using ((select public.can_operate_network()));
drop policy if exists "Approved admins can read manual ping jobs" on public.network_health_ping_jobs;
create policy "Active operators can read manual ping jobs" on public.network_health_ping_jobs for select to authenticated
using ((select public.can_operate_network()));
