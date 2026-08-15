do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'traffic_metrics'
  ) then
    alter publication supabase_realtime add table public.traffic_metrics;
  end if;
end;
$$;

