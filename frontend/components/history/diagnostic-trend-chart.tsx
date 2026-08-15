"use client";

import { useMemo, useState } from "react";

import {
  buildDiagnosticTrendSeries,
  type DiagnosticTest,
  type DiagnosticTrendPoint,
  type HistoryPeriod,
} from "@/lib/diagnostic-history";

const WIDTH = 760;
const HEIGHT = 300;
const PADDING = { top: 20, right: 20, bottom: 48, left: 56 };

export function DiagnosticTrendChart({
  tests,
  period,
  onOpenDetail,
}: {
  tests: DiagnosticTest[];
  period: HistoryPeriod;
  onOpenDetail: (test: DiagnosticTest) => void;
}) {
  const series = useMemo(() => buildDiagnosticTrendSeries(tests), [tests]);
  const { ordered, upload: uploadPoints, download: downloadPoints } = series;
  const [activeJobId, setActiveJobId] = useState<string | null>(null);

  if (!ordered.length) {
    return <div className="rounded-control border border-border bg-bg-base p-4 text-text-secondary">Belum ada diagnostic test selesai untuk filter dan periode ini.</div>;
  }

  const active = ordered.find((test) => test.jobId === activeJobId) ?? ordered.at(-1)!;
  const values = ordered.flatMap((test) => [test.upload?.bitrate_mbps, test.download?.bitrate_mbps].filter((value): value is number => typeof value === "number"));
  const maxMbps = Math.max(...values, 1);
  const minTime = Date.parse(ordered[0].measuredAt);
  const maxTime = Date.parse(ordered.at(-1)!.measuredAt);
  const plotWidth = WIDTH - PADDING.left - PADDING.right;
  const plotHeight = HEIGHT - PADDING.top - PADDING.bottom;
  const x = (timestamp: string) => PADDING.left + (minTime === maxTime ? plotWidth / 2 : ((Date.parse(timestamp) - minTime) / (maxTime - minTime)) * plotWidth);
  const y = (mbps: number) => PADDING.top + plotHeight - (mbps / maxMbps) * plotHeight;
  const yTicks = [maxMbps, maxMbps / 2, 0];
  const xTicks = axisTimes(minTime, maxTime);

  return (
    <div className="rounded-control border border-border bg-bg-base p-4">
      <div className="flex flex-wrap items-center gap-4 text-meta text-text-secondary">
        <Legend dashed={false} label="Upload" />
        <Legend dashed label="Download" />
        <span className="ml-auto font-data text-text-muted">Y: Mbps · X: waktu pengukuran</span>
      </div>

      <div className="mt-4 overflow-hidden">
        <svg aria-label="Upload dan download Mbps sepanjang waktu" className="h-auto min-w-0 w-full" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
          {yTicks.map((tick, index) => {
            const tickY = PADDING.top + (index / (yTicks.length - 1)) * plotHeight;
            return <g key={`${tick}-${index}`}><line className="stroke-border" x1={PADDING.left} x2={WIDTH - PADDING.right} y1={tickY} y2={tickY} /><text className="fill-text-muted font-data text-meta" textAnchor="end" x={PADDING.left - 8} y={tickY + 4}>{formatAxisMbps(tick)}</text></g>;
          })}

          <path className="fill-none stroke-accent" d={pathFor(uploadPoints, x, y)} strokeWidth="2" />
          <path className="fill-none stroke-accent opacity-60" d={pathFor(downloadPoints, x, y)} strokeDasharray="6 4" strokeWidth="2" />

          {uploadPoints.map(({ test, value }) => <ChartNode key={`upload-${test.jobId}`} active={active.jobId === test.jobId} direction="Upload" test={test} value={value} x={x(test.measuredAt)} y={y(value)} onActivate={() => setActiveJobId(test.jobId)} />)}
          {downloadPoints.map(({ test, value }) => <ChartNode key={`download-${test.jobId}`} active={active.jobId === test.jobId} direction="Download" test={test} value={value} x={x(test.measuredAt)} y={y(value)} onActivate={() => setActiveJobId(test.jobId)} muted />)}

          {xTicks.map((timestamp, index) => (
            <text
              className="fill-text-muted font-data text-meta"
              key={timestamp}
              textAnchor={xTicks.length === 1 ? "middle" : index === 0 ? "start" : index === xTicks.length - 1 ? "end" : "middle"}
              x={x(new Date(timestamp).toISOString())}
              y={HEIGHT - 12}
            >
              {formatAxisTime(new Date(timestamp).toISOString(), period)}
            </text>
          ))}
        </svg>
      </div>

      <PointDetail test={active} onOpenDetail={() => onOpenDetail(active)} />
    </div>
  );
}

function ChartNode({ test, value, x, y, direction, active, muted = false, onActivate }: { test: DiagnosticTest; value: number; x: number; y: number; direction: string; active: boolean; muted?: boolean; onActivate: () => void }) {
  return (
    <circle
      aria-label={`${direction}, ${formatExactTimestamp(test.measuredAt)}, ${formatMbps(value)}`}
      className={`cursor-pointer fill-accent focus:outline-none ${muted ? "opacity-60" : ""}`}
      cx={x}
      cy={y}
      onClick={onActivate}
      onFocus={onActivate}
      onMouseEnter={onActivate}
      r={active ? 5 : 3.5}
      role="button"
      tabIndex={0}
    >
      <title>{direction} · {formatExactTimestamp(test.measuredAt)} · {formatMbps(value)}</title>
    </circle>
  );
}

function PointDetail({ test, onOpenDetail }: { test: DiagnosticTest; onOpenDetail: () => void }) {
  return (
    <div className="mt-4 border-t border-border pt-4">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="font-data text-meta text-text-muted">{formatExactTimestamp(test.measuredAt)}</p>
          <p className="mt-2 font-medium">{test.sourceLabel} → {test.targetLabel}</p>
          <p className="mt-1 text-meta text-text-secondary">{formatConnection(test.connectionType)} · <span className="font-data">{test.targetHost}</span>{test.environment === "localhost_demo" ? " · TEST ENVIRONMENT" : ""}</p>
        </div>
        <button className="rounded-control border border-border px-3 py-2 text-body font-medium text-text-primary hover:border-accent" onClick={onOpenDetail} type="button">View diagnostic detail</button>
      </div>
      <dl className="mt-4 grid gap-3 text-meta sm:grid-cols-2 lg:grid-cols-4">
        <PointMetric label="Upload" value={formatMbps(test.upload?.bitrate_mbps)} />
        <PointMetric label="Download" value={formatMbps(test.download?.bitrate_mbps)} />
        <PointMetric label="Upload peak / minimum" value={formatPair(test.upload?.peak_mbps, test.upload?.minimum_mbps)} />
        <PointMetric label="Download peak / minimum" value={formatPair(test.download?.peak_mbps, test.download?.minimum_mbps)} />
        <PointMetric label="Retransmits U / D" value={`${formatCount(test.upload?.retransmits)} / ${formatCount(test.download?.retransmits)}`} />
        <PointMetric label="Highest path latency" value={formatLatency(test.highestPathLatencyMs)} />
        <PointMetric label="Highest path loss" value={formatLoss(test.highestPathLossPercent)} />
      </dl>
    </div>
  );
}

function PointMetric({ label, value }: { label: string; value: string }) { return <div><dt className="text-text-muted">{label}</dt><dd className="mt-1 font-data text-text-primary">{value}</dd></div>; }
function Legend({ label, dashed }: { label: string; dashed: boolean }) { return <span className="inline-flex items-center gap-2"><svg aria-hidden="true" height="8" viewBox="0 0 28 8" width="28"><line className="stroke-accent" strokeDasharray={dashed ? "6 4" : undefined} strokeWidth="2" x1="0" x2="28" y1="4" y2="4" /></svg>{label}</span>; }
function pathFor(points: DiagnosticTrendPoint[], x: (timestamp: string) => number, y: (value: number) => number) { return points.map(({ test, value }, index) => `${index ? "L" : "M"} ${x(test.measuredAt).toFixed(2)} ${y(value).toFixed(2)}`).join(" "); }
function axisTimes(minTime: number, maxTime: number) {
  if (minTime === maxTime) return [minTime];
  const count = 4;
  return Array.from(
    { length: count },
    (_, index) => Math.round(minTime + (index / (count - 1)) * (maxTime - minTime)),
  );
}
function formatAxisTime(timestamp: string, period: HistoryPeriod) { const date = new Date(timestamp); if (period === "today") return new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit" }).format(date); return new Intl.DateTimeFormat("id-ID", { day: "2-digit", month: "short" }).format(date); }
function formatExactTimestamp(timestamp: string) { return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(timestamp)); }
function formatConnection(value: DiagnosticTest["connectionType"]) { return value === "wifi" ? "WiFi" : "Ethernet"; }
function formatMbps(value: number | null | undefined) { return value == null ? "—" : `${value.toFixed(2)} Mbps`; }
function formatAxisMbps(value: number) { return value.toFixed(value >= 100 ? 0 : 1); }
function formatPair(peak: number | null | undefined, minimum: number | null | undefined) { return `${formatMbps(peak)} / ${formatMbps(minimum)}`; }
function formatCount(value: number | null | undefined) { return value == null ? "—" : String(value); }
function formatLatency(value: number | null) { return value === null ? "—" : `${value.toFixed(2)} ms`; }
function formatLoss(value: number | null) { return value === null ? "—" : `${value.toFixed(1)}%`; }
