"use client";

import { useMemo, useState } from "react";

import {
  formatDateTime,
  formatRate,
  formatUptime,
  formatUtil,
  ifNameLabel,
  type ManagedInterfaceLatest,
  type ManagedTelemetryTarget,
} from "@/lib/managed-telemetry";

type Props = { targets: ManagedTelemetryTarget[]; interfaces: ManagedInterfaceLatest[] };

export function ManagedTelemetryDetail({ targets, interfaces }: Props) {
  const [selectedId, setSelectedId] = useState(targets[0]?.id ?? "");
  const selected = targets.find((target) => target.id === selectedId) ?? targets[0];
  const selectedInterfaces = useMemo(
    () => selected ? interfaces.filter((row) => row.target_id === selected.id).sort((a, b) => a.if_index - b.if_index) : [],
    [interfaces, selected],
  );

  return <section className="mt-12 border-t border-border pt-8">
    <p className="text-meta font-medium uppercase tracking-wide text-accent">Telemetry detail</p>
    <h2 className="mt-2 text-heading font-semibold">Latest managed state</h2>
    {targets.length === 0 ? <div className="mt-6 rounded-control border border-border bg-bg-surface p-6 text-text-secondary">Belum ada managed device.</div> : <>
      <label className="mt-6 grid max-w-xl gap-2 text-meta text-text-secondary">Managed device
        <select className={control} value={selected?.id ?? ""} onChange={(event) => setSelectedId(event.target.value)}>{targets.map((target) => <option key={target.id} value={target.id}>{target.node.name} — {target.node.ip_address}</option>)}</select>
      </label>
      <div className="mt-4 rounded-panel border border-border bg-bg-surface p-4 md:p-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between"><div><h3 className="text-section font-semibold">{selected?.node.name}</h3><p className="mt-1 font-data text-meta text-text-secondary">{selected?.node.ip_address}</p></div><span className="text-meta text-text-secondary">Latest poll: {formatDateTime(selected?.latest?.last_polled_at ?? null)}</span></div>
        <dl className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="Connection status" value={selected?.latest?.status ?? "—"} />
          <Metric label="System name" value={selected?.latest?.sys_name ?? "—"} data />
          <Metric label="System Object ID" value={selected?.latest?.sys_object_id ?? "—"} data />
          <Metric label="Uptime" value={formatUptime(selected?.latest?.uptime_seconds ?? null)} data />
          <div className="sm:col-span-2 xl:col-span-4"><Metric label="System description" value={selected?.latest?.sys_descr ?? "—"} /></div>
        </dl>
      </div>
      <div className="mt-6">
        <div className="flex items-end justify-between gap-3"><h3 className="text-section font-semibold">Interfaces</h3><span className="font-data text-meta text-text-muted">{selectedInterfaces.length} interfaces</span></div>
        {selectedInterfaces.length === 0 ? <div className="mt-4 rounded-control border border-border bg-bg-surface p-4 text-text-secondary">Interface telemetry belum tersedia.</div> : <div className="mt-4 overflow-x-auto rounded-control border border-border"><table className="w-full min-w-[1040px] text-left"><thead className="bg-bg-surface text-meta text-text-secondary"><tr><th className="p-3">Interface</th><th className="p-3">Class</th><th className="p-3">Admin / oper</th><th className="p-3">RX rate</th><th className="p-3">TX rate</th><th className="p-3">RX / TX util</th><th className="p-3">Error Δ</th><th className="p-3">Discard Δ</th></tr></thead><tbody>{selectedInterfaces.map((row) => <tr className="border-t border-border bg-bg-base" key={`${row.target_id}-${row.if_index}`}><td className="p-3"><p className="font-medium">{ifNameLabel(row)}</p><p className="mt-1 max-w-xs text-meta text-text-muted">{row.description ?? `ifIndex ${row.if_index}`}</p></td><td className="p-3 text-text-secondary">{row.is_physical ? "Physical" : "Logical"}</td><td className="p-3 font-data text-meta">{row.admin_status ?? "—"} / {row.oper_status ?? "—"}</td><td className="p-3 font-data text-meta">{formatRate(row.rx_rate_bps)}</td><td className="p-3 font-data text-meta">{formatRate(row.tx_rate_bps)}</td><td className="p-3 font-data text-meta">{formatUtil(row.rx_util_percent)} / {formatUtil(row.tx_util_percent)}</td><td className="p-3 font-data text-meta">{pair(row.rx_errors_delta, row.tx_errors_delta)}</td><td className="p-3 font-data text-meta">{pair(row.in_discards_delta, row.out_discards_delta)}</td></tr>)}</tbody></table></div>}
      </div>
    </>}
  </section>;
}

function Metric({ label, value, data = false }: { label: string; value: string; data?: boolean }) { return <div className="rounded-control border border-border bg-bg-base p-4"><dt className="text-meta text-text-muted">{label}</dt><dd className={`mt-2 break-words text-text-primary ${data ? "font-data" : ""}`}>{value}</dd></div>; }
function pair(left: number | null, right: number | null) { return left === null && right === null ? "—" : `${left ?? "—"} / ${right ?? "—"}`; }
const control = "rounded-control border border-border bg-bg-base px-3 py-2 text-body text-text-primary outline-none focus:border-accent";
