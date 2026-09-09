"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

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
  sourceName?: string;
  sourceIp?: string;
};

const FILTERS: ObservedHostFilter[] = ["all", "named", "unnamed", "fresh", "stale"];

export function ObservedLanHostsSummary({ targetId, hosts, status, lastPolledAt, sourceName, sourceIp }: SummaryProps) {
  const { t, i18n } = useTranslation("snmp");
  const latestAt = latestObservedAt(hosts, lastPolledAt);
  const sourceDevice = sourceName ? `${sourceName}${sourceIp ? ` · ${sourceIp}` : ""}` : sourceIp;
  return <section className="mt-6 scroll-mt-6 rounded-panel border border-border bg-bg-surface p-4 md:p-6" aria-label={t("observed.summaryTitle")} id="observed-lan-hosts">
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h3 className="text-section font-semibold">{t("observed.summaryTitle")}</h3>
        <p className="mt-1 max-w-3xl text-meta text-text-muted">{t("observed.summaryDescription")}</p>
      </div>
      <Link className={actionClass} href={`/snmp/${targetId}/hosts`}>{t("observed.viewCount", { count: hosts.length })}</Link>
    </div>
    <dl className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <SummaryMetric label={t("observed.observedHosts")} value={String(hosts.length)} data />
      <SummaryMetric label={t("observed.state")} value={observedStatusLabel(status, t)} />
      <SummaryMetric label={t("observed.latest")} value={formatDateTime(latestAt, i18n.language)} data />
      {sourceDevice ? <SummaryMetric label={t("observed.sourceDevice")} value={sourceDevice} /> : null}
    </dl>
  </section>;
}

export function ObservedLanHostsWorkspace({ hosts, status }: WorkspaceProps) {
  const { t, i18n } = useTranslation("snmp");
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

  return <section className="mt-6" aria-label={t("observed.workspaceTitle")}>
    <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h2 className="text-section font-semibold">{t("observed.workspaceTitle")}</h2>
        <p className="mt-1 max-w-3xl text-meta text-text-muted">{t("observed.workspaceDescription")}</p>
      </div>
      <span className="font-data text-meta text-text-muted">{t("observed.currentStatus", { count: currentCount, status: observedStatusLabel(status, t) })}</span>
    </div>

    {status === "partial" ? <p className="mt-4 rounded-control border border-severity-medium/50 bg-severity-medium/5 p-4 text-meta text-text-secondary" role="status">{t("observed.partialNotice")}</p> : null}
    <div className="mt-4 rounded-control border border-border bg-bg-surface p-4">
      <label className="grid gap-2 text-meta text-text-secondary">{t("observed.searchLabel")}
        <input
          className={controlClass}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("observed.searchPlaceholder")}
        />
      </label>
      <div className="mt-3 flex flex-wrap gap-2" aria-label={t("observed.searchLabel")}>
        {FILTERS.map((option) => <button
          key={option}
          type="button"
          aria-pressed={filter === option}
          className={filter === option ? activeFilterClass : filterClass}
          onClick={() => setFilter(option)}
        >{t(`observed.filters.${option}`)} ({filterCounts[option]})</button>)}
      </div>
    </div>
    <p className="mt-3 text-meta text-text-muted" role="status">{t("observed.count", { visible: displayed.length, total: hosts.length })}</p>
    {status === "unsupported" ? <StateMessage>{t("observed.unsupportedState")}</StateMessage>
      : hosts.length === 0 ? <StateMessage>{t("observed.emptyState")}</StateMessage>
      : <>
        {currentCount === 0 ? <p className="mt-4 rounded-control border border-border bg-bg-surface p-4 text-meta text-text-secondary">{t("observed.noFresh")}</p> : null}
        {displayed.length === 0 ? <StateMessage>{t("observed.noMatch")}</StateMessage>
          : <div className="mt-3 overflow-x-auto rounded-control border border-border">
            <table className="w-full min-w-[1040px] text-left text-meta">
              <thead className="bg-bg-surface text-text-secondary"><tr><SortableHeader activeSort={sort} label={t("observed.columns.device")} sortKey="device" onSort={toggleSort} /><SortableHeader activeSort={sort} label={t("observed.columns.ip")} sortKey="ip_address" onSort={toggleSort} /><th className="p-3">{t("observed.columns.mac")}</th><th className="p-3">{t("observed.columns.netbios")}</th><th className="p-3">{t("observed.columns.evidence")}</th><th className="p-3">{t("observed.columns.freshness")}</th><th className="p-3">{t("observed.columns.seen")}</th></tr></thead>
              <tbody>{displayed.map((host) => <ObservedHostRow host={host} language={i18n.language} key={`${host.target_id}-${host.ip_address}`} />)}</tbody>
            </table>
          </div>}
      </>}
  </section>;
}

function ObservedHostRow({ host, language }: { host: ManagedObservedHostLatest; language: string }) {
  const { t } = useTranslation("snmp");
  const inventoryName = observedHostInventoryName(host);
  const deviceLabel = observedHostDisplayName(host);
  return <tr className="border-t border-border bg-bg-base">
    <td className="p-3"><p className="font-medium">{inventoryName && host.node_id ? <Link className="text-accent hover:underline" href="/devices" title={t("observed.linkedNode")}>{deviceLabel}</Link> : deviceLabel}</p>{inventoryName ? <span className="mt-1 block text-text-muted">{t("observed.linkedNode")}</span> : null}</td>
    <td className="p-3 font-data">{host.ip_address}</td>
    <td className="p-3 font-data">{observedHostMacLabel(host)}</td>
    <td className="p-3">{host.netbios_name ?? "-"}{host.enrichment_status !== "resolved" ? <span className="mt-1 block text-text-muted">{t("observed.nameUnavailable")}</span> : null}</td>
    <td className="p-3">{host.observation_source === "ip_net_to_physical" ? t("observed.ipMib") : t("observed.legacy")}</td>
    <td className="p-3"><span className={host.status === "current" ? "text-severity-low" : "text-text-muted"}>{host.status === "current" ? t("observed.fresh") : t("observed.stale")}</span></td>
    <td className="p-3 font-data"><span className="block" suppressHydrationWarning>{formatDateTime(host.first_seen_at, language)}</span><span className="mt-1 block text-text-muted" suppressHydrationWarning>{formatDateTime(host.last_seen_at, language)}</span></td>
  </tr>;
}

function SortableHeader({ activeSort, label, sortKey, onSort }: {
  activeSort: { key: ObservedHostSortKey; direction: ObservedHostSortDirection } | null;
  label: string;
  sortKey: ObservedHostSortKey;
  onSort: (key: ObservedHostSortKey) => void;
}) {
  const { t } = useTranslation("snmp");
  const active = activeSort?.key === sortKey;
  const direction = active ? activeSort.direction : null;
  return <th className="p-3" aria-sort={direction === "asc" ? "ascending" : direction === "desc" ? "descending" : "none"}>
    <button aria-label={t(direction === "asc" ? "observed.sort.descending" : "observed.sort.ascending", { column: label })} className="inline-flex items-center gap-1.5 font-medium hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent" type="button" onClick={() => onSort(sortKey)}>
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

export function observedStatusLabel(status: ObservationStatus, t: TFunction): string {
  switch (status) {
    case "available": return t("observed.available");
    case "partial": return t("observed.partial");
    case "empty": return t("observed.empty");
    case "unsupported": return t("observed.unsupported");
    default: return t("observed.notReported");
  }
}

const actionClass = "inline-flex w-fit items-center justify-center rounded-control border border-accent bg-accent px-4 py-2 text-body font-medium text-bg-base transition-colors hover:bg-accent/85 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent";
const controlClass = "rounded-control border border-border bg-bg-base px-3 py-2 text-body text-text-primary outline-none placeholder:text-text-muted focus:border-accent";
const filterClass = "rounded-control border border-border px-3 py-1.5 text-meta text-text-secondary transition-colors hover:border-accent hover:text-accent";
const activeFilterClass = "rounded-control border border-accent bg-accent/10 px-3 py-1.5 text-meta text-accent";
