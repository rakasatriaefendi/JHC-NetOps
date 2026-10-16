"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { Button } from "@/components/ui/button";
import { loadHealthSamples } from "@/lib/network-health";
import type { HealthTrendRange, NetworkHealthTarget } from "@/lib/network-health-client";
import { HEALTH_HISTORY_MAX_TARGETS, HealthHistoryController, healthChartPoints, healthMetricState,
  healthHistoryDefaultTarget, healthHistorySelection, historyKey,
  type HealthHistoryResult } from "@/lib/health-history";

type HealthTrendsProps = { targets: NetworkHealthTarget[]; initialHistory: HealthHistoryResult };

export function NetworkHealthTrends({ targets, initialHistory }: HealthTrendsProps) {
  const { t, i18n } = useTranslation(["dashboard", "common"]);
  const [selectedTargetId, setSelectedTargetId] = useState(() => healthHistoryDefaultTarget(targets.map((target) => target.id)));
  const [range, setRange] = useState<HealthTrendRange>("1h");
  const [metric, setMetric] = useState<"latency" | "loss">("latency");
  const allIds = useMemo(() => targets.map((target) => target.id).sort(), [targets]);
  const allTargetsAllowed = allIds.length <= HEALTH_HISTORY_MAX_TARGETS;
  const effectiveTargetId = selectedTargetId === "__all__" ? healthHistoryDefaultTarget(allIds) : selectedTargetId;
  const [controller] = useState(() => new HealthHistoryController(loadHealthSamples, allIds, initialHistory));
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const selection = useMemo(() => healthHistorySelection(allIds, effectiveTargetId), [allIds, effectiveTargetId]);
  const missingTarget = selection.missing;
  const ids = selection.ids;
  const key = historyKey(ids, range);
  useEffect(() => {
    controller.update(ids, range, initialHistory, allIds);
  }, [controller, ids, range, initialHistory, allIds]);
  useEffect(() => () => controller.cancel(), [controller]);

  const loading = !missingTarget && (snapshot.loading || snapshot.key !== key);
  const result = snapshot.result;
  const samples = result.data;
  const state = healthMetricState(samples, metric);
  const chartData = useMemo(() => healthChartPoints(samples), [samples]);
  const chartTargets = targets.filter((target) => ids.includes(target.id));
  const unit = metric === "latency" ? "ms" : "%";
  const formatTime = (value: string, detailed = false) => new Intl.DateTimeFormat(
    i18n.language === "en" ? "en-US" : "id-ID", {
      ...(detailed || range === "7d" || range === "24h" ? { month: "short", day: "numeric" } as const : {}),
      hour: "2-digit", minute: "2-digit", ...(detailed ? { second: "2-digit" } as const : {}),
    }).format(new Date(value));
  const measurement = (value: number | null, suffix: string) => value === null ? "-" : `${value.toFixed(1)} ${suffix}`;
  const errorKey = result.code === "HEALTH_HISTORY_TARGET_UNAVAILABLE" ? "trends.targetUnavailable"
    : result.code === "INVALID_HEALTH_HISTORY_REQUEST" || result.code === "HEALTH_HISTORY_RESPONSE_TOO_LARGE"
      ? "trends.boundedRequest" : result.code === "UNAUTHORIZED" ? "trends.authError" : "trends.queryError";

  return <section className="mt-6 rounded-panel border border-border bg-bg-surface p-4 md:p-6">
    <h2 className="text-section font-semibold">{t("trends.title")}</h2>
    <p className="mt-2 text-text-secondary">{t("trends.description")}</p>
    <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
      <label className="flex items-center gap-3 text-meta text-text-secondary">
        {t("trends.target")}
        <select className="min-w-0 rounded-control border border-border bg-bg-base px-3 py-2 text-text-primary"
          value={effectiveTargetId} onChange={(event) => setSelectedTargetId(event.target.value)}>
          {allTargetsAllowed ? <option value="__all__">{t("trends.allTargetsCount", { count: targets.length })}</option> : null}
          {missingTarget ? <option value={selectedTargetId}>{t("trends.targetUnavailable")}</option> : null}
          {targets.map((target) => <option key={target.id} value={target.id}>{target.node.name} ({target.node.ip_address})</option>)}
        </select>
      </label>
      <div className="flex items-center gap-2">
        <span className="text-meta text-text-secondary">{t("trends.metric")}</span>
        {(["latency", "loss"] as const).map((value) => <Button key={value}
          variant={metric === value ? "primary" : "secondary"} aria-pressed={metric === value}
          onClick={() => setMetric(value)} className="px-2 py-1 text-sm">
          {t(value === "latency" ? "trends.latency" : "trends.packetLoss")}
        </Button>)}
      </div>
      <label className="flex items-center gap-3 text-meta text-text-secondary">
        {t("trends.range")}
        <select className="rounded-control border border-border bg-bg-base px-3 py-2 text-text-primary"
          value={range} onChange={(event) => setRange(event.target.value as HealthTrendRange)}>
          <option value="1h">{t("trends.oneHour")}</option>
          <option value="6h">{t("trends.hours", { count: 6 })}</option>
          <option value="24h">{t("trends.hours", { count: 24 })}</option>
          <option value="7d">{t("trends.days", { count: 7 })}</option>
        </select>
      </label>
      <Button variant="secondary" disabled={loading || missingTarget || !ids.length}
        onClick={() => controller.refresh()} title={t("trends.refreshHint")}>
        {t(loading ? "trends.loading" : "trends.refresh")}
      </Button>
    </div>
    {!allTargetsAllowed ? <p className="mt-3 text-meta text-text-secondary">{t("trends.allTargetsLimit", { limit: HEALTH_HISTORY_MAX_TARGETS })}</p> : null}
    <div className="mt-4" aria-busy={loading}>
      {missingTarget ? <p role="status" className="rounded-control border border-border p-6 text-text-secondary">{t("trends.targetUnavailable")}</p>
        : loading ? <p role="status" className="rounded-control border border-border p-6 text-text-secondary">{t("trends.loading")}</p>
        : result.error ? <p role="alert" className="rounded-control border border-severity-medium p-6 text-text-secondary">{t(errorKey)}</p>
        : state === "empty" ? <div className="rounded-control border border-border p-6 text-center">
          <p>{t("trends.noHistory")}</p><p className="mt-2 text-meta text-text-muted">{t("trends.wait")}</p>
        </div>
        : state === "metric_unavailable" ? <p role="status" className="rounded-control border border-border p-6 text-text-secondary">
          {t("trends.metricUnavailable", { count: samples.length })}
        </p>
        : <div className="rounded-control border border-border bg-bg-base p-4" style={{ height: 320 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2A2F38" />
              <XAxis dataKey="time" tickFormatter={(value: string) => formatTime(value)} tick={{ fill: "#9AA1AC", fontSize: 11 }} tickLine={false} axisLine={false} tickCount={6} />
              <YAxis domain={metric === "latency" ? [0, "auto"] : [0, 100]} tickFormatter={(value: number) => `${value}${unit}`}
                tick={{ fill: "#9AA1AC", fontSize: 11 }} tickLine={false} axisLine={false} width={metric === "latency" ? 50 : 40} />
              <Tooltip content={({ active, label }) => {
                if (!active || typeof label !== "string") return null;
                const rows = samples.filter((sample) => sample.sampled_at === label);
                return <div className="max-w-xs rounded-control border border-border bg-bg-surface p-3 text-meta text-text-primary">
                  <p>{formatTime(label, true)}</p>
                  {rows.map((row) => <div className="mt-2" key={row.target_id}>
                    <p>{targets.find((target) => target.id === row.target_id)?.node.name ?? row.target_id}</p>
                    <p>{measurement(metric === "latency" ? row.latency_ms : row.packet_loss_percent, unit)}</p>
                    <p>{t("trends.extent", { min: measurement(metric === "latency" ? row.latency_min_ms : row.packet_loss_min_percent, unit),
                      max: measurement(metric === "latency" ? row.latency_max_ms : row.packet_loss_max_percent, unit), count: row.observation_count })}</p>
                    <p>{t("trends.actualWindow", { from: formatTime(row.first_sample_at, true), to: formatTime(row.last_sample_at, true) })}</p>
                    <p>{t(`common:status.${row.status}`)}</p>
                  </div>)}
                </div>;
              }} />
              <Legend formatter={(value: string) => {
                const target = chartTargets.find((item) => `${metric}_${item.id}` === value);
                return target ? `${target.node.name} (${target.node.ip_address})` : value;
              }} />
              {chartTargets.map((target, index) => <Line key={target.id} type="linear" dataKey={`${metric}_${target.id}`}
                stroke={index === 0 ? "#3E9C8A" : `hsl(${index * 137.5 % 360}, 50%, 60%)`} strokeWidth={2}
                dot={samples.filter((sample) => sample.target_id === target.id &&
                  (metric !== "latency" || sample.latency_ms !== null)).length === 1 ? { r: 4 } : false}
                connectNulls={false} isAnimationActive={false} />)}
            </LineChart>
          </ResponsiveContainer>
        </div>}
    </div>
    {!loading && !result.error && !missingTarget && result.metadata ? <p className="mt-3 text-meta text-text-muted">
      {t("trends.aggregation", { seconds: result.metadata.bucket_seconds })}
    </p> : null}
    <p className="mt-3 text-meta text-text-secondary">{t(metric === "latency" ? "trends.latencyHelp" : "trends.lossHelp")}</p>
    <p className="mt-2 text-meta text-text-muted">{t("trends.intervals", {
      intervals: [...new Set(chartTargets.map((target) => target.probe_interval_seconds))].sort((a, b) => a - b).join(", ") || "-",
    })}</p>
  </section>;
}
