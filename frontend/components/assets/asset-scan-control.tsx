"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";

import { cancelAssetScanAction, getAssetScanStateAction, startAssetScanAction } from "@/app/actions/assets";
import { Button } from "@/components/ui/button";
import { ScanNetworkSettings } from "@/components/assets/scan-network-settings";
import type { AssetScanMode, AssetScanState } from "@/lib/asset-scan-contract";

type Props = Readonly<{
  initialState: AssetScanState | null;
  initialError: "unconfigured" | "unavailable" | null;
  canScan: boolean;
}>;

export function AssetScanControl({ initialState, initialError, canScan }: Props) {
  const { t, i18n } = useTranslation("assets");
  const router = useRouter();
  const [state, setState] = useState(initialState);
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mode, setMode] = useState<AssetScanMode>("deep");
  const [network, setNetwork] = useState(initialState?.networks[0] ?? "");
  const [pending, setPending] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const [visible, setVisible] = useState(true);
  const running = state?.current?.status === "running" ? state.current : null;
  const locale = i18n.language === "en" ? "en-US" : "id-ID";

  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    if (!running || !visible) return;
    let cancelled = false;
    let timer = 0;
    const poll = () => {
      timer = window.setTimeout(() => void getAssetScanStateAction().then((result) => {
        if (cancelled) return;
        if (result.data) {
          setState(result.data);
          setErrorCode(null);
          if (!result.data.current) router.refresh();
        } else if (result.error) {
          setErrorCode("ASSET_SCAN_STATE_FAILED");
          poll();
        }
      }), 2_000);
    };
    poll();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [router, running, visible]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);

  async function start() {
    if (!canScan || !state?.available || pending || running || !state.networks.includes(network)) return;
    setPending(true);
    setErrorCode(null);
    const result = await startAssetScanAction(mode, network);
    if (result.data) {
      const scan = result.data;
      setState((current) => current ? { ...current, current: scan } : current);
      setOpen(false);
      setClock(Date.now());
    } else setErrorCode(result.error ?? "ASSET_SCAN_FAILED");
    setPending(false);
  }

  async function cancel() {
    if (!canScan || !running || pending) return;
    setPending(true);
    const result = await cancelAssetScanAction(running.id);
    if (result.data) {
      const scan = result.data;
      setState((current) => current ? { ...current, current: null, last: scan } : current);
      router.refresh();
    } else setErrorCode(result.error ?? "ASSET_SCAN_FAILED");
    setPending(false);
  }

  async function refreshNetworks() {
    const result = await getAssetScanStateAction();
    if (result.data) {
      setState(result.data);
      setNetwork((current) => result.data?.networks.includes(current) ? current : result.data?.networks[0] ?? "");
    }
  }

  return <div className="w-full">
    {!running ? <div className="flex flex-wrap justify-end gap-2"><Button variant="secondary" onClick={() => setSettingsOpen(true)}>{t("scanNetworks.action")}</Button>{canScan ? <Button disabled={!state?.available || Boolean(running)} onClick={() => setOpen(true)}>{t(state?.last ? "scan.repeat" : "scan.action")}</Button> : null}</div> : null}
    {!state?.available ? <p className="mt-2 max-w-sm text-meta text-text-muted">{t(initialError === "unavailable" ? "scan.stateUnavailable" : state?.networks.length === 0 ? "scan.noEnabledNetworks" : "scan.unavailable")}</p> : null}
    {running ? <div className="w-full rounded-panel border border-accent bg-bg-surface p-5" aria-live="polite">
      <p className="text-center font-medium text-accent">{t("scan.running", { mode: t(`scan.mode.${running.mode}.title`) })}</p>
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-4 text-center text-meta"><Metric label={t("scan.discovered")} value={running.discovered_count} /><Metric label={t("scan.fingerprinted")} value={`${running.fingerprinted_count} / ${running.discovered_count}`} /><Metric label={t("scan.failed")} value={running.failed_count} /><Metric label={t("scan.elapsed")} value={durationLabel(clock - Date.parse(running.started_at))} /></dl>
      {running.current_target ? <p className="mt-4 text-center font-data text-meta text-text-secondary">{t("scan.current", { target: running.current_target })}</p> : null}
      {canScan ? <Button className="mt-4 w-full" disabled={pending} variant="destructive" onClick={() => void cancel()}>{t("scan.cancel")}</Button> : null}
    </div> : state?.last ? <div className="mt-3"><p className="text-right text-meta text-text-muted">{t("scan.last", { status: t(`scan.status.${state.last.status}`), found: state.last.discovered_count, enriched: state.last.fingerprinted_count, failed: state.last.failed_count, time: timeLabel(state.last.completed_at ?? state.last.cancelled_at, locale) })}</p><div className="mt-2 flex justify-end"><Link className="rounded-control border border-border px-3 py-2 text-meta text-text-primary transition-colors hover:border-accent hover:text-accent" href="#asset-insights">{t("scan.viewSummary")}</Link></div></div> : null}
    {errorCode ? <p className="mt-2 text-meta text-severity-critical" role="alert">{t(`scan.errors.${safeUiError(errorCode)}`)}</p> : null}

    {open && state?.available ? <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={t("scan.dialogTitle")}>
      <button aria-label={t("common:actions.close")} className="absolute inset-0 bg-bg-base/80" onClick={() => setOpen(false)} type="button" />
      <div className="relative w-full max-w-xl rounded-panel border border-accent bg-bg-surface p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3"><div><p className="text-meta font-medium uppercase tracking-wide text-accent">{t("scan.eyebrow")}</p><h2 className="mt-2 text-section font-semibold">{t("scan.dialogTitle")}</h2></div><Button variant="secondary" onClick={() => setOpen(false)}>{t("common:actions.close")}</Button></div>
        <label className="mt-5 grid gap-1 text-meta text-text-secondary"><span>{t("scan.network")}</span>{state.networks.length === 1 ? <span className="rounded-control border border-border bg-bg-base px-3 py-2 font-data text-text-primary">{networkLabel(state, state.networks[0] ?? "")}</span> : <select className="rounded-control border border-border bg-bg-base px-3 py-2 text-text-primary" value={network} onChange={(event) => setNetwork(event.target.value)}>{state.networks.map((item) => <option key={item} value={item}>{networkLabel(state, item)}</option>)}</select>}</label>
        <fieldset className="mt-5 grid gap-3"><legend className="sr-only">{t("scan.modeLabel")}</legend>{(["quick", "deep"] as const).map((item) => <label className={`cursor-pointer rounded-control border p-4 ${mode === item ? "border-accent" : "border-border"}`} key={item}><span className="flex items-center gap-2"><input checked={mode === item} name="scan-mode" onChange={() => setMode(item)} type="radio" /><strong>{t(`scan.mode.${item}.title`)}</strong></span><span className="mt-1 block pl-6 text-meta text-text-secondary">{t(`scan.mode.${item}.description`)}</span></label>)}</fieldset>
        <Button className="mt-5 w-full" disabled={pending || !network} onClick={() => void start()}>{pending ? t("scan.starting") : t("scan.start", { mode: t(`scan.mode.${mode}.short`) })}</Button>
      </div>
    </div> : null}
    {settingsOpen ? <ScanNetworkSettings canManage={canScan} onClose={() => setSettingsOpen(false)} onNetworksChanged={refreshNetworks} /> : null}
  </div>;
}

function networkLabel(state: AssetScanState, cidr: string): string {
  const option = state.network_options?.find((item) => item.cidr === cidr);
  return option?.name ? `${option.name} — ${cidr}` : cidr;
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return <div><dt className="text-text-muted">{label}</dt><dd className="mt-1 font-data text-text-primary">{value}</dd></div>;
}

function durationLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function timeLabel(value: string | null, locale: string): string {
  return value ? new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "-";
}

function safeUiError(value: string): string {
  return ["SCAN_ALREADY_RUNNING", "SCANNER_UNAVAILABLE", "SCAN_NETWORK_NOT_ALLOWED", "SCAN_NETWORK_ROUTE_UNAVAILABLE", "ASSET_SCAN_STATE_FAILED"].includes(value) ? value : "ASSET_SCAN_FAILED";
}
