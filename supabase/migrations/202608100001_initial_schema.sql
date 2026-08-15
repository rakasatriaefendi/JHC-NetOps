create extension if not exists pgcrypto;

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text,
  role text not null default 'viewer'
    check (role in ('admin', 'viewer')),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  approved_by uuid references public.profiles (id) on delete set null
);

create table public.traffic_metrics (
  id uuid primary key default gen_random_uuid(),
  recorded_at timestamptz not null default now(),
  interval_seconds integer not null,
  bytes_in bigint not null,
  bytes_out bigint not null,
  packet_count bigint not null,
  avg_latency_ms double precision,
  packet_loss_pct numeric(5, 2),
  gateway_reachable boolean not null,
  dns_reachable boolean not null,
  protocol_breakdown jsonb not null default '{}'::jsonb,
  status text not null
    check (status in ('normal', 'high_traffic', 'low_traffic', 'down', 'not_internet'))
);

create table public.flows (
  id uuid primary key default gen_random_uuid(),
  first_seen timestamptz not null,
  last_seen timestamptz not null,
  src_ip inet not null,
  dst_ip inet not null,
  src_port integer check (src_port between 0 and 65535),
  dst_port integer check (dst_port between 0 and 65535),
  protocol text not null,
  total_bytes bigint not null,
  packet_count bigint not null
);

create table public.events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  severity text not null
    check (severity in ('low', 'medium', 'high', 'critical')),
  title text not null,
  description text,
  raw_context jsonb not null default '{}'::jsonb,
  ai_summary text,
  resolved_at timestamptz
);

alter table public.profiles enable row level security;
alter table public.traffic_metrics enable row level security;
alter table public.flows enable row level security;
alter table public.events enable row level security;

create or replace function public.is_approved()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles
    where id = (select auth.uid())
      and status = 'approved'
  );
$$;

create or replace function public.is_approved_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles
    where id = (select auth.uid())
      and status = 'approved'
      and role = 'admin'
  );
$$;

create policy "Users can read their own profile"
on public.profiles
for select
to authenticated
using ((select auth.uid()) = id);

create policy "Approved admins can read all profiles"
on public.profiles
for select
to authenticated
using ((select public.is_approved_admin()));

create policy "Approved admins can update profiles"
on public.profiles
for update
to authenticated
using ((select public.is_approved_admin()))
with check ((select public.is_approved_admin()));

create policy "Approved users can read traffic metrics"
on public.traffic_metrics
for select
to authenticated
using ((select public.is_approved()));

create policy "Approved users can read flows"
on public.flows
for select
to authenticated
using ((select public.is_approved()));

create policy "Approved users can read events"
on public.events
for select
to authenticated
using ((select public.is_approved()));

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name, role, status)
  values (
    new.id,
    coalesce(new.email, ''),
    new.raw_user_meta_data ->> 'full_name',
    'viewer',
    'pending'
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

revoke all on function public.is_approved() from public;
revoke all on function public.is_approved_admin() from public;
revoke all on function public.handle_new_user() from public;
grant execute on function public.is_approved() to authenticated;
grant execute on function public.is_approved_admin() to authenticated;
grant select on public.profiles to authenticated;
grant update on public.profiles to authenticated;
grant select on public.traffic_metrics to authenticated;
grant select on public.flows to authenticated;
grant select on public.events to authenticated;
