"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { getAssetChangeHistoryAction } from "@/app/actions/assets";
import { AssetChangeList } from "@/components/assets/asset-change-history-panel";
import { AssetIdentityPanel } from "@/components/assets/asset-identity-panel";
import { AssetExportButton } from "@/components/assets/asset-export-button";
import { useDeviceProfile } from "@/components/device-profile/device-profile-provider";
import { useNetworkNodes } from "@/components/diagnostics/network-nodes-provider";
import { Button } from "@/components/ui/button";
import { AssetScanControl } from "@/components/assets/asset-scan-control";
import { isNewNetworkAsset, type AssetChangeData } from "@/lib/asset-change-contract";
import type { AssetScanState } from "@/lib/asset-scan-contract";
import type { AssetInventoryData, AssetInventoryQuery, AssetRecord, AssetStatus } from "@/lib/assets";
import { normalizeNetworkNodeIpv4 } from "@/lib/network-nodes";

const chevronLeft = "◀";
const chevronRight = "▶";

type Props = {
  data: AssetInventoryData | null;
  error: "unconfigured" | "unavailable" | null;
  query: AssetInventoryQuery;
  scanState: AssetScanState | null;
  scanError: "unconfigured" | "unavailable" | null;
  canScan: boolean;
  canInspect: boolean;
  inspectorAvailable: boolean;
  managedTargets: { id: string; context: string | null }[];
  healthTargetIds: string[];
  medicalLinks: readonly { network_asset_id: string; medical_equipment_id: string; equipment_code: string; name: string; department: string | null; location: string | null }[];
};

const control = "min-w-0 rounded-control border border-border bg-bg-base px-3 py-2 text-body text-text-primary focus:border-accent focus:outline-none";

export function AssetInventory({ data, error, query, scanState, scanError, canScan, canInspect, inspectorAvailable, managedTargets, healthTargetIds, medicalLinks }: Props) {
  const { t, i18n } = useTranslation("assets");
  const [selected, setSelected] = useState<AssetRecord | null>(null);
  const locale = i18n.language === "en" ? "en-US" : "id-ID";
  const page = data?.pagination.page ?? 1;
  const pages = data?.pagination.pages ?? 1;

  return <section>
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(440px,500px)] xl:items-start">
      <div className="min-w-0">
        <p className="text-meta font-medium uppercase tracking-wide text-accent">{t("eyebrow")}</p>
        <h1 className="mt-2 text-heading font-semibold">{t("title")}</h1>
        <p className="mt-2 text-text-secondary">{t("description")}</p>
      </div>
      <div className="w-full xl:justify-self-end">
        <div className="flex flex-wrap items-start justify-end gap-2">
          <AssetExportButton disabled={!data} query={query} />
          <AssetScanControl canScan={canScan} initialError={scanError} initialState={scanState} />
        </div>
        {data ? <p className="mt-3 text-right text-meta text-text-muted">{t("lastUpdated", { value: timeLabel(data.server_time, locale) })}</p> : null}
      </div>
    </div>
    {error ? <div className="mt-6 rounded-control border border-severity-medium bg-bg-surface p-4"><p className="font-medium text-severity-medium">{t(`errors.${error}.title`)}</p><p className="mt-1 text-meta text-text-secondary">{t(`errors.${error}.description`)}</p></div> : null}

    <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Summary label={t("summary.total")} value={data?.summary.total ?? 0} />
      <Summary label={t("summary.online")} value={data?.summary.online ?? 0} />
      <Summary label={t("summary.offline")} value={data?.summary.offline ?? 0} />
      <Summary label={t("summary.changed")} value={data?.summary.changed ?? 0} />
    </div>

    {data ? <AssetInsights data={data} query={query} /> : null}

    <form className="mt-6 grid gap-3 rounded-panel border border-border bg-bg-surface p-4 md:grid-cols-2 xl:grid-cols-[minmax(240px,2fr)_repeat(3,minmax(150px,1fr))_auto]" method="get">
      {query.vendor ? <input name="vendor" type="hidden" value={query.vendor} /> : null}
      {query.platform ? <input name="platform" type="hidden" value={query.platform} /> : null}
      <label className="grid gap-1 text-meta text-text-secondary"><span>{t("filters.search")}</span><input className={control} defaultValue={query.q ?? ""} maxLength={100} name="q" placeholder={t("filters.searchPlaceholder")} /></label>
      <label className="grid gap-1 text-meta text-text-secondary"><span>{t("filters.type")}</span><select className={control} defaultValue={query.device_type ?? ""} name="device_type"><option value="">{t("filters.allTypes")}</option>{data?.device_types.map((type) => <option key={type} value={type}>{typeLabel(type, t)}</option>)}</select></label>
      <label className="grid gap-1 text-meta text-text-secondary"><span>{t("filters.status")}</span><select className={control} defaultValue={query.status ?? ""} name="status"><option value="">{t("filters.allStatuses")}</option>{(["online", "offline", "changed", "unknown"] as const).map((status) => <option key={status} value={status}>{t(`status.${status}`)}</option>)}</select></label>
      <label className="grid gap-1 text-meta text-text-secondary"><span>{t("filters.sort")}</span><select className={control} defaultValue={query.sort ?? "name_asc"} name="sort"><option value="name_asc">{t("filters.nameAsc")}</option><option value="name_desc">{t("filters.nameDesc")}</option></select></label>
      <div className="flex items-end gap-2"><Button className="flex-1" type="submit">{t("filters.apply")}</Button>{hasFilters(query) ? <Link className="rounded-control border border-border px-4 py-2 text-body font-medium hover:border-accent hover:text-accent" href="/assets">{t("filters.clear")}</Link> : null}</div>
    </form>

    {(query.vendor || query.platform) ? <div className="mt-3 flex flex-wrap gap-2 text-meta">{query.vendor ? <ActiveFilter label={t("insights.vendor")} value={query.vendor} href={filterHref(query, { vendor: null })} /> : null}{query.platform ? <ActiveFilter label={t("insights.platform")} value={query.platform} href={filterHref(query, { platform: null })} /> : null}</div> : null}
    {!error && data?.items.length === 0 ? <div className="mt-6 rounded-panel border border-border bg-bg-surface p-8 text-center"><p className="font-medium">{t("empty.title")}</p><p className="mt-2 text-text-secondary">{t("empty.description")}</p></div> : null}

    {data?.items.length ? <>
      <div className="mt-6 hidden overflow-hidden rounded-panel border border-border xl:block">
        <table className="w-full table-fixed text-left text-meta"><thead className="bg-bg-surface text-text-secondary"><tr><th className="w-12 p-3">{t("table.no")}</th><th className="w-24 p-3">{t("table.status")}</th><th className="w-32 p-3">{t("table.ip")}</th><th className="p-3">{t("table.hostname")}</th><th className="w-36 p-3">{t("table.mac")}</th><th className="p-3">{t("table.vendor")}</th><th className="p-3">{t("table.os")}</th><th className="p-3">{t("table.type")}</th><th className="w-24 p-3">{t("table.ports")}</th></tr></thead>
          <tbody>{data.items.map((asset, index) => <tr className="border-t border-border bg-bg-base align-top" key={asset.id}><td className="p-3 font-data text-text-muted">{(page - 1) * data.pagination.page_size + index + 1}</td><td className="p-3"><Status value={asset.status} /></td><td className="p-3 font-data">{asset.ip_address ?? "-"}</td><td className="p-3"><div className="flex min-w-0 items-center gap-2"><button className="min-w-0 truncate text-left font-medium text-accent hover:underline" type="button" onClick={() => setSelected(asset)}>{asset.hostname ?? asset.name}</button>{isNewNetworkAsset(asset, data.server_time) ? <NewDeviceBadge /> : null}</div></td><td className="truncate p-3 font-data" title={asset.mac_address ?? undefined}>{asset.mac_address ?? "-"}</td><td className="truncate p-3" title={asset.vendor ?? undefined}>{asset.vendor ?? "-"}</td><td className="truncate p-3" title={asset.platform ?? undefined}>{asset.platform ?? "-"}</td><td className="p-3">{typeLabel(asset.device_type, t)}</td><td className="p-3">{t("table.portCount", { count: asset.open_ports.length })}</td></tr>)}</tbody>
        </table>
      </div>
      <div className="mt-6 grid gap-3 xl:hidden">{data.items.map((asset) => <article className="rounded-panel border border-border bg-bg-surface p-4" key={asset.id}><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h2 className="truncate font-medium">{asset.hostname ?? asset.name}</h2>{isNewNetworkAsset(asset, data.server_time) ? <NewDeviceBadge /> : null}<p className="mt-1 font-data text-meta text-text-muted">{asset.ip_address ?? "-"}</p></div><Status value={asset.status} /></div><dl className="mt-4 grid grid-cols-2 gap-3 text-meta"><Meta label={t("table.mac")} value={asset.mac_address ?? "-"} /><Meta label={t("table.vendor")} value={asset.vendor ?? "-"} /><Meta label={t("table.os")} value={asset.platform ?? "-"} /><Meta label={t("table.type")} value={typeLabel(asset.device_type, t)} /><Meta label={t("table.ports")} value={t("table.portCount", { count: asset.open_ports.length })} /><Meta label={t("table.lastSeen")} value={dateLabel(asset.last_seen_at, locale)} /></dl><Button className="mt-4 w-full" variant="secondary" onClick={() => setSelected(asset)}>{t("actions.details")}</Button></article>)}</div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-meta">
        <span className="text-text-secondary">{t("pagination.range", { from: (page - 1) * data.pagination.page_size + 1, to: Math.min(page * data.pagination.page_size, data.pagination.total), total: data.pagination.total })}</span>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="text-text-secondary whitespace-nowrap">{t("pagination.page", { page, pages })}</span>
          <PageLink disabled={page <= 1} href={pageHref(query, page - 1)} ariaLabel={t("common:actions.previous")}>{chevronLeft}</PageLink>
          <PageLink disabled={page >= pages} href={pageHref(query, page + 1)} ariaLabel={t("common:actions.next")}>{chevronRight}</PageLink>
        </div>
      </div>
    </> : null}

    {data ? <aside className="mt-6 flex flex-col gap-4 rounded-panel border border-border bg-bg-surface p-4 sm:flex-row sm:items-center sm:justify-between" aria-labelledby="asset-report-cta-title">
      <div><h2 className="font-medium" id="asset-report-cta-title">{t("report.ctaTitle")}</h2><p className="mt-1 text-meta text-text-secondary">{t("report.ctaDescription", { count: data.pagination.total })}</p></div>
      <AssetExportButton query={query} />
    </aside> : null}

    {selected ? <AssetDetail asset={selected} key={selected.id} locale={locale} serverTime={data?.server_time ?? new Date(0).toISOString()} canInspect={canInspect} inspectorAvailable={inspectorAvailable} managedTargets={managedTargets} healthTargetIds={healthTargetIds} medicalLinks={medicalLinks} onClose={() => setSelected(null)} /> : null}
  </section>;
}

function AssetInsights({ data, query }: { data: AssetInventoryData; query: AssetInventoryQuery }) {
  const { t } = useTranslation("assets");
  const hasInsights = data.insights.platforms.length || data.insights.vendors.length || data.insights.vendor_device_types.length;
  return <details className="mt-6 scroll-mt-4 rounded-panel border border-border bg-bg-surface p-4" id="asset-insights"><summary className="cursor-pointer font-medium text-text-primary">{t("insights.title")}<span className="ml-2 text-meta font-normal text-text-muted">{t("insights.compactHint")}</span></summary>
    {hasInsights ? <div className="mt-4 grid gap-4 lg:grid-cols-3"><InsightGroup title={t("insights.platform")} items={data.insights.platforms.map((item) => ({ label: item.value, count: item.count, href: filterHref(query, { platform: item.value }) }))} /><InsightGroup title={t("insights.vendor")} items={data.insights.vendors.map((item) => ({ label: item.value, count: item.count, href: filterHref(query, { vendor: item.value }) }))} /><InsightGroup title={t("insights.vendorType")} items={data.insights.vendor_device_types.map((item) => ({ label: `${item.vendor} · ${typeLabel(item.device_type, t)}`, count: item.count, href: filterHref(query, { vendor: item.vendor, device_type: item.device_type }) }))} /></div>
      : <p className="mt-3 text-meta text-text-muted">{t("insights.empty")}</p>}
  </details>;
}

function InsightGroup({ title, items }: { title: string; items: readonly { label: string; count: number; href: string }[] }) {
  const { t } = useTranslation("assets");
  return <div><h2 className="text-meta font-medium uppercase tracking-wide text-text-secondary">{title}</h2>{items.length ? <div className="mt-2 flex flex-wrap gap-2">{items.slice(0, 8).map((item) => <Link className="rounded-full border border-border px-3 py-1.5 text-meta hover:border-accent hover:text-accent" href={item.href} key={`${item.label}-${item.href}`}>{item.label} <span className="font-data text-text-muted">{item.count}</span></Link>)}</div> : <p className="mt-2 text-meta text-text-muted">{t("insights.unavailable")}</p>}</div>;
}

function AssetDetail({ asset, locale, serverTime, canInspect, inspectorAvailable, managedTargets, healthTargetIds, medicalLinks, onClose }: { asset: AssetRecord; locale: string; serverTime: string; canInspect: boolean; inspectorAvailable: boolean; managedTargets: { id: string; context: string | null }[]; healthTargetIds: string[]; medicalLinks: readonly { network_asset_id: string; medical_equipment_id: string; equipment_code: string; name: string; department: string | null; location: string | null }[]; onClose: () => void }) {
  const { t } = useTranslation("assets");
  const { openDeviceProfile } = useDeviceProfile();
  const { nodes } = useNetworkNodes();
  const [tab, setTab] = useState<"overview" | "network" | "history">("overview");
  const networkNodeRef = validLinkedRef(asset.network_node_ref);
  const healthTargetRef = verifiedLinkedRef(asset.health_target_ref, healthTargetIds);
  const managedTargetRef = verifiedLinkedRef(asset.managed_telemetry_target_ref, managedTargets.map((target) => target.id));
  const managedTarget = managedTargets.find((target) => target.id === managedTargetRef);
  const observedHostTargetRef = validLinkedRef(asset.observed_host_target_ref);
  const inspectorNode = networkNodeRef ? nodes.find((node) => node.id === networkNodeRef) : null;
  const inspectorIp = inspectorNode ? normalizeNetworkNodeIpv4(inspectorNode.ip_address) : null;
  const medicalLink = medicalLinks.find((link) => link.network_asset_id === asset.id) ?? null;
  const links = [
    networkNodeRef ? { href: "/devices", label: t("actions.viewDevice") } : null,
    observedHostTargetRef ? { href: `/snmp/${observedHostTargetRef}/hosts`, label: t("actions.viewObservedHost") } : null,
  ].filter((item): item is { href: string; label: string } => item !== null);
  return <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={t("detail.title")}><button className="absolute inset-0 bg-bg-base/80" type="button" aria-label={t("common:actions.close")} onClick={onClose} /><aside className="relative max-h-[calc(100vh-2rem)] w-full max-w-4xl overflow-y-auto rounded-panel border border-accent bg-bg-surface p-4 shadow-2xl md:p-6">
    <div className="flex items-start justify-between gap-4"><div><p className="text-meta font-medium uppercase tracking-wide text-accent">{t("detail.title")}</p><h2 className="mt-2 text-section font-semibold">{asset.hostname ?? asset.name}</h2>{isNewNetworkAsset(asset, serverTime) ? <NewDeviceBadge /> : null}<p className="mt-1 text-meta text-text-muted">{asset.name}</p></div><Button variant="secondary" onClick={onClose}>{t("common:actions.close")}</Button></div>
    <div className="mt-5 flex flex-wrap gap-2 border-b border-border" role="tablist"><Tab active={tab === "overview"} onClick={() => setTab("overview")}>{t("detail.overview")}</Tab><Tab active={tab === "network"} onClick={() => setTab("network")}>{t("detail.network")}</Tab><Tab active={tab === "history"} onClick={() => setTab("history")}>{t("history.title")}</Tab></div>
    {tab === "overview" ? <><dl className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3"><Meta label={t("table.status")} value={t(`status.${asset.status}`)} /><Meta label={t("table.ip")} value={asset.ip_address ?? "-"} /><Meta label={t("table.mac")} value={asset.mac_address ?? "-"} /><Meta label={t("table.hostname")} value={asset.hostname ?? "-"} /><Meta label={t("table.vendor")} value={asset.vendor ?? "-"} /><Meta label={t("table.os")} value={asset.platform ?? "-"} /><Meta label={t("table.type")} value={typeLabel(asset.device_type, t)} /><Meta label={t("detail.confidence")} value={asset.os_confidence ? t(`confidence.${asset.os_confidence}`) : "-"} /><Meta label={t("detail.firstSeen")} value={dateLabel(asset.first_seen_at, locale)} /><Meta label={t("table.lastSeen")} value={dateLabel(asset.last_seen_at, locale)} /><Meta label={t("detail.source")} value={t(`source.${asset.source}`, { defaultValue: asset.source })} /></dl><p className="mt-3 text-meta text-text-muted">{t("detail.confidenceHelp")}</p>
      <p className="mt-1 text-meta text-text-muted">{t("detail.vendorHelp")}</p>{asset.classification_evidence.length ? <div className="mt-5"><h3 className="font-medium">{t("detail.evidence")}</h3><ul className="mt-2 grid gap-2 sm:grid-cols-2">{asset.classification_evidence.map((item, index) => <li className="rounded-control border border-border bg-bg-base p-3 text-meta" key={`${item.source}-${item.label}-${index}`}><span className="font-medium">{item.label}</span><span className="mt-1 block text-text-muted">{item.value} · {item.source}</span></li>)}</ul></div> : null}</>
      : tab === "network" ? <div className="mt-5"><dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"><Meta label={t("detail.latency")} value={asset.latency_ms === null ? "-" : `${asset.latency_ms.toFixed(2)} ms`} /><Meta label={t("table.ports")} value={t("table.portCount", { count: asset.open_ports.length })} /><Meta label={t("detail.evidenceUpdated")} value={dateLabel(asset.evidence_updated_at, locale)} /></dl>{asset.detected_services.length ? <div className="mt-5"><h3 className="font-medium">{t("detail.services")}</h3><ul className="mt-2 grid gap-2 sm:grid-cols-2">{asset.detected_services.map((service) => <li className="rounded-control border border-border bg-bg-base p-3" key={`${service.protocol}-${service.port}`}><div><span>{service.name}</span><span className="ml-2 font-data text-meta text-text-muted">{service.protocol.toUpperCase()}/{service.port}</span></div>{service.product || service.version || service.extra_info ? <p className="mt-1 text-meta text-text-secondary">{[service.product, service.version, service.extra_info].filter(Boolean).join(" · ")}</p> : null}</li>)}</ul></div> : <p className="mt-5 text-meta text-text-muted">{t("detail.noServices")}</p>}</div>
        : <AssetDetailHistory assetId={asset.id} locale={locale} />}
    <AssetIdentityPanel key={asset.id} assetId={asset.id} />
    <section className="mt-6 border-t border-border pt-5" aria-labelledby="asset-integrations-title">
      <h3 className="text-section font-semibold" id="asset-integrations-title">{t("detail.integrations.title")}</h3>
      <p className="mt-1 text-meta text-text-muted">{t("detail.integrations.description")}</p>
      <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <IntegrationCard title={t("detail.integrations.snmp.title")} status={t(managedTargetRef ? "detail.integrations.snmp.linked" : "detail.integrations.snmp.unlinked")} context={managedTarget?.context ?? null} description={t(managedTargetRef ? "detail.integrations.snmp.linkedDescription" : "detail.integrations.snmp.unlinkedDescription")}>
          {managedTargetRef ? <Link className={integrationActionClass} href={`/snmp?target=${encodeURIComponent(managedTargetRef)}#managed-telemetry-workspace`}>{t("actions.viewSnmp")}</Link> : null}
        </IntegrationCard>
        <IntegrationCard title={t("detail.integrations.health.title")} status={t(healthTargetRef ? "detail.integrations.health.monitored" : "detail.integrations.health.unmonitored")} description={t(healthTargetRef ? "detail.integrations.health.monitoredDescription" : "detail.integrations.health.unmonitoredDescription")}>
          {healthTargetRef ? <Link className={integrationActionClass} href={`/dashboard?target=${encodeURIComponent(healthTargetRef)}`}>{t("actions.viewHealth")}</Link> : null}
        </IntegrationCard>
        <IntegrationCard title={t("detail.integrations.inspector.title")} status={t(canInspect && inspectorIp && inspectorAvailable ? "detail.integrations.inspector.available" : "detail.integrations.inspector.unavailable")} description={t(!networkNodeRef || !inspectorIp ? "detail.integrations.inspector.inventoryRequired" : !canInspect ? "detail.integrations.inspector.operatorRequired" : !inspectorAvailable ? "detail.integrations.inspector.runnerUnavailable" : "detail.integrations.inspector.description")}>
          {canInspect && inspectorIp && inspectorAvailable ? <Button variant="secondary" onClick={() => openDeviceProfile({ ipAddress: inspectorIp, inspect: true })}>{t("actions.openInspector")}</Button> : null}
        </IntegrationCard>
        <IntegrationCard title={t("detail.integrations.medical.title")} status={t(medicalLink ? "detail.integrations.medical.linked" : "detail.integrations.medical.unlinked")} context={medicalLink ? `${medicalLink.name} · ${[medicalLink.department, medicalLink.location].filter(Boolean).join(" · ") || medicalLink.equipment_code}` : null} description={t(medicalLink ? "detail.integrations.medical.linkedDescription" : "detail.integrations.medical.unlinkedDescription")}>
          {medicalLink ? <Link className={integrationActionClass} href={`/medical-equipment/${medicalLink.medical_equipment_id}`}>{t("detail.integrations.medical.open")}</Link> : null}
        </IntegrationCard>
      </div>
    </section>
    {links.length ? <div className="mt-5 flex flex-wrap gap-2">{links.map((link) => <Link className={integrationActionClass} href={link.href} key={link.href}>{link.label}</Link>)}</div> : null}
  </aside></div>;
}

function IntegrationCard({ title, status, context = null, description, children }: { title: string; status: string; context?: string | null; description: string; children: React.ReactNode }) {
  return <div className="rounded-control border border-border bg-bg-base p-4"><p className="text-meta font-medium uppercase tracking-wide text-text-secondary">{title}</p><p className="mt-2 font-medium text-text-primary">{status}</p>{context ? <p className="mt-1 break-words font-data text-meta text-text-secondary">{context}</p> : null}<p className="mt-1 text-meta text-text-muted">{description}</p>{children ? <div className="mt-3">{children}</div> : null}</div>;
}

function AssetDetailHistory({ assetId, locale }: { assetId: string; locale: string }) {
  const { t } = useTranslation("assets");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AssetChangeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void getAssetChangeHistoryAction(assetId, page)
      .then((result) => {
        if (!active) return;
        setData(result.data);
        setFailed(Boolean(result.error));
        setLoading(false);
      })
      .catch(() => {
        if (!active) return;
        setData(null);
        setFailed(true);
        setLoading(false);
      });
    return () => { active = false; };
  }, [assetId, page]);
  if (loading) return <p className="mt-5 text-text-secondary">{t("history.loading")}</p>;
  if (failed || !data) return <p className="mt-5 text-severity-critical">{t("history.unavailable")}</p>;
  if (!data.events.length) return <p className="mt-5 text-text-secondary">{t("history.empty")}</p>;
  return <div className="mt-5"><AssetChangeList compact events={data.events} locale={locale} />{data.pagination.pages > 1 ? <div className="mt-4 flex items-center justify-between gap-3"><Button disabled={page <= 1} variant="secondary" onClick={() => { setLoading(true); setPage((value) => Math.max(1, value - 1)); }}>{t("common:actions.previous")}</Button><span className="text-meta text-text-muted">{t("history.page", { page, pages: data.pagination.pages })}</span><Button disabled={page >= data.pagination.pages} variant="secondary" onClick={() => { setLoading(true); setPage((value) => Math.min(data.pagination.pages, value + 1)); }}>{t("common:actions.next")}</Button></div> : null}</div>;
}

function NewDeviceBadge() {
  const { t } = useTranslation("assets");
  return <span className="inline-flex shrink-0 whitespace-nowrap rounded-full border border-accent px-2 py-0.5 text-meta font-medium uppercase text-accent">{t("history.newDevice")}</span>;
}

function Summary({ label, value }: { label: string; value: number }) { return <div className="rounded-panel border border-border bg-bg-surface p-4"><p className="text-meta text-text-secondary">{label}</p><p className="mt-2 font-data text-title text-accent">{value}</p></div>; }
function Status({ value }: { value: AssetStatus }) { const { t } = useTranslation("assets"); return <span className={`inline-flex rounded-full px-2 py-1 text-meta font-medium ${value === "online" ? "bg-severity-low/10 text-severity-low" : value === "offline" ? "bg-severity-critical/10 text-severity-critical" : value === "changed" ? "bg-severity-medium/10 text-severity-medium" : "bg-text-muted/10 text-text-muted"}`}>{t(`status.${value}`)}</span>; }
function Meta({ label, value }: { label: string; value: string }) { return <div className="min-w-0 rounded-control border border-border bg-bg-base p-3"><dt className="text-meta text-text-muted">{label}</dt><dd className="mt-1 break-words text-body">{value}</dd></div>; }
function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) { return <button className={`border-b-2 px-3 py-2 text-body font-medium ${active ? "border-accent text-accent" : "border-transparent text-text-secondary"}`} role="tab" aria-selected={active} type="button" onClick={onClick}>{children}</button>; }
function ActiveFilter({ label, value, href }: { label: string; value: string; href: string }) { const { t } = useTranslation("assets"); return <Link className="rounded-full border border-accent px-3 py-1.5 text-accent" href={href}>{label}: {value} <span aria-hidden="true">×</span><span className="sr-only"> {t("filters.remove")}</span></Link>; }
function dateLabel(value: string | null, locale: string) { return value ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "-"; }
function timeLabel(value: string, locale: string) { return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", timeZoneName: "short" }).format(new Date(value)); }
function typeLabel(value: string, t: (key: string, options?: Record<string, unknown>) => string) { return t(`types.${value}`, { defaultValue: value.replaceAll("_", " ") }); }
function pageHref(query: AssetInventoryQuery, page: number) { return filterHref(query, { page: String(Math.max(1, page)) }); }
function filterHref(query: AssetInventoryQuery, changes: Partial<Record<keyof AssetInventoryQuery, string | null>>) { const params = new URLSearchParams(); for (const key of ["q", "device_type", "vendor", "platform", "status", "sort", "page_size"] as const) if (query[key]) params.set(key, query[key] ?? ""); for (const [key, value] of Object.entries(changes)) { if (value) params.set(key, value); else params.delete(key); } if (!("page" in changes)) params.set("page", "1"); return `/assets?${params}`; }
function PageLink({ href, disabled, children, ariaLabel }: { href: string; disabled: boolean; children: string; ariaLabel: string }) {
  if (disabled) {
    return <span className="rounded-control border border-border px-3 py-2 text-text-muted" aria-disabled="true" aria-label={ariaLabel}>{children}</span>;
  }
  return <Link className="rounded-control border border-border px-3 py-2 text-text-primary hover:border-accent hover:text-accent transition-colors" href={href} scroll={false} aria-label={ariaLabel}>{children}</Link>;
}
function hasFilters(query: AssetInventoryQuery) { return Boolean(query.q || query.device_type || query.vendor || query.platform || query.status || query.sort || query.page || query.page_size); }
function validLinkedRef(value: string | null) { return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null; }
function verifiedLinkedRef(value: string | null, availableIds: string[]) { const valid = validLinkedRef(value); return valid && availableIds.includes(valid) ? valid : null; }
const integrationActionClass = "inline-flex rounded-control border border-border px-4 py-2 text-body font-medium text-text-primary transition-colors hover:border-accent hover:text-accent";
