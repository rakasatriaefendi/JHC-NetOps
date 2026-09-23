"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { getDiagnosticHistoryAction } from "@/app/actions/diagnostics";
import { DiagnosticHistoryTable } from "@/components/history/diagnostic-history-table";
import { DiagnosticTrendChart } from "@/components/history/diagnostic-trend-chart";
import {
  emptyHistoryData,
  filterDiagnosticTests,
  groupComparableDiagnosticTests,
  groupDiagnosticTests,
  resolveHistoryRange,
  summarizeDiagnosticTests,
  type DiagnosticHistoryQuery,
  type DiagnosticTest,
  type HistoryPeriod,
  type SeriesSummary,
} from "@/lib/diagnostic-history";
import type { ConnectionType } from "@/lib/diagnostics";

export function DiagnosticHistoryPanel() {
  const { t } = useTranslation("history");
  const today = useMemo(() => formatDateInput(new Date()), []);
  const [source, setSource] = useState("all");
  const [target, setTarget] = useState("all");
  const [connectionType, setConnectionType] = useState<"all" | ConnectionType>("wifi");
  const [period, setPeriod] = useState<HistoryPeriod>("today");
  const [customStart, setCustomStart] = useState(today);
  const [customEnd, setCustomEnd] = useState(today);
  const [includeDevelopment, setIncludeDevelopment] = useState(false);
  const [rawData, setRawData] = useState(emptyHistoryData);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [selectedDetail, setSelectedDetail] = useState<DiagnosticTest | null>(null);
  const [trendGroupKey, setTrendGroupKey] = useState("");

  const query = useMemo<DiagnosticHistoryQuery | null>(() => {
    const range = resolveHistoryRange(period, new Date(), customStart, customEnd);
    return range ? {
      source,
      target,
      connectionType,
      includeDevelopment,
      ...range,
    } : null;
  }, [connectionType, customEnd, customStart, includeDevelopment, period, source, target]);

useEffect(() => {
    if (!query) {
      return;
    }
    let cancelled = false;
    void getDiagnosticHistoryAction(query).then((result) => {
      if (cancelled) return;
      setRawData(result.data);
      setLoadError(!result.ok);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [query]);

  const groupedTests = useMemo(
    () => groupDiagnosticTests(rawData, includeDevelopment),
    [includeDevelopment, rawData],
  );
  const tests = useMemo(
    () => query ? filterDiagnosticTests(groupedTests, query) : [],
    [groupedTests, query],
  );
  const trendGroups = useMemo(() => groupComparableDiagnosticTests(tests), [tests]);
  const activeTrendGroup =
    trendGroups.find((group) => group.key === trendGroupKey) ?? trendGroups[0] ?? null;
  const chartTests = activeTrendGroup?.tests ?? [];
  const summary = summarizeDiagnosticTests(chartTests);
  const sources = useMemo(
    () => optionValues(groupedTests.map((test) => test.sourceLabel), source),
    [groupedTests, source],
  );
  const targets = useMemo(
    () => optionValues(groupedTests.map((test) => test.targetLabel), target),
    [groupedTests, target],
  );

  return (
    <div className="mt-6 grid gap-6">
      <section className="rounded-panel border border-border bg-bg-surface p-4 md:p-6">
        <p className="text-meta font-medium uppercase tracking-wide text-accent">{t("diagnostics.eyebrow")}</p>
        <h2 className="mt-2 text-section font-semibold">{t("diagnostics.title")}</h2>
        <p className="mt-2 text-text-secondary">
          {t("diagnostics.description")}
        </p>

        <HistoryFilters
          connectionType={connectionType}
          customEnd={customEnd}
          customStart={customStart}
          includeDevelopment={includeDevelopment}
          period={period}
          source={source}
          sources={sources}
          target={target}
          targets={targets}
          onConnectionChange={setConnectionType}
          onCustomEndChange={setCustomEnd}
          onCustomStartChange={setCustomStart}
          onDevelopmentChange={setIncludeDevelopment}
          onPeriodChange={setPeriod}
          onSourceChange={setSource}
          onTargetChange={setTarget}
        />

        {!query ? (
          <Notice tone="warning">{t("diagnostics.invalidRange")}</Notice>
        ) : null}
        {includeDevelopment ? (
          <Notice tone="warning">
            {t("diagnostics.developmentWarning")}
          </Notice>
        ) : null}
        {loadError ? (
          <Notice tone="critical">{t("diagnostics.loadError")}</Notice>
        ) : null}

        <div className="mt-6">
          <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <h3 className="text-section font-medium">{t("diagnostics.summaryTitle")}</h3>
              <p className="mt-1 text-meta text-text-muted">
                {t("diagnostics.summaryHelp")}
              </p>
            </div>
            <TrendGroupSelect
              groups={trendGroups}
              value={activeTrendGroup?.key ?? ""}
              onChange={setTrendGroupKey}
            />
          </div>
          <HistorySummary summary={summary} />
        </div>

        <div className="mt-6 border-t border-border pt-6">
          <h3 className="text-section font-medium">{t("diagnostics.chartTitle")}</h3>
          <p className="mt-1 text-meta text-text-muted">
            {t("diagnostics.timezone")}
          </p>
          <div className="mt-4">
            {query && loading ? (
              <PanelMessage>{t("diagnostics.loadingHistory")}</PanelMessage>
            ) : activeTrendGroup ? (
              <DiagnosticTrendChart
                period={period}
                tests={chartTests}
                onOpenDetail={setSelectedDetail}
              />
            ) : (
              <PanelMessage>{t("diagnostics.emptySeries")}</PanelMessage>
            )}
          </div>
        </div>

        <div className="mt-6 border-t border-border pt-6">
          <h3 className="text-section font-medium">{t("diagnostics.recentTitle")}</h3>
          <p className="mt-1 text-meta text-text-muted">
            {t("diagnostics.recentHelp")}
          </p>
          <div className="mt-4">
            {query && loading ? (
              <PanelMessage>{t("diagnostics.loadingTests")}</PanelMessage>
            ) : (
              <DiagnosticHistoryTable
                selectedTest={selectedDetail}
                tests={tests}
                onSelect={setSelectedDetail}
              />
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function TrendGroupSelect({
  groups,
  value,
  onChange,
}: {
  groups: ReturnType<typeof groupComparableDiagnosticTests>;
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation("history");
  if (!groups.length) return null;
  return (
    <label className="grid min-w-0 gap-2 text-meta font-medium text-text-secondary md:min-w-80">
      {t("diagnostics.trendSeries")}
      <select
        className="rounded-control border border-border bg-bg-base px-3 py-2 text-body text-text-primary outline-none focus:border-accent"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {groups.map((group) => (
          <option key={group.key} value={group.key}>{group.label}</option>
        ))}
      </select>
    </label>
  );
}

function HistoryFilters({
  source,
  sources,
  target,
  targets,
  connectionType,
  period,
  customStart,
  customEnd,
  includeDevelopment,
  onSourceChange,
  onTargetChange,
  onConnectionChange,
  onPeriodChange,
  onCustomStartChange,
  onCustomEndChange,
  onDevelopmentChange,
}: {
  source: string;
  sources: string[];
  target: string;
  targets: string[];
  connectionType: "all" | ConnectionType;
  period: HistoryPeriod;
  customStart: string;
  customEnd: string;
  includeDevelopment: boolean;
  onSourceChange: (value: string) => void;
  onTargetChange: (value: string) => void;
  onConnectionChange: (value: "all" | ConnectionType) => void;
  onPeriodChange: (value: HistoryPeriod) => void;
  onCustomStartChange: (value: string) => void;
  onCustomEndChange: (value: string) => void;
  onDevelopmentChange: (value: boolean) => void;
}) {
  const { t } = useTranslation("history");
  return (
    <div className="mt-6 rounded-control border border-border bg-bg-base p-4">
      <div className="grid gap-4 md:grid-cols-4">
        <Select label={t("diagnostics.source")} value={source} options={[{ value: "all", label: t("diagnostics.all") }, ...sources.map(option)]} onChange={onSourceChange} />
        <Select label={t("diagnostics.target")} value={target} options={[{ value: "all", label: t("diagnostics.all") }, ...targets.map(option)]} onChange={onTargetChange} />
        <Select
          label={t("diagnostics.connection")}
          value={connectionType}
          options={[{ value: "all", label: t("diagnostics.all") }, { value: "wifi", label: "WiFi" }, { value: "ethernet", label: "Ethernet" }]}
          onChange={(value) => onConnectionChange(value as "all" | ConnectionType)}
        />
        <Select
          label={t("diagnostics.period")}
          value={period}
          options={[{ value: "today", label: t("diagnostics.today") }, { value: "7d", label: t("diagnostics.last7") }, { value: "30d", label: t("diagnostics.last30") }, { value: "custom", label: t("diagnostics.custom") }]}
          onChange={(value) => onPeriodChange(value as HistoryPeriod)}
        />
      </div>
      {period === "custom" ? (
        <div className="mt-4 grid gap-4 md:max-w-xl md:grid-cols-2">
          <DateInput label={t("diagnostics.startDate")} value={customStart} onChange={onCustomStartChange} />
          <DateInput label={t("diagnostics.endDate")} value={customEnd} onChange={onCustomEndChange} />
        </div>
      ) : null}
      <label className="mt-4 flex items-start gap-3 text-body text-text-secondary">
        <input
          checked={includeDevelopment}
          className="mt-1 accent-accent"
          onChange={(event) => onDevelopmentChange(event.target.checked)}
          type="checkbox"
        />
        <span>
          {t("diagnostics.showDevelopment")}
          <span className="mt-1 block text-meta text-text-muted">{t("diagnostics.developmentHelp")}</span>
        </span>
      </label>
    </div>
  );
}

function HistorySummary({ summary }: { summary: ReturnType<typeof summarizeDiagnosticTests> }) {
  const { t } = useTranslation("history");
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <div className="rounded-control border border-border bg-bg-base p-4">
        <p className="text-meta font-medium text-text-secondary">{t("diagnostics.testsPerformed")}</p>
        <p className="mt-2 font-data text-heading font-semibold text-accent">{summary.testsPerformed}</p>
        <p className="mt-1 text-meta text-text-muted">{t("diagnostics.testsHelp")}</p>
      </div>
      <SeriesSummaryCard label={t("diagnostics.upload")} summary={summary.upload} />
      <SeriesSummaryCard label={t("diagnostics.download")} summary={summary.download} />
    </div>
  );
}

function SeriesSummaryCard({ label, summary }: { label: string; summary: SeriesSummary }) {
  const { t } = useTranslation("history");
  return (
    <div className="rounded-control border border-border bg-bg-base p-4">
      <p className="text-meta font-medium text-text-secondary">{label}</p>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-meta">
        <Metric label={t("diagnostics.latest")} value={summary.latest} />
        <Metric label={t("diagnostics.average")} value={summary.average} />
        <Metric label={t("diagnostics.highest")} value={summary.highest} />
        <Metric label={t("diagnostics.lowest")} value={summary.lowest} />
      </dl>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number | null }) {
  return <div><dt className="text-text-muted">{label}</dt><dd className="mt-1 font-data text-text-primary">{formatMbps(value)}</dd></div>;
}

function Select({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void }) {
  return <label className="grid gap-2 text-meta font-medium text-text-secondary">{label}<select className="rounded-control border border-border bg-bg-surface px-3 py-2 text-body text-text-primary outline-none focus:border-accent" value={value} onChange={(event) => onChange(event.target.value)}>{options.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>;
}

function DateInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="grid gap-2 text-meta font-medium text-text-secondary">{label}<input className="rounded-control border border-border bg-bg-surface px-3 py-2 font-data text-body text-text-primary outline-none focus:border-accent" type="date" value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}

function Notice({ children, tone }: { children: React.ReactNode; tone: "warning" | "critical" }) {
  return <div className={`mt-4 rounded-control border bg-bg-base p-4 text-body ${tone === "critical" ? "border-severity-critical text-severity-critical" : "border-severity-medium text-text-secondary"}`}>{children}</div>;
}

function PanelMessage({ children }: { children: React.ReactNode }) {
  return <div className="rounded-control border border-border bg-bg-base p-4 text-text-secondary">{children}</div>;
}

function option(value: string) { return { value, label: value }; }
function optionValues(values: string[], selected: string) { return Array.from(new Set([...values, ...(selected === "all" ? [] : [selected])])).sort(); }
function formatDateInput(date: Date) { const offset = date.getTimezoneOffset() * 60_000; return new Date(date.getTime() - offset).toISOString().slice(0, 10); }
function formatMbps(value: number | null) { return value === null ? "-" : `${value.toFixed(2)} Mbps`; }
