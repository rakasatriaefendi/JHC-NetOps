"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";

import {
  filterObservedHosts,
  formatDateTime,
  latestObservedAt,
  observedHostDisplayName,
  observedHostInventoryName,
  observedHostMacLabel,
  observedHostFilterCounts,
  sortObservedHosts,
  type ManagedObservedHostLatest,
  type ObservedHostFilter,
  type ObservedHostSortDirection,
  type ObservedHostSortKey,
} from "@/lib/managed-telemetry";

type ObservationStatus = "available" | "empty" | "partial" | "unsupported" | null | undefined;

type WorkspaceProps = {
  hosts: ManagedObservedHostLatest[];
  status: ObservationStatus;
};

type SummaryProps = WorkspaceProps & {
  targetId: string;
  lastPolledAt: string | null;
};

const FILTERS: { value: ObservedHostFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "named", label: "Named" },
  { value: "unnamed", label: "Unnamed" },
  { value: "fresh", label: "Fresh" },
  { value: "stale", label: "Stale" },
];

export function ObservedLanHostsSummary({ targetId, hosts, status, lastPolledAt }: SummaryProps) {
  const currentCount = hosts.filter((host) => host.status === "current").length;
  const latestAt = latestObservedAt(hosts, lastPolledAt);
  return <section className="mt-6 rounded-panel border border-border bg-bg-surface p-4 md:p-6" aria-label="Observed LAN Hosts summary">
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h3 className="text-section font-semibold">Observed LAN Hosts</h3>
        <p className="mt-1 max-w-3xl text-meta text-text-muted">Layer-3 neighbor evidence reported by this managed device. NetBIOS is optional naming enrichment only.</p>
      </div>
      <Link className={actionClass} href={`/snmp/${targetId}/hosts`}>View Observed LAN Hosts</Link>
    </div>
    <dl className="mt-4 grid gap-3 sm:grid-cols-3">
      <SummaryMetric label="Current observations" value={String(currentCount)} data />
      <SummaryMetric label="Observation state" value={observedStatusLabel(status)} />
      <SummaryMetric label="Latest observation / poll" value={formatDateTime(latestAt)} data />
    </dl>
  </section>;
}

export function ObservedLanHostsWorkspace({ hosts, status }: WorkspaceProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ObservedHostFilter>("all");
  const [sort, setSort] = useState<{ key: ObservedHostSortKey; direction: ObservedHostSortDirection } | null>(null);
  const displayed = useMemo(
    () => {
      const visible = filterObservedHosts(hosts, query, filter);
      return sort ? sortObservedHosts(visible, sort.key, sort.direction) : visible.sort((left, right) => left.status === right.status
        ? right.last_seen_at.localeCompare(left.last_seen_at)
        : left.status === "current" ? -1 : 1);
    },
    [filter, hosts, query, sort],
  );
  const filterCounts = useMemo(() => observedHostFilterCounts(hosts), [hosts]);
  const currentCount = hosts.filter((host) => host.status === "current").length;
  const toggleSort = (key: ObservedHostSortKey) => setSort((current) => ({
    key,
    direction: current?.key === key && current.direction === "asc" ? "desc" : "asc",
  }));

  return <section className="mt-6" aria-label="Observed LAN Hosts">
    <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h2 className="text-section font-semibold">Host observations</h2>
        <p className="mt-1 max-w-3xl text-meta text-text-muted">These are Layer-3 neighbor observations, not proof of physical attachment, switch-port membership, or discovered topology.</p>
      </div>
      <span className="font-data text-meta text-text-muted">{currentCount} current · {observedStatusLabel(status)}</span>
    </div>

    {status === "partial" ? <p className="mt-4 rounded-control border border-severity-medium/50 bg-severity-medium/5 p-4 text-meta text-text-secondary" role="status">Neighbor evidence is available, but optional NetBIOS naming enrichment is partial or unavailable for some hosts.</p> : null}
    <div className="mt-4 rounded-control border border-border bg-bg-surface p-4">
      <label className="grid gap-2 text-meta text-text-secondary">Search observed hosts
        <input
          className={controlClass}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Name, NetBIOS, IP, or MAC"
        />
      </label>
      <div className="mt-3 flex flex-wrap gap-2" aria-label="Observed host filters">
        {FILTERS.map((option) => <button
          key={option.value}
          type="button"
          aria-pressed={filter === option.value}
          className={filter === option.value ? activeFilterClass : filterClass}
          onClick={() => setFilter(option.value)}
        >{option.label} ({filterCounts[option.value]})</button>)}
      </div>
    </div>
    <p className="mt-3 text-meta text-text-muted" role="status">Observed hosts: {displayed.length} / {hosts.length}</p>
    {status === "unsupported" ? <StateMessage>Neighbor-table observation is unsupported by this managed device.</StateMessage>
      : hosts.length === 0 ? <StateMessage>No hosts are currently observed through this managed device.</StateMessage>
      : <>
        {currentCount === 0 ? <p className="mt-4 rounded-control border border-border bg-bg-surface p-4 text-meta text-text-secondary">No hosts are currently fresh. Stale observations are retained below for context.</p> : null}
        {displayed.length === 0 ? <StateMessage>No observed hosts match the current search and filter.</StateMessage>
          : <div className="mt-3 overflow-x-auto rounded-control border border-border">
            <table className="w-full min-w-[1040px] text-left text-meta">
              <thead className="bg-bg-surface text-text-secondary"><tr><SortableHeader activeSort={sort} label="Device" sortKey="device" onSort={toggleSort} /><SortableHeader activeSort={sort} label="IP address" sortKey="ip_address" onSort={toggleSort} /><th className="p-3">MAC address</th><th className="p-3">NetBIOS name</th><th className="p-3">Observation evidence</th><th className="p-3">Freshness</th><th className="p-3">First / last seen</th></tr></thead>
              <tbody>{displayed.map((host) => <ObservedHostRow host={host} key={`${host.target_id}-${host.ip_address}`} />)}</tbody>
            </table>
          </div>}
      </>}
  </section>;
}

function ObservedHostRow({ host }: { host: ManagedObservedHostLatest }) {
  const inventoryName = observedHostInventoryName(host);
  const deviceLabel = observedHostDisplayName(host);
  return <tr className="border-t border-border bg-bg-base">
    <td className="p-3"><p className="font-medium">{inventoryName && host.node_id ? <Link className="text-accent hover:underline" href="/devices" title="Open reusable Network Node inventory">{deviceLabel}</Link> : deviceLabel}</p>{inventoryName ? <span className="mt-1 block text-text-muted">Linked Network Node</span> : null}</td>
    <td className="p-3 font-data">{host.ip_address}</td>
    <td className="p-3 font-data">{observedHostMacLabel(host)}</td>
    <td className="p-3">{host.netbios_name ?? "-"}{host.enrichment_status !== "resolved" ? <span className="mt-1 block text-text-muted">Name unavailable</span> : null}</td>
    <td className="p-3">{host.observation_source === "ip_net_to_physical" ? "IP-MIB neighbor" : "Legacy IP neighbor"}</td>
    <td className="p-3"><span className={host.status === "current" ? "text-severity-low" : "text-text-muted"}>{host.status === "current" ? "Fresh" : "Stale"}</span></td>
    <td className="p-3 font-data"><span className="block" suppressHydrationWarning>{formatDateTime(host.first_seen_at)}</span><span className="mt-1 block text-text-muted" suppressHydrationWarning>{formatDateTime(host.last_seen_at)}</span></td>
  </tr>;
}

function SortableHeader({ activeSort, label, sortKey, onSort }: {
  activeSort: { key: ObservedHostSortKey; direction: ObservedHostSortDirection } | null;
  label: string;
  sortKey: ObservedHostSortKey;
  onSort: (key: ObservedHostSortKey) => void;
}) {
  const active = activeSort?.key === sortKey;
  const direction = active ? activeSort.direction : null;
  return <th className="p-3" aria-sort={direction === "asc" ? "ascending" : direction === "desc" ? "descending" : "none"}>
    <button className="inline-flex items-center gap-1.5 font-medium hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent" type="button" onClick={() => onSort(sortKey)}>
      {label}<span className="w-3 text-accent" aria-hidden="true">{direction === "asc" ? "↑" : direction === "desc" ? "↓" : ""}</span>
    </button>
  </th>;
}

function SummaryMetric({ label, value, data = false }: { label: string; value: string; data?: boolean }) {
  return <div className="rounded-control border border-border bg-bg-base p-3"><dt className="text-meta text-text-muted">{label}</dt><dd className={`mt-1 text-text-primary ${data ? "font-data" : ""}`} suppressHydrationWarning={data}>{value}</dd></div>;
}

function StateMessage({ children }: { children: ReactNode }) {
  return <p className="mt-4 rounded-control border border-border bg-bg-surface p-4 text-text-secondary">{children}</p>;
}

export function observedStatusLabel(status: ObservationStatus): string {
  switch (status) {
    case "available": return "Available";
    case "partial": return "Partial enrichment";
    case "empty": return "No current observations";
    case "unsupported": return "Unsupported";
    default: return "Not reported";
  }
}

const actionClass = "inline-flex w-fit items-center justify-center rounded-control border border-accent px-4 py-2 text-body font-medium text-accent transition-colors hover:bg-accent hover:text-bg-base focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent";
const controlClass = "rounded-control border border-border bg-bg-base px-3 py-2 text-body text-text-primary outline-none placeholder:text-text-muted focus:border-accent";
const filterClass = "rounded-control border border-border px-3 py-1.5 text-meta text-text-secondary transition-colors hover:border-accent hover:text-accent";
const activeFilterClass = "rounded-control border border-accent bg-accent/10 px-3 py-1.5 text-meta text-accent";
