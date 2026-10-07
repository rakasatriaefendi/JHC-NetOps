"use client";

import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutationPending } from "@/components/ui/mutation-form";
import { DEFAULT_MONITORING_INTERVAL, intervalForMode, isMonitoringInterval, monitoringMode,
  type MonitoringInterval, type MonitoringMode } from "@/lib/monitoring-modes";

export function MonitoringModeLabel({ interval }: { interval: number }) {
  const { t } = useTranslation("common");
  const mode = monitoringMode(interval);
  return <span>{t(mode ? `monitoring.modes.${mode}` : "monitoring.legacy")} · {t(`monitoring.intervals.${interval}`, { defaultValue: t("monitoring.seconds", { count: interval }) })}</span>;
}

export function MonitoringModeSelector({ currentInterval = DEFAULT_MONITORING_INTERVAL, name, editable = true }: {
  currentInterval?: number; name: "probe_interval_seconds" | "poll_interval_seconds"; editable?: boolean;
}) {
  const { t } = useTranslation("common");
  const { pending } = useMutationPending();
  const id = useId();
  const [interval, setInterval] = useState<MonitoringInterval>(() => isMonitoringInterval(currentInterval) ? currentInterval : DEFAULT_MONITORING_INTERVAL);
  const [aggressive, setAggressive] = useState(() => monitoringMode(currentInterval) === "aggressive" ? currentInterval : 60);
  const mode = monitoringMode(interval)!;
  if (!editable) return <MonitoringModeLabel interval={currentInterval} />;
  return <fieldset disabled={pending} className="min-w-0 rounded-control border border-border p-3">
    <legend className="px-1 text-meta text-text-secondary">{t("monitoring.title")}</legend>
    <div className="flex flex-wrap gap-2">{(["aggressive", "moderate", "resource_saver"] as const).map((value: MonitoringMode) =>
      <button key={value} type="button" aria-pressed={mode === value} onClick={() => setInterval(intervalForMode(value, aggressive))}
        className={`rounded-control border px-3 py-2 text-meta disabled:opacity-60 ${mode === value ? "border-accent bg-accent/10 text-accent" : "border-border text-text-secondary"}`}>
        {t(`monitoring.modes.${value}`)}
      </button>)}</div>
    {mode === "aggressive" ? <div className="mt-3 grid gap-2">
      <label htmlFor={id} className="text-meta text-text-secondary">{t("monitoring.interval")}</label>
      <select id={id} value={interval} onChange={(event) => {
        const value = Number(event.target.value);
        if (value === 15 || value === 30 || value === 60) { setAggressive(value); setInterval(value); }
      }} className="min-w-0 rounded-control border border-border bg-bg-base px-3 py-2 text-body">
        {[15, 30, 60].map((value) => <option key={value} value={value}>{t(`monitoring.intervals.${value}`)}</option>)}
      </select>
    </div> : <p className="mt-3 text-meta font-medium">{t(`monitoring.intervals.${interval}`)}</p>}
    <input type="hidden" name={name} value={interval} />
    <p className="mt-2 text-meta text-text-muted">{t(`monitoring.help.${mode}`)}</p>
    {!isMonitoringInterval(currentInterval) ? <p className="mt-2 text-meta text-text-muted">{t("monitoring.legacyHelp", { count: currentInterval })}</p> : null}
  </fieldset>;
}
