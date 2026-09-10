"use client";

import Link from "next/link";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { isNetworkDiscoveredSource, type AssetChangeData, type AssetChangeEvent, type AssetChangeField, type AssetChangeHistoryQuery } from "@/lib/asset-change-contract";

type HistoryError = "unconfigured" | "unavailable" | null;

export function AssetChangeHistoryPanel({ data, error, query }: { data: AssetChangeData | null; error: HistoryError; query: AssetChangeHistoryQuery }) {
  const { t, i18n } = useTranslation(["history", "assets"]);
  const locale = i18n.language === "en" ? "en-US" : "id-ID";
  return <section className="mt-6" role="tabpanel">
    <div className="rounded-panel border border-border bg-bg-surface p-4 md:p-6">
      <h2 className="text-section font-semibold">{t("assetChanges.title")}</h2>
      <p className="mt-2 text-text-secondary">{t("assetChanges.description")}</p>
      <form className="mt-5 grid gap-3 md:grid-cols-[minmax(220px,2fr)_minmax(150px,1fr)_minmax(170px,1fr)_auto]" method="get">
        <input name="tab" type="hidden" value="assets" />
        <label className="grid gap-1 text-meta text-text-secondary"><span>{t("assetChanges.search")}</span><input className={control} defaultValue={query.q ?? ""} maxLength={100} name="q" placeholder={t("assetChanges.searchPlaceholder")} /></label>
        <label className="grid gap-1 text-meta text-text-secondary"><span>{t("assetChanges.eventType")}</span><select className={control} defaultValue={query.event_type ?? ""} name="event_type"><option value="">{t("assetChanges.all")}</option><option value="created">{t("assetChanges.created")}</option><option value="changed">{t("assetChanges.changed")}</option></select></label>
        <label className="grid gap-1 text-meta text-text-secondary"><span>{t("assetChanges.changedField")}</span><select className={control} defaultValue={query.changed_field ?? ""} name="changed_field"><option value="">{t("assetChanges.allFields")}</option>{CHANGE_FIELDS.map((field) => <option key={field} value={field}>{t(`assetChanges.fields.${field}`)}</option>)}</select></label>
        <div className="flex items-end gap-2"><Button className="flex-1" type="submit">{t("assetChanges.apply")}</Button><Link className="rounded-control border border-border px-4 py-2 text-body font-medium hover:border-accent hover:text-accent" href="/history?tab=assets">{t("assetChanges.clear")}</Link></div>
      </form>
    </div>
    {error ? <HistoryNotice>{t(`assetChanges.errors.${error}`)}</HistoryNotice> : data?.events.length ? <>
      <AssetChangeList events={data.events} locale={locale} />
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-meta"><span className="text-text-secondary">{t("assetChanges.pagination", { page: data.pagination.page, pages: data.pagination.pages, total: data.pagination.total })}</span><div className="flex gap-2"><PageLink disabled={data.pagination.page <= 1} href={historyHref(query, data.pagination.page - 1)}>{t("common:actions.previous")}</PageLink><PageLink disabled={data.pagination.page >= data.pagination.pages} href={historyHref(query, data.pagination.page + 1)}>{t("common:actions.next")}</PageLink></div></div>
    </> : <HistoryNotice>{t("assetChanges.empty")}</HistoryNotice>}
  </section>;
}

export function AssetChangeList({ events, locale, compact = false }: { events: readonly AssetChangeEvent[]; locale: string; compact?: boolean }) {
  return <div className={compact ? "mt-4 grid gap-3" : "mt-6 grid gap-3"}>{events.map((event) => <AssetChangeCard event={event} key={event.id} locale={locale} />)}</div>;
}

function AssetChangeCard({ event, locale }: { event: AssetChangeEvent; locale: string }) {
  const { t } = useTranslation(["history", "assets"]);
  const networkCreated = event.event_type === "created" && isNetworkDiscoveredSource(event.source);
  return <article className="rounded-panel border border-border bg-bg-surface p-4">
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><p className="text-meta font-medium uppercase tracking-wide text-accent">{t(event.event_type === "changed" ? "assetChanges.changed" : networkCreated ? "assetChanges.newDevice" : "assetChanges.assetCreated")}</p><h3 className="mt-1 truncate font-medium">{event.after_state.name}</h3><p className="mt-1 font-data text-meta text-text-muted">{event.after_state.ip_address ?? event.after_state.mac_address ?? "-"}</p></div><div className="shrink-0 sm:text-right"><time className="text-meta text-text-secondary">{formatTimestamp(event.observed_at, locale)}</time><p className="mt-1 text-meta text-text-muted">{t(`assets:source.${event.source}`)}</p></div></div>
    {event.event_type === "created" ? <p className="mt-3 text-meta text-text-secondary">{t(networkCreated ? "assetChanges.discoveredVia" : "assetChanges.createdVia", { source: t(`assets:source.${event.source}`) })}</p> : <dl className="mt-3 grid gap-2">{event.changed_fields.map((field) => <div className="rounded-control border border-border bg-bg-base p-3" key={field}><dt className="text-meta font-medium text-text-secondary">{t(`assetChanges.fields.${field}`)}</dt><dd className="mt-2 grid gap-2 break-words text-meta sm:grid-cols-2"><span><span className="block text-text-muted">{t("assetChanges.before")}</span>{changeValue(field, event.before_state?.[field])}</span><span><span className="block text-text-muted">{t("assetChanges.after")}</span>{changeValue(field, event.after_state[field])}</span></dd></div>)}</dl>}
  </article>;
}

function changeValue(field: AssetChangeField, value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  if (field === "open_ports" && Array.isArray(value)) return value.length ? value.join(", ") : "-";
  if (field === "detected_services" && Array.isArray(value)) {
    const labels = value.filter(record).map((item) => `${String(item.protocol).toUpperCase()}/${String(item.port)} ${String(item.name)}`);
    return labels.length ? labels.join(", ") : "-";
  }
  return String(value);
}

function historyHref(query: AssetChangeHistoryQuery, page: number): string {
  const params = new URLSearchParams({ tab: "assets", page: String(Math.max(1, page)) });
  for (const key of ["q", "event_type", "source", "changed_field", "page_size"] as const) if (query[key]) params.set(key, query[key] ?? "");
  return `/history?${params}`;
}

function PageLink({ disabled, href, children }: { disabled: boolean; href: string; children: string }) {
  return disabled ? <span aria-disabled="true" className="rounded-control border border-border px-3 py-2 text-text-muted">{children}</span> : <Link className="rounded-control border border-border px-3 py-2 hover:border-accent hover:text-accent" href={href}>{children}</Link>;
}

function HistoryNotice({ children }: { children: string }) { return <div className="mt-6 rounded-panel border border-border bg-bg-surface p-6 text-center text-text-secondary">{children}</div>; }
function formatTimestamp(value: string, locale: string): string { return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

const CHANGE_FIELDS: readonly AssetChangeField[] = ["name", "hostname", "ip_address", "mac_address", "vendor", "platform", "device_type", "status", "open_ports", "detected_services"];
const control = "min-w-0 rounded-control border border-border bg-bg-base px-3 py-2 text-body text-text-primary focus:border-accent focus:outline-none";
