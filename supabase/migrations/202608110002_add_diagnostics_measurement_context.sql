alter table public.bandwidth_measurements
  add column target_host text,
  add column connection_type text
    check (connection_type is null or connection_type in ('wifi', 'ethernet'));

alter table public.hop_measurements
  add column source_label text,
  add column target_label text,
  add column target_host text,
  add column connection_type text
    check (connection_type is null or connection_type in ('wifi', 'ethernet'));

create index bandwidth_measurements_comparison_idx
  on public.bandwidth_measurements (
    target_label,
    connection_type,
    source_label,
    measured_at desc
  );

create index hop_measurements_context_idx
  on public.hop_measurements (
    target_label,
    connection_type,
    source_label,
    measured_at desc
  );

comment on column public.bandwidth_measurements.target_host is
  'Actual hostname or IP passed to iperf3. NULL only for legacy rows.';
comment on column public.bandwidth_measurements.connection_type is
  'Explicit client transport: wifi or ethernet. NULL only for legacy rows.';
comment on column public.hop_measurements.source_label is
  'Human-readable measurement location. Repeated for every hop in a session.';
comment on column public.hop_measurements.target_label is
  'Human-readable target label. Repeated for every hop in a session.';
comment on column public.hop_measurements.target_host is
  'Actual hostname or IP passed to mtr. Repeated for every hop in a session.';
comment on column public.hop_measurements.connection_type is
  'Explicit client transport: wifi or ethernet. NULL only for legacy rows.';
