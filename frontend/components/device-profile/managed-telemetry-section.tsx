"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  MANAGED_TELEMETRY_STATUS_LABELS,
  credentialProfileStatus,
  formatDateTime,
  formatRate,
  formatUptime,
  formatUtil,
  interfaceSummary,
  interfaceWarnings,
  type ManagedDeviceLatest,
  type ManagedInterfaceLatest,
  type ManagedTelemetryEvent,
  type ManagedTelemetryTarget,
  type ManagedTelemetryThresholds,
} from "@/lib/managed-telemetry";
import { createClient } from "@/lib/supabase/client";

const STATUS_STYLE: Record<string, string> = {
  connected: "bg-severity-low/10 text-severity-low",
  partial: "bg-severity-medium/10 text-severity-medium",
  auth_failed: "bg-severity-critical/10 text-severity-critical",
  timeout: "bg-severity-medium/10 text-severity-medium",
  unreachable: "bg-severity-critical/10 text-severity-critical",
  unsupported: "bg-text-muted/10 text-text-muted",
  poll_failed: "bg-severity-critical/10 text-severity-critical",
  not_configured: "bg-text-muted/10 text-text-muted",
};

type Props = { nodeId: string; runnerProfiles: { runnerId: string; profiles: string[] }[] };

export function ManagedTelemetrySection({ nodeId, runnerProfiles }: Props) {
  const [target, setTarget] = useState<ManagedTelemetryTarget | null>(null);
  const [device, setDevice] = useState<ManagedDeviceLatest | null>(null);
  const [rows, setRows] = useState<ManagedInterfaceLatest[]>([]);
  const [events, setEvents] = useState<ManagedTelemetryEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const pending = useRef<Record<number, ManagedInterfaceLatest>>({});
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!nodeId) return;
    let cancelled = false;
    const supabase = createClient();
    void (async () => {
      try {
        const { data, error: targetError } = await supabase.from("managed_telemetry_targets")
          .select("id,node_id,runner_id,enabled,credential_profile_ref,snmp_version,snmp_port,poll_interval_seconds,oper_error_threshold,discard_threshold,util_warning_percent,util_critical_percent,util_sustained_seconds")
          .eq("node_id", nodeId).eq("enabled", true).limit(1).maybeSingle();
        if (cancelled) return;
        if (targetError || !data) { setLoading(false); return; }
        setTarget(data as ManagedTelemetryTarget);
        const [{ data: latest }, { data: interfaceRows }, { data: eventRows }] = await Promise.all([
          supabase.from("managed_device_latest").select("*").eq("target_id", data.id).maybeSingle(),
          supabase.from("managed_interface_latest").select("*").eq("target_id", data.id),
          supabase.from("events").select("id,created_at,severity,title,description,source_ref,resolved_at,raw_context").eq("source", "managed_telemetry").eq("source_ref", data.id).order("created_at", { ascending: false }).limit(20),
        ]);
        if (cancelled) return;
        setDevice((latest as ManagedDeviceLatest) ?? null);
        setRows((interfaceRows as ManagedInterfaceLatest[]) ?? []);
        setEvents((eventRows as ManagedTelemetryEvent[]) ?? []);
        setLoading(false);
      } catch {
        if (!cancelled) { setError(true); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [nodeId]);

  const thresholds = useMemo<ManagedTelemetryThresholds | null>(() => target ? {
    oper_error_threshold: target.oper_error_threshold,
    discard_threshold: target.discard_threshold,
    util_warning_percent: Number(target.util_warning_percent),
    util_critical_percent: Number(target.util_critical_percent),
    util_sustained_seconds: target.util_sustained_seconds,
  } : null, [target]);

  const summarized = useMemo(() => interfaceSummary(rows), [rows]);

  useEffect(() => {
    if (!target) return;
    const supabase = createClient();
    const mergeInterfaces = () => {
      const keys = Object.keys(pending.current).map(Number);
      if (!keys.length) return;
      const snapshot = { ...pending.current };
      pending.current = {};
      setRows((current) => {
        const byIndex = new Map(current.map((row) => [row.if_index, row]));
        for (const key of keys) byIndex.set(key, snapshot[key]);
        return [...byIndex.values()].sort((a, b) => a.if_index - b.if_index);
      });
    };
    const scheduleFlush = () => {
      if (flushTimer.current) clearTimeout(flushTimer.current);
      flushTimer.current = setTimeout(mergeInterfaces, 50);
    };
    const channel = supabase.channel(`managed-telemetry:${target.id}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "managed_device_latest", filter: `target_id=eq.${target.id}` }, (payload) => {
        setDevice(payload.new as ManagedDeviceLatest);
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "managed_device_latest", filter: `target_id=eq.${target.id}` }, (payload) => {
        setDevice(payload.new as ManagedDeviceLatest);
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "managed_interface_latest", filter: `target_id=eq.${target.id}` }, (payload) => {
        pending.current[(payload.new as ManagedInterfaceLatest).if_index] = payload.new as ManagedInterfaceLatest;
        scheduleFlush();
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "managed_interface_latest", filter: `target_id=eq.${target.id}` }, (payload) => {
        pending.current[(payload.new as ManagedInterfaceLatest).if_index] = payload.new as ManagedInterfaceLatest;
        scheduleFlush();
      })
      .subscribe();
    return () => {
      if (flushTimer.current) clearTimeout(flushTimer.current);
      void supabase.removeChannel(channel);
    };
  }, [target, thresholds]);

  if (!nodeId) return null;
  if (loading) return <Section><p className="text-text-secondary">Loading telemetry…</p></Section>;
  if (!target) return <Section><p className="font-medium">Not configured</p><p className="mt-2 text-text-secondary">Managed infrastructure telemetry is not configured for this inventory node.</p></Section>;
  if (error) return <Section><p className="text-severity-critical">Telemetry data could not be loaded.</p></Section>;

  const profile = runnerProfiles.find((item) => item.runnerId === target.runner_id);
  const profileStatus = credentialProfileStatus(profile?.profiles, target.credential_profile_ref);
  const status = device?.status ?? "not_configured";
  const physicalDown = summarized.physical_down;

  return <Section title="Management telemetry">
    <div className="flex flex-wrap items-center gap-3">
      <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-meta font-medium ${STATUS_STYLE[status]}`}>● {MANAGED_TELEMETRY_STATUS_LABELS[status]}</span>
      <span className="text-meta text-text-secondary">SNMPv{target.snmp_version} · port {target.snmp_port} · every {target.poll_interval_seconds}s</span>
      <span className={`text-meta ${profileStatus === "available" ? "text-text-secondary" : "text-severity-medium"}`}>{profileStatus === "available" ? "Credential profile available" : profileStatus === "unavailable" ? "Credential profile unavailable" : "Credential profile availability unknown"}</span>
    </div>
    {device?.consecutive_poll_failures && device.consecutive_poll_failures > 0 ? <p className="mt-3 text-meta text-severity-medium">{device.consecutive_poll_failures} consecutive poll failures</p> : null}
    <dl className="mt-4 grid gap-3 sm:grid-cols-2">
      <Value label="Last poll" value={formatDateTime(device?.last_polled_at ?? null)} data />
      <Value label="Last success" value={formatDateTime(device?.last_success_at ?? null)} data />
      <Value label="Uptime" value={formatUptime(device?.uptime_seconds ?? null)} data />
      <Value label="Manufacturer" value={device?.manufacturer ?? "—"} />
      <Value label="Model" value={device?.model ?? "—"} />
      <Value label="Serial number" value={device?.serial_number ?? "—"} />
    </dl>
    {device?.sys_name || device?.sys_descr ? <details className="mt-3 rounded-control border border-border bg-bg-base p-3 text-meta"><summary className="cursor-pointer text-text-secondary">System identity</summary><dl className="mt-3 grid gap-2"><Value label="sysName" value={device?.sys_name ?? "—"} data /><Value label="sysDescr" value={device?.sys_descr ?? "—"} /></dl></details> : null}

    <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-3">
      <Metric label="All interfaces" value={String(summarized.total)} />
      <Metric label="Likely physical ports" value={String(summarized.physical)} hint="classified by name and type, not ifNumber" />
      <Metric label="Physical up" value={String(summarized.physical_up)} />
      <Metric label="Physical down" value={String(summarized.physical_down)} />
      <Metric label="Ports with recent errors" value={String(summarized.physical_errors)} />
      <Metric label="Ports with recent discards" value={String(summarized.physical_discards)} />
    </div>
    {summarized.logical > 0 ? <p className="mt-2 text-meta text-text-muted">{summarized.logical} logical interface{summarized.logical === 1 ? "" : "s"} (VLAN/loopback/tunnel) are not counted as physical ports.</p> : null}
    {physicalDown > 0 ? <p className="mt-2 text-meta text-severity-medium">{physicalDown} physical port{physicalDown === 1 ? " is" : "s are"} operationally down.</p> : null}

    {events.length ? <details className="mt-4 rounded-control border border-border bg-bg-base p-3 text-meta"><summary className="cursor-pointer text-text-secondary">Recent managed telemetry events ({events.length})</summary><ul className="mt-3 grid gap-2">{events.map((event) => <li key={event.id} className="flex flex-col gap-1 border-b border-border pb-2 last:border-0"><span className={event.resolved_at ? "text-text-muted" : event.severity === "high" ? "text-severity-critical" : event.severity === "medium" ? "text-severity-medium" : "text-text-secondary"}>{event.title}</span><span className="text-text-muted">{formatDateTime(event.created_at)}{event.resolved_at ? " · resolved" : ""}</span></li>)}</ul></details> : null}

    <div className="mt-6">
      <div className="flex items-end justify-between"><h4 className="text-section font-semibold">Interface state</h4><span className="text-meta text-text-muted">{rows.length} interfaces</span></div>
      {rows.length === 0 ? <p className="mt-3 rounded-control border border-border bg-bg-surface p-4 text-text-secondary">No interface data available.</p> : <>
        <div className="mt-3 hidden overflow-x-auto rounded-control border border-border md:block">
          <table className="w-full min-w-[880px] text-left text-meta">
            <thead className="bg-bg-surface text-text-secondary"><tr><th className="p-2.5">Interface</th><th className="p-2.5">Admin</th><th className="p-2.5">Operational</th><th className="p-2.5">Speed</th><th className="p-2.5">RX rate</th><th className="p-2.5">TX rate</th><th className="p-2.5">RX util</th><th className="p-2.5">TX util</th><th className="p-2.5">Errors Δ</th><th className="p-2.5">Discards Δ</th></tr></thead>
            <tbody>{rows.map((row) => <InterfaceRow key={row.if_index} row={row} thresholds={thresholds} events={events} expanded={expanded === row.if_index} onToggle={() => setExpanded(expanded === row.if_index ? null : row.if_index)} />)}</tbody>
          </table>
        </div>
        <div className="mt-3 grid gap-3 md:hidden">{rows.map((row) => <InterfaceCard key={row.if_index} row={row} thresholds={thresholds} events={events} expanded={expanded === row.if_index} onToggle={() => setExpanded(expanded === row.if_index ? null : row.if_index)} />)}</div>
      </>}
    </div>
  </Section>;
}

function InterfaceRow({ row, thresholds, events, expanded, onToggle }: { row: ManagedInterfaceLatest; thresholds: ManagedTelemetryThresholds | null; events: ManagedTelemetryEvent[]; expanded: boolean; onToggle: () => void }) {
  return <>
    <tr className="cursor-pointer border-t border-border bg-bg-base hover:bg-bg-surface" onClick={onToggle}>
      <td className="p-2.5"><p className="font-medium">{row.name ?? "—"}</p><p className="font-data text-text-muted">#{row.if_index}{row.is_physical ? "" : " · logical"}</p></td>
      <td className="p-2.5">{row.admin_status ? statusChip(row.admin_status) : "—"}</td>
      <td className="p-2.5">{row.oper_status ? operChip(row.oper_status) : "—"}</td>
      <td className="p-2.5 font-data">{formatRate(row.speed_bps)}</td>
      <td className="p-2.5 font-data">{formatRate(row.rx_rate_bps)}</td>
      <td className="p-2.5 font-data">{formatRate(row.tx_rate_bps)}</td>
      <td className="p-2.5 font-data">{formatUtil(row.rx_util_percent)}</td>
      <td className="p-2.5 font-data">{formatUtil(row.tx_util_percent)}</td>
      <td className="p-2.5 font-data">{deltaLabel(row.rx_errors_delta, row.tx_errors_delta)}</td>
      <td className="p-2.5 font-data">{deltaLabel(row.in_discards_delta, row.out_discards_delta)}</td>
    </tr>
    {expanded ? <tr className="border-t border-border bg-bg-surface"><td colSpan={10} className="p-3"><InterfaceDetail row={row} thresholds={thresholds} events={events} /></td></tr> : null}
  </>;
}

function InterfaceCard({ row, thresholds, events, expanded, onToggle }: { row: ManagedInterfaceLatest; thresholds: ManagedTelemetryThresholds | null; events: ManagedTelemetryEvent[]; expanded: boolean; onToggle: () => void }) {
  return <article className="rounded-control border border-border bg-bg-surface p-4">
    <button className="w-full text-left" onClick={onToggle}><div className="flex items-start justify-between gap-3"><div><h5 className="font-medium">{row.name ?? "—"}</h5><p className="font-data text-meta text-text-muted">#{row.if_index}{row.is_physical ? "" : " · logical"}</p></div><span className="text-meta">{row.oper_status ? operChip(row.oper_status) : "—"}</span></div><dl className="mt-3 grid grid-cols-2 gap-2 text-meta"><div><dt className="text-text-muted">Speed</dt><dd className="font-data">{formatRate(row.speed_bps)}</dd></div><div><dt className="text-text-muted">RX / TX</dt><dd className="font-data">{formatRate(row.rx_rate_bps)} / {formatRate(row.tx_rate_bps)}</dd></div><div><dt className="text-text-muted">RX / TX util</dt><dd className="font-data">{formatUtil(row.rx_util_percent)} / {formatUtil(row.tx_util_percent)}</dd></div><div><dt className="text-text-muted">Errors / Discards Δ</dt><dd className="font-data">{deltaLabel(row.rx_errors_delta, row.tx_errors_delta)} / {deltaLabel(row.in_discards_delta, row.out_discards_delta)}</dd></div></dl><span className="mt-2 inline-block text-meta text-accent">{expanded ? "Tutup detail" : "Detail"}</span></button>
    {expanded ? <div className="mt-3 border-t border-border pt-3"><InterfaceDetail row={row} thresholds={thresholds} events={events} /></div> : null}
  </article>;
}

function InterfaceDetail({ row, thresholds, events }: { row: ManagedInterfaceLatest; thresholds: ManagedTelemetryThresholds | null; events: ManagedTelemetryEvent[] }) {
  const warnings = interfaceWarnings(row, thresholds, events);
  return <div className="grid gap-3 sm:grid-cols-2">
    <Value label="ifIndex" value={String(row.if_index)} data />
    <Value label="ifName" value={row.name ?? "—"} data />
    <Value label="ifDescr" value={row.description ?? "—"} />
    <Value label="ifType" value={row.if_type === null ? "—" : `ifType ${row.if_type}`} data />
    <Value label="Classification" value={row.is_physical ? "Likely physical port" : "Logical interface"} />
    <Value label="Admin state" value={row.admin_status ?? "—"} data />
    <Value label="Oper state" value={row.oper_status ?? "—"} data />
    <Value label="Speed" value={formatRate(row.speed_bps)} data />
    <Value label="RX rate" value={formatRate(row.rx_rate_bps)} data />
    <Value label="TX rate" value={formatRate(row.tx_rate_bps)} data />
    <Value label="RX utilization" value={formatUtil(row.rx_util_percent)} data />
    <Value label="TX utilization" value={formatUtil(row.tx_util_percent)} data />
    <Value label="Errors (cumulative)" value={cumulativeLabel(row.rx_errors_cumulative, row.tx_errors_cumulative)} data />
    <Value label="Errors (recent Δ)" value={deltaLabel(row.rx_errors_delta, row.tx_errors_delta)} data />
    <Value label="Discards (cumulative)" value={cumulativeLabel(row.in_discards_cumulative, row.out_discards_cumulative)} data />
    <Value label="Discards (recent Δ)" value={deltaLabel(row.in_discards_delta, row.out_discards_delta)} data />
    <Value label="Last poll" value={formatDateTime(row.last_polled_at)} data />
    {warnings.length ? <div className="rounded-control border border-severity-medium/40 bg-bg-base p-3 sm:col-span-2"><p className="text-meta text-text-muted">Caution — no root cause inferred</p><div className="mt-2 flex flex-wrap gap-2">{warnings.map((warning) => <span key={warning} className="rounded-full bg-severity-medium/10 px-3 py-1 text-meta font-medium text-severity-medium">{warning}</span>)}</div></div> : null}
  </div>;
}

function Section({ title, children }: { title?: string; children: React.ReactNode }) { return <section className="mt-6 border-t border-border pt-5"><h3 className="text-section font-semibold">{title}</h3><div className="mt-3">{children}</div></section>; }
function Value({ label, value, data = false }: { label: string; value: string; data?: boolean }) { return <div className="rounded-control border border-border bg-bg-base p-3"><dt className="text-meta text-text-muted">{label}</dt><dd className={`mt-1 ${data ? "font-data" : ""}`}>{value}</dd></div>; }
function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) { return <div className="rounded-control border border-border bg-bg-base p-3"><p className="text-section font-semibold">{value}</p><p className="mt-1 text-meta text-text-muted">{label}</p>{hint ? <p className="mt-1 text-meta text-text-muted">{hint}</p> : null}</div>; }
function statusChip(value: string) { return <span className={`inline-flex rounded-full px-2 py-0.5 font-medium ${value === "up" ? "bg-severity-low/10 text-severity-low" : value === "down" ? "bg-severity-critical/10 text-severity-critical" : "bg-text-muted/10 text-text-muted"}`}>{value}</span>; }
function operChip(value: string) { return value === "up" ? statusChip("up") : value === "down" ? statusChip("down") : <span className="text-text-muted">{value}</span>; }
function deltaLabel(rx: number | null, tx: number | null): string {
  const value = (rx ?? 0) + (tx ?? 0);
  if (rx === null && tx === null) return "—";
  return value > 0 ? `+${value}` : "0";
}
function cumulativeLabel(rx: number | null, tx: number | null): string {
  if (rx === null && tx === null) return "—";
  return `${rx ?? "—"} / ${tx ?? "—"}`;
}