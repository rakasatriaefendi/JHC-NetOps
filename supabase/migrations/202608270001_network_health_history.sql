  create table public.network_health_samples (
    id bigserial primary key,
    target_id uuid not null references public.network_targets (id) on delete cascade,
    sampled_at timestamptz not null
      check (sampled_at = date_trunc('minute', sampled_at)),
    status text not null
      check (status in ('online', 'degraded', 'offline')),
    latency_ms double precision
      check (latency_ms is null or latency_ms >= 0),
    packet_loss_percent numeric(5, 2) not null
      check (packet_loss_percent between 0 and 100),
    -- Health Watch sample_count (rolling window count), not individual probes
    sample_count integer not null default 1
      check (sample_count between 1 and 5),
    unique (target_id, sampled_at)
  );

  create index network_health_samples_target_time_idx
    on public.network_health_samples (target_id, sampled_at desc);

  create index network_health_samples_time_idx
    on public.network_health_samples (sampled_at desc);

  alter table public.network_health_samples enable row level security;

  create policy "Approved users can read health samples"
  on public.network_health_samples for select to authenticated
  using ((select public.is_approved()));

  revoke all on public.network_health_samples from anon, authenticated;
  grant select on public.network_health_samples to authenticated;

  comment on table public.network_health_samples is
    'Bounded, coalesced health samples for trend visualization. One row per target per UTC minute bucket. Max ~10080 rows per target (7 days × 1440 minutes).';

  comment on column public.network_health_samples.sample_count is
    'Health Watch rolling sample_count coalesced into this minute bucket (typically 1 per minute). Not individual ICMP probes.';

  create or replace function public.cleanup_network_health_samples()
  returns void
  language plpgsql
  security definer
  set search_path = ''
  as $$
  declare
    retention_days int := 7;
    max_samples_per_target int := 10080;
  begin
    delete from public.network_health_samples
    where sampled_at < now() - (retention_days || ' days')::interval;

    delete from public.network_health_samples nhs
    where nhs.id in (
      select id from (
        select id,
              row_number() over (partition by target_id order by sampled_at desc) as rn
        from public.network_health_samples
      ) sub
      where sub.rn > max_samples_per_target
    );
  end;
  $$;

  comment on function public.cleanup_network_health_samples() is
    'Removes samples older than 7 days and enforces max 10080 samples per target.';

  revoke execute on function public.cleanup_network_health_samples() from public, anon, authenticated;

  -- Schedule automatic cleanup via pg_cron (runs daily at 03:17)
  -- Mirrors the traffic-retention-cleanup pattern
  do $$
  declare
    existing_job bigint;
  begin
    select jobid into existing_job from cron.job where jobname = 'network-health-samples-cleanup';
    if existing_job is not null then perform cron.unschedule(existing_job); end if;
    perform cron.schedule(
      'network-health-samples-cleanup',
      '17 3 * * *',
      'select public.cleanup_network_health_samples();'
    );
  end;
  $$;

  -- Function to get downsampled health samples across full time range
  -- Returns at most p_limit buckets PER TARGET
  create or replace function public.get_health_samples_downsampled(
    p_target_ids uuid[],
    p_since timestamptz,
    p_bucket_seconds int,
    p_limit int default 480
  )
  returns table (
    target_id uuid,
    sampled_at timestamptz,
    status text,
    latency_ms double precision,
    packet_loss_percent numeric,
    sample_count bigint
  )
  language sql
  security invoker
  set search_path = ''
  as $$
    with params as (
      select
        least(greatest(p_bucket_seconds, 60), 3600) as bucket_seconds,
        least(greatest(p_limit, 1), 480) as max_per_target,
        least(greatest(p_since, now() - interval '7 days'), now()) as since_ts,
        case when array_length(p_target_ids, 1) > 200 then 200 else array_length(p_target_ids, 1) end as max_targets
    ),
    validated_targets as (
      select distinct target_id
      from unnest(p_target_ids) as t(target_id)
      where target_id is not null
      limit (select max_targets from params)
    ),
    raw as (
      select
        nhs.target_id,
        nhs.sampled_at,
        nhs.status,
        nhs.latency_ms,
        nhs.packet_loss_percent,
        nhs.sample_count,
        floor(extract(epoch from nhs.sampled_at) / params.bucket_seconds) as bucket_idx
      from public.network_health_samples nhs
      inner join validated_targets vt on vt.target_id = nhs.target_id
      cross join params
      where nhs.sampled_at >= params.since_ts
        and nhs.sampled_at <= now()
    ),
    per_bucket as (
      select
        target_id,
        bucket_idx,
        -- Latest status in bucket (by sampled_at desc)
        (array_agg(status order by sampled_at desc))[1] as status,
        avg(latency_ms) as latency_ms,
        avg(packet_loss_percent) as packet_loss_percent,
        sum(sample_count) as sample_count,
        min(sampled_at) as bucket_start_raw
      from raw
      group by target_id, bucket_idx
    ),
    numbered as (
      select
        target_id,
        to_timestamp(bucket_idx * params.bucket_seconds) as bucket_start,
        status,
        latency_ms,
        packet_loss_percent,
        sample_count,
        params.max_per_target,
        row_number() over (
          partition by target_id
          order by bucket_idx
        ) as rn
      from per_bucket
      cross join params
    )
    select
      target_id,
      bucket_start as sampled_at,
      status,
      latency_ms,
      packet_loss_percent,
      sample_count
    from numbered
    where rn <= max_per_target
    order by target_id, sampled_at asc;
  $$;

  revoke execute on function public.get_health_samples_downsampled(uuid[], timestamptz, int, int) from public, anon;
  grant execute on function public.get_health_samples_downsampled(uuid[], timestamptz, int, int) to authenticated;

  -- Note: coalesced_sample_count on network_health_latest removed - unused