"use client";

import { useEffect, useMemo, useState } from "react";

import { DiagnosticHistoryTable } from "@/components/history/diagnostic-history-table";
import { DiagnosticTrendChart } from "@/components/history/diagnostic-trend-chart";
import { createClient } from "@/lib/supabase/client";
import {
  emptyHistoryData,
  filterDiagnosticTests,
  groupComparableDiagnosticTests,
  groupDiagnosticTests,
  loadDiagnosticHistory,
  resolveHistoryRange,
  summarizeDiagnosticTests,
  type DiagnosticHistoryQuery,
  type DiagnosticTest,
  type HistoryPeriod,
  type SeriesSummary,
} from "@/lib/diagnostic-history";
import type { ConnectionType } from "@/lib/diagnostics";

export function DiagnosticHistoryPanel() {
  const supabase = useMemo(() => createClient(), []);
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
    void loadDiagnosticHistory(supabase, query).then((result) => {
      if (cancelled) return;
      setRawData(result.data);
      setLoadError(result.error);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [query, supabase]);

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
        <p className="text-meta font-medium uppercase tracking-wide text-accent">Diagnostic Tests</p>
        <h2 className="mt-2 text-section font-semibold">Bandwidth trend history</h2>
        <p className="mt-2 text-text-secondary">
          Setiap titik mewakili satu job selesai, dengan upload dan download digabung melalui job ID.
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
          <Notice tone="warning">Tanggal awal custom harus sama dengan atau sebelum tanggal akhir.</Notice>
        ) : null}
        {includeDevelopment ? (
          <Notice tone="warning">
            TEST ENVIRONMENT ditampilkan. Hasil localhost bukan performa LAN dan tidak membuktikan bottleneck jaringan.
          </Notice>
        ) : null}
        {loadError ? (
          <Notice tone="critical">History diagnostik gagal dimuat. Periksa sesi login dan deployment fungsi diagnostics.</Notice>
        ) : null}

        <div className="mt-6">
          <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <h3 className="text-section font-medium">Selected trend summary</h3>
              <p className="mt-1 text-meta text-text-muted">
                Statistik hanya menghitung satu source, target, dan connection yang comparable.
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
          <h3 className="text-section font-medium">Upload / Download trend</h3>
          <p className="mt-1 text-meta text-text-muted">
            Waktu pada sumbu dan detail mengikuti timezone lokal browser.
          </p>
          <div className="mt-4">
            {query && loading ? (
              <PanelMessage>Memuat riwayat diagnostik…</PanelMessage>
            ) : activeTrendGroup ? (
              <DiagnosticTrendChart
                period={period}
                tests={chartTests}
                onOpenDetail={setSelectedDetail}
              />
            ) : (
              <PanelMessage>Belum ada series diagnostik yang cocok dengan filter dan periode ini.</PanelMessage>
            )}
          </div>
        </div>

        <div className="mt-6 border-t border-border pt-6">
          <h3 className="text-section font-medium">Recent diagnostic tests</h3>
          <p className="mt-1 text-meta text-text-muted">
            Maksimal 100 job selesai dalam rentang terpilih; upload dan download tampil sebagai satu test.
          </p>
          <div className="mt-4">
            {query && loading ? (
              <PanelMessage>Memuat daftar test…</PanelMessage>
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
  if (!groups.length) return null;
  return (
    <label className="grid min-w-0 gap-2 text-meta font-medium text-text-secondary md:min-w-80">
      Trend series
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
  return (
    <div className="mt-6 rounded-control border border-border bg-bg-base p-4">
      <div className="grid gap-4 md:grid-cols-4">
        <Select label="Source" value={source} options={[{ value: "all", label: "All" }, ...sources.map(option)]} onChange={onSourceChange} />
        <Select label="Target" value={target} options={[{ value: "all", label: "All" }, ...targets.map(option)]} onChange={onTargetChange} />
        <Select
          label="Connection"
          value={connectionType}
          options={[{ value: "all", label: "All" }, { value: "wifi", label: "WiFi" }, { value: "ethernet", label: "Ethernet" }]}
          onChange={(value) => onConnectionChange(value as "all" | ConnectionType)}
        />
        <Select
          label="Period"
          value={period}
          options={[{ value: "today", label: "Today" }, { value: "7d", label: "Last 7 days" }, { value: "30d", label: "Last 30 days" }, { value: "custom", label: "Custom date range" }]}
          onChange={(value) => onPeriodChange(value as HistoryPeriod)}
        />
      </div>
      {period === "custom" ? (
        <div className="mt-4 grid gap-4 md:max-w-xl md:grid-cols-2">
          <DateInput label="Tanggal awal" value={customStart} onChange={onCustomStartChange} />
          <DateInput label="Tanggal akhir" value={customEnd} onChange={onCustomEndChange} />
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
          Show development tests
          <span className="mt-1 block text-meta text-text-muted">Default LAN only; localhost simulation dikecualikan.</span>
        </span>
      </label>
    </div>
  );
}

function HistorySummary({ summary }: { summary: ReturnType<typeof summarizeDiagnosticTests> }) {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <div className="rounded-control border border-border bg-bg-base p-4">
        <p className="text-meta font-medium text-text-secondary">Tests performed</p>
        <p className="mt-2 font-data text-heading font-semibold text-accent">{summary.testsPerformed}</p>
        <p className="mt-1 text-meta text-text-muted">Satu row per diagnostic job</p>
      </div>
      <SeriesSummaryCard label="Upload" summary={summary.upload} />
      <SeriesSummaryCard label="Download" summary={summary.download} />
    </div>
  );
}

function SeriesSummaryCard({ label, summary }: { label: string; summary: SeriesSummary }) {
  return (
    <div className="rounded-control border border-border bg-bg-base p-4">
      <p className="text-meta font-medium text-text-secondary">{label}</p>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-meta">
        <Metric label="Latest" value={summary.latest} />
        <Metric label="Average" value={summary.average} />
        <Metric label="Highest" value={summary.highest} />
        <Metric label="Lowest" value={summary.lowest} />
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
