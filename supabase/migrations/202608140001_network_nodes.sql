create table public.network_nodes (
  id uuid primary key default gen_random_uuid(),
  ip_address inet not null unique
    check (masklen(ip_address) in (32, 128)),
  name text not null
    check (char_length(btrim(name)) between 1 and 200),
  device_type text
    check (
      device_type is null
      or device_type in (
        'gateway',
        'router',
        'layer3_switch',
        'server',
        'firewall',
        'access_point',
        'other'
      )
    ),
  location text
    check (location is null or char_length(location) <= 200),
  notes text
    check (notes is null or char_length(notes) <= 2000),
  created_by uuid default auth.uid()
    references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.network_nodes is
  'Manual reusable inventory labels for Layer-3 IPs observed in diagnostic paths.';
comment on column public.network_nodes.ip_address is
  'Host IP only; labels are resolved dynamically and are never copied into hop_measurements.';
comment on column public.network_nodes.notes is
  'Inventory notes only. Credentials, secrets, packet data, and SNMP community strings are prohibited.';

create or replace function public.set_network_node_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger network_nodes_set_updated_at
before update on public.network_nodes
for each row execute function public.set_network_node_updated_at();

alter table public.network_nodes enable row level security;

create policy "Approved users can read network nodes"
on public.network_nodes
for select
to authenticated
using ((select public.is_approved()));

create policy "Approved admins can create network nodes"
on public.network_nodes
for insert
to authenticated
with check (
  (select public.is_approved_admin())
  and (created_by is null or created_by = (select auth.uid()))
);

create policy "Approved admins can update network nodes"
on public.network_nodes
for update
to authenticated
using ((select public.is_approved_admin()))
with check ((select public.is_approved_admin()));

create policy "Approved admins can delete network nodes"
on public.network_nodes
for delete
to authenticated
using ((select public.is_approved_admin()));

revoke all on public.network_nodes from anon, authenticated;
grant select, insert, update, delete on public.network_nodes to authenticated;

revoke all on function public.set_network_node_updated_at() from public;

