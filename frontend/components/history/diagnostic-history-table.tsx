"use client";

import { useTranslation } from "react-i18next";

import { HopLatencyTable } from "@/components/dashboard/hop-latency-table";
import type { DiagnosticTest } from "@/lib/diagnostic-history";

export function DiagnosticHistoryTable({
  tests,
  selectedTest,
  onSelect,
}: {
  tests: DiagnosticTest[];
  selectedTest: DiagnosticTest | null;
  onSelect: (test: DiagnosticTest | null) => void;
}) {
  const { t, i18n } = useTranslation("diagnostics");
  if (!tests.length) {
    return <div className="rounded-control border border-border bg-bg-base p-4 text-text-secondary">{t("historyTable.empty")}</div>;
  }

  return (
    <div className="grid gap-4">
      <div className="overflow-hidden rounded-control border border-border bg-bg-base">
        <div className="hidden md:block">
          <table className="w-full border-collapse text-left text-body">
            <thead className="text-meta font-medium text-text-secondary">
              <tr><th className="px-4 py-3">{t("historyTable.date")}</th><th className="px-4 py-3">{t("historyTable.route")}</th><th className="px-4 py-3">{t("historyTable.connection")}</th><th className="px-4 py-3">{t("historyTable.upload")}</th><th className="px-4 py-3">{t("historyTable.download")}</th><th className="px-4 py-3">{t("historyTable.path")}</th><th className="px-4 py-3">{t("historyTable.status")}</th></tr>
            </thead>
            <tbody>
              {tests.map((test) => (
                <tr className="border-t border-border" key={test.jobId}>
                  <td className="px-4 py-3 font-data text-meta">{formatTimestamp(test.measuredAt, i18n.language)}</td>
                  <td className="px-4 py-3"><p>{test.sourceLabel} → {test.targetLabel}</p><p className="mt-1 font-data text-meta text-text-muted">{test.targetHost}</p>{test.environment === "localhost_demo" ? <p className="mt-1 text-meta font-medium text-severity-medium">{t("historyTable.test")}</p> : null}</td>
                  <td className="px-4 py-3">{formatConnection(test.connectionType)}</td>
                  <td className="px-4 py-3 font-data text-accent">{formatMbps(test.upload?.bitrate_mbps)}</td>
                  <td className="px-4 py-3 font-data text-accent">{formatMbps(test.download?.bitrate_mbps)}</td>
                  <td className="px-4 py-3 font-data text-meta">{formatLatency(test.highestPathLatencyMs)} / {formatLoss(test.highestPathLossPercent)}</td>
                  <td className="px-4 py-3"><p className="text-meta">{t("historyTable.completed")}</p><button className="mt-2 text-meta font-medium text-accent hover:underline" onClick={() => onSelect(test)} type="button">{t("historyTable.view")}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="grid gap-3 p-4 md:hidden">
          {tests.map((test) => (
            <article className="rounded-control border border-border p-3" key={test.jobId}>
              <div className="flex items-start justify-between gap-3"><div><p className="font-medium">{test.sourceLabel} → {test.targetLabel}</p><p className="mt-1 text-meta text-text-secondary">{formatConnection(test.connectionType)} · {test.environment === "localhost_demo" ? t("historyTable.test") : "LAN"}</p></div><span className="text-meta">{t("historyTable.completed")}</span></div>
              <time className="mt-3 block font-data text-meta text-text-muted">{formatTimestamp(test.measuredAt, i18n.language)}</time>
              <dl className="mt-3 grid grid-cols-2 gap-3 text-meta"><Metric label={t("historyTable.upload")} value={formatMbps(test.upload?.bitrate_mbps)} /><Metric label={t("historyTable.download")} value={formatMbps(test.download?.bitrate_mbps)} /><Metric label={t("extra.maxLatency")} value={formatLatency(test.highestPathLatencyMs)} /><Metric label={t("extra.maxLoss")} value={formatLoss(test.highestPathLossPercent)} /></dl>
              <button className="mt-3 rounded-control border border-border px-3 py-2 text-meta font-medium text-text-primary hover:border-accent" onClick={() => onSelect(test)} type="button">{t("historyTable.view")}</button>
            </article>
          ))}
        </div>
      </div>

      {selectedTest ? <DiagnosticDetail test={selectedTest} onClose={() => onSelect(null)} /> : null}
    </div>
  );
}

function DiagnosticDetail({ test, onClose }: { test: DiagnosticTest; onClose: () => void }) {
  const { t, i18n } = useTranslation("diagnostics");
  return (
    <section className="rounded-panel border border-accent bg-bg-base p-4 md:p-6" aria-label={t("extra.detailLabel")}>
      <div className="flex items-start justify-between gap-4"><div><p className="text-meta font-medium uppercase tracking-wide text-accent">{t("historyTable.detail")}</p><h4 className="mt-2 text-section font-semibold">{test.sourceLabel} → {test.targetLabel}</h4><p className="mt-1 font-data text-meta text-text-muted">job {test.jobId}</p></div><button aria-label={t("historyTable.close")} className="rounded-control border border-border px-3 py-2 text-body text-text-secondary hover:border-accent" onClick={onClose} type="button">{t("historyTable.close")}</button></div>

      {test.environment === "localhost_demo" ? <div className="mt-4 rounded-control border border-severity-medium p-4 text-text-secondary"><p className="font-medium text-severity-medium">{t("historyTable.testTitle")}</p><p className="mt-2">{t("historyTable.testHelp")}</p></div> : null}

      <dl className="mt-4 grid gap-3 text-meta sm:grid-cols-2 lg:grid-cols-4"><Metric label={t("historyTable.measuredAt")} value={formatTimestamp(test.measuredAt, i18n.language)} /><Metric label={t("extra.startedAt")} value={formatTimestamp(test.startedAt, i18n.language)} /><Metric label={t("extra.completedAt")} value={formatTimestamp(test.completedAt, i18n.language)} /><Metric label={t("historyTable.connection")} value={formatConnection(test.connectionType)} /><Metric label={t("extra.targetHost")} value={test.targetHost} /><Metric label={t("extra.duration")} value={t("extra.seconds", { count: test.durationSeconds })} /><Metric label={t("extra.environment")} value={test.environment === "localhost_demo" ? t("historyTable.test") : "LAN"} /></dl>

      {test.networkContext || test.routeContext ? <div className="mt-6"><h5 className="text-section font-medium">{t("historyTable.networkContext")}</h5><dl className="mt-3 grid gap-3 text-meta sm:grid-cols-2 lg:grid-cols-4"><Metric label={t("historyTable.localInterface")} value={test.networkContext?.interface_alias ?? "-"} /><Metric label={t("historyTable.localIpv4")} value={test.networkContext ? `${test.networkContext.local_ipv4}/${test.networkContext.prefix_length}` : "-"} /><Metric label={t("historyTable.linkSpeed")} value={test.networkContext?.link_speed_mbps == null ? "-" : `${test.networkContext.link_speed_mbps.toFixed(2)} Mbps`} /><Metric label={t("historyTable.gateway")} value={test.networkContext?.default_gateway ?? "-"} /><Metric label={t("historyTable.routeType")} value={test.routeContext?.route_type === "on_link" ? t("historyTable.onLink") : test.routeContext ? t("historyTable.routed") : "-"} /><Metric label={t("historyTable.nextHop")} value={test.routeContext?.next_hop ?? (test.routeContext?.route_type === "on_link" ? t("historyTable.direct") : "-")} /></dl><p className="mt-3 text-meta text-text-muted">{t("historyTable.contextHelp")}</p></div> : null}

      <div className="mt-6 grid gap-4 md:grid-cols-2"><DirectionDetail label={t("historyTable.upload")} measurement={test.upload} /><DirectionDetail label={t("historyTable.download")} measurement={test.download} /></div>

      <div className="mt-6"><h5 className="text-section font-medium">{t("historyTable.pathHops")}</h5><p className="mt-1 text-meta text-text-muted">{t("historyTable.pathHelp")}</p><div className="mt-4">{test.hops.length ? <HopLatencyTable measurements={test.hops} sourceIp={test.networkContext?.local_ipv4} /> : <div className="rounded-control border border-border p-4 text-text-secondary">{t("historyTable.noPath")}</div>}</div></div>
    </section>
  );
}

function DirectionDetail({ label, measurement }: { label: string; measurement: DiagnosticTest["upload"] }) {
  const { t, i18n } = useTranslation("diagnostics");
  return <div className="rounded-control border border-border p-4"><h5 className="font-medium">{label}</h5>{measurement ? <dl className="mt-3 grid grid-cols-2 gap-3 text-meta"><Metric label={t("historyTable.average")} value={formatMbps(measurement.bitrate_mbps)} /><Metric label={t("historyTable.peak")} value={formatMbps(measurement.peak_mbps)} /><Metric label={t("historyTable.minimum")} value={formatMbps(measurement.minimum_mbps)} /><Metric label={t("historyTable.transferred")} value={measurement.transferred_mb === null ? "-" : `${measurement.transferred_mb.toFixed(2)} MB`} /><Metric label={t("historyTable.retransmits")} value={measurement.retransmits === null ? "-" : String(measurement.retransmits)} /><Metric label={t("historyTable.measuredAt")} value={formatTimestamp(measurement.measured_at, i18n.language)} /></dl> : <p className="mt-3 text-text-secondary">{t("historyTable.measurementEmpty")}</p>}</div>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div><dt className="text-text-muted">{label}</dt><dd className="mt-1 font-data text-text-primary">{value}</dd></div>; }
function formatConnection(value: DiagnosticTest["connectionType"]) { return value === "wifi" ? "WiFi" : "Ethernet"; }
function formatMbps(value: number | null | undefined) { return value == null ? "-" : `${value.toFixed(2)} Mbps`; }
function formatLatency(value: number | null) { return value === null ? "-" : `${value.toFixed(2)} ms`; }
function formatLoss(value: number | null) { return value === null ? "-" : `${value.toFixed(1)}%`; }
function formatTimestamp(value: string | null, language = "id") { return value ? new Intl.DateTimeFormat(language === "en" ? "en-US" : "id-ID", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value)) : "-"; }
