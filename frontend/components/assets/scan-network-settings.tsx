"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  createScanNetworkAction,
  deleteScanNetworkAction,
  getDetectedScanNetworksAction,
  getScanNetworksAction,
  testScanNetworkAction,
  updateScanNetworkAction,
} from "@/app/actions/assets";
import { Button } from "@/components/ui/button";
import type { ConfiguredScanNetwork, DetectedScanNetwork, ScanNetworkRoute } from "@/lib/scan-network-contract";

type Props = Readonly<{
  canManage: boolean;
  onClose: () => void;
  onNetworksChanged: () => Promise<void>;
}>;

export function ScanNetworkSettings({ canManage, onClose, onNetworksChanged }: Props) {
  const { t } = useTranslation("assets");
  const [networks, setNetworks] = useState<readonly ConfiguredScanNetwork[]>([]);
  const [detected, setDetected] = useState<readonly DetectedScanNetwork[]>([]);
  const [detectorAvailable, setDetectorAvailable] = useState(true);
  const [name, setName] = useState("");
  const [cidr, setCidr] = useState("");
  const [route, setRoute] = useState<ScanNetworkRoute | null>(null);
  const [configuredRoutes, setConfiguredRoutes] = useState<Readonly<Record<string, ScanNetworkRoute>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    const [configured, auto] = await Promise.all([getScanNetworksAction(), getDetectedScanNetworksAction()]);
    if (configured.data) setNetworks(configured.data); else setError(configured.error ?? "SCAN_NETWORKS_UNAVAILABLE");
    if (auto.data) { setDetected(auto.data.networks); setDetectorAvailable(auto.data.available); }
    else setDetectorAvailable(false);
  }

  useEffect(() => {
    let cancelled = false;
    void Promise.all([getScanNetworksAction(), getDetectedScanNetworksAction()]).then(([configured, auto]) => {
      if (cancelled) return;
      if (configured.data) setNetworks(configured.data); else setError(configured.error ?? "SCAN_NETWORKS_UNAVAILABLE");
      if (auto.data) { setDetected(auto.data.networks); setDetectorAvailable(auto.data.available); }
      else setDetectorAvailable(false);
    });
    return () => { cancelled = true; };
  }, []);

  async function testRoute(candidate: string, destination: "form" | "configured") {
    if (!canManage || busy || !candidate.trim()) return;
    setBusy(true); setError(null);
    if (destination === "form") setRoute(null);
    const result = await testScanNetworkAction(candidate);
    if (result.data) {
      const testedRoute = result.data;
      if (destination === "form") setRoute(testedRoute);
      else {
        setConfiguredRoutes((current) => ({ ...current, [candidate]: testedRoute }));
        setNetworks((current) => current.map((network) => network.cidr === candidate ? { ...network, ...testedRoute } : network));
      }
    }
    else setError(result.error ?? "SCAN_NETWORKS_UNAVAILABLE");
    setBusy(false);
  }

  async function addNetwork(candidate: { name: string; cidr: string; origin: "manual" | "detected" }) {
    if (!canManage || busy) return;
    setBusy(true); setError(null);
    const result = await createScanNetworkAction(candidate.name, candidate.cidr, candidate.origin);
    if (result.ok) {
      setName(""); setCidr(""); setRoute(null);
      await reload(); await onNetworksChanged();
    } else setError(result.error ?? "SCAN_NETWORKS_UNAVAILABLE");
    setBusy(false);
  }

  async function mutate(action: () => Promise<{ ok: boolean; error: string | null }>) {
    if (!canManage || busy) return;
    setBusy(true); setError(null);
    const result = await action();
    if (result.ok) { await reload(); await onNetworksChanged(); }
    else setError(result.error ?? "SCAN_NETWORKS_UNAVAILABLE");
    setBusy(false);
  }

  return <div className="fixed inset-0 z-50 flex items-center justify-center p-3 md:p-6" role="dialog" aria-modal="true" aria-label={t("scanNetworks.title")}>
    <button aria-label={t("common:actions.close")} className="absolute inset-0 bg-bg-base/80" onClick={onClose} type="button" />
    <div className="relative max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-panel border border-accent bg-bg-surface p-4 shadow-2xl md:p-6">
      <div className="flex items-start justify-between gap-3">
        <div><p className="text-meta font-medium uppercase tracking-wide text-accent">{t("scanNetworks.eyebrow")}</p><h2 className="mt-1 text-section font-semibold">{t("scanNetworks.title")}</h2><p className="mt-2 max-w-2xl text-meta text-text-secondary">{t("scanNetworks.description")}</p></div>
        <Button variant="secondary" onClick={onClose}>{t("common:actions.close")}</Button>
      </div>

      <section className="mt-6" aria-labelledby="detected-networks-title">
        <h3 className="font-semibold" id="detected-networks-title">{t("scanNetworks.detected.title")}</h3>
        {!detectorAvailable ? <p className="mt-2 rounded-control border border-severity-medium/50 bg-severity-medium/5 p-3 text-meta text-text-secondary">{t("scanNetworks.detected.unavailable")}</p> : null}
        {detected.length ? <div className="mt-3 grid gap-3 md:grid-cols-2">{detected.map((item) => {
          const configured = networks.some((network) => network.cidr === item.cidr);
          return <div className="rounded-control border border-border bg-bg-base p-4" key={`${item.interface_name}:${item.cidr}`}>
            <p className="font-data font-medium">{item.cidr}</p><p className="mt-1 text-meta text-text-secondary">{t("scanNetworks.via", { interface: item.interface_name })} · {t("scanNetworks.route.direct")}</p>
            {canManage ? <Button className="mt-3" disabled={busy || configured} variant="secondary" onClick={() => void addNetwork({ name: "", cidr: item.cidr, origin: "detected" })}>{configured ? t("scanNetworks.detected.configured") : t("scanNetworks.detected.use")}</Button> : null}
          </div>;
        })}</div> : detectorAvailable ? <p className="mt-2 text-meta text-text-muted">{t("scanNetworks.detected.empty")}</p> : null}
      </section>

      <section className="mt-7 border-t border-border pt-6" aria-labelledby="configured-networks-title">
        <h3 className="font-semibold" id="configured-networks-title">{t("scanNetworks.configured.title")}</h3>
        {networks.length ? <div className="mt-3 grid gap-3">{networks.map((item) => <ConfiguredNetworkCard busy={busy} canManage={canManage} key={item.id} network={item} testedRoute={configuredRoutes[item.cidr] ?? null}
          onDelete={() => {
            if (window.confirm(t("scanNetworks.deleteConfirm", { network: item.name || item.cidr }))) void mutate(() => deleteScanNetworkAction(item.id));
          }}
          onRetest={() => void testRoute(item.cidr, "configured")}
          onSave={(newName) => void mutate(() => updateScanNetworkAction(item.id, { name: newName || null }))}
          onToggle={() => void mutate(() => updateScanNetworkAction(item.id, { enabled: !item.enabled }))}
        />)}</div> : <p className="mt-2 text-meta text-text-muted">{t("scanNetworks.configured.empty")}</p>}
      </section>

      {canManage ? <section className="mt-7 border-t border-border pt-6" aria-labelledby="add-network-title">
        <h3 className="font-semibold" id="add-network-title">{t("scanNetworks.add.title")}</h3>
        <p className="mt-1 text-meta text-text-secondary">{t("scanNetworks.add.help")}</p>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <label className="grid gap-1 text-meta text-text-secondary"><span>{t("scanNetworks.add.name")}</span><input className="rounded-control border border-border bg-bg-base px-3 py-2 text-text-primary" maxLength={100} value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label className="grid gap-1 text-meta text-text-secondary"><span>{t("scanNetworks.add.cidr")}</span><input className="rounded-control border border-border bg-bg-base px-3 py-2 font-data text-text-primary" inputMode="decimal" placeholder="192.168.20.0/24" value={cidr} onChange={(event) => { setCidr(event.target.value); setRoute(null); }} /></label>
        </div>
        {route ? <RouteFeedback route={route} /> : null}
        <div className="mt-4 flex flex-wrap gap-2"><Button disabled={busy || !cidr.trim()} variant="secondary" onClick={() => void testRoute(cidr, "form")}>{t("scanNetworks.test")}</Button><Button disabled={busy || !cidr.trim()} onClick={() => void addNetwork({ name, cidr, origin: "manual" })}>{t("scanNetworks.add.submit")}</Button></div>
      </section> : null}

      {error ? <p className="mt-4 text-meta text-severity-critical" role="alert">{t(`scanNetworks.errors.${safeError(error)}`)}</p> : null}
    </div>
  </div>;
}

function ConfiguredNetworkCard({ network, testedRoute, canManage, busy, onSave, onToggle, onRetest, onDelete }: Readonly<{
  network: ConfiguredScanNetwork; canManage: boolean; busy: boolean;
  testedRoute: ScanNetworkRoute | null;
  onSave: (name: string) => void; onToggle: () => void; onRetest: () => void; onDelete: () => void;
}>) {
  const { t } = useTranslation("assets");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(network.name ?? "");
  return <article className="rounded-control border border-border bg-bg-base p-4">
    <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
      <div className="min-w-0">{editing ? <label className="grid gap-1 text-meta text-text-secondary"><span>{t("scanNetworks.add.name")}</span><input className="rounded-control border border-border bg-bg-surface px-3 py-2 text-text-primary" maxLength={100} value={draft} onChange={(event) => setDraft(event.target.value)} /></label> : <h4 className="font-medium">{network.name || network.cidr}</h4>}<p className="mt-1 font-data text-meta text-text-secondary">{network.cidr}</p></div>
      <div className="flex flex-wrap items-center gap-2 text-meta"><span className={network.enabled ? "text-severity-low" : "text-text-muted"}>{t(network.enabled ? "scanNetworks.enabled" : "scanNetworks.disabled")}</span><span className="text-text-muted">·</span><span>{t(`scanNetworks.route.${network.route_kind}`)}</span></div>
    </div>
    {network.interface_name ? <p className="mt-2 text-meta text-text-muted">{t("scanNetworks.via", { interface: network.interface_name })}{network.gateway ? ` · ${t("scanNetworks.gateway", { gateway: network.gateway })}` : ""}</p> : null}
    {testedRoute ? <RouteFeedback route={testedRoute} /> : null}
    {canManage ? <div className="mt-3 flex flex-wrap gap-2">{editing ? <><Button disabled={busy} onClick={() => { onSave(draft); setEditing(false); }}>{t("common:actions.save")}</Button><Button disabled={busy} variant="secondary" onClick={() => { setDraft(network.name ?? ""); setEditing(false); }}>{t("common:actions.cancel")}</Button></> : <Button disabled={busy} variant="secondary" onClick={() => setEditing(true)}>{t("common:actions.edit")}</Button>}<Button disabled={busy} variant="secondary" onClick={onRetest}>{t("scanNetworks.retest")}</Button><Button disabled={busy} variant="secondary" onClick={onToggle}>{t(network.enabled ? "scanNetworks.disable" : "scanNetworks.enable")}</Button><Button disabled={busy} variant="destructive" onClick={onDelete}>{t("common:actions.delete")}</Button></div> : null}
  </article>;
}

function RouteFeedback({ route }: { route: ScanNetworkRoute }) {
  const { t } = useTranslation("assets");
  return <p className={`mt-3 text-meta ${route.route_kind === "direct" || route.route_kind === "routed" ? "text-severity-low" : "text-severity-medium"}`} role="status">{t(`scanNetworks.routeFeedback.${route.route_kind}`, { cidr: route.cidr })}</p>;
}

function safeError(value: string): string {
  return ["INVALID_SCAN_NETWORK", "SCAN_NETWORK_PUBLIC", "SCAN_NETWORK_TOO_BROAD", "INVALID_SCAN_NETWORK_NAME", "SCAN_NETWORK_DUPLICATE", "SCAN_NETWORK_LIMIT_REACHED", "SCAN_NETWORK_ROUTE_UNAVAILABLE"].includes(value) ? value : "SCAN_NETWORKS_UNAVAILABLE";
}
