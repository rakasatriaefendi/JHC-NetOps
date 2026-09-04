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
  if (!tests.length) {
    return <div className="rounded-control border border-border bg-bg-base p-4 text-text-secondary">Belum ada diagnostic test selesai untuk filter dan periode ini.</div>;
  }

  return (
    <div className="grid gap-4">
      <div className="overflow-hidden rounded-control border border-border bg-bg-base">
        <div className="hidden md:block">
          <table className="w-full border-collapse text-left text-body">
            <thead className="text-meta font-medium text-text-secondary">
              <tr><th className="px-4 py-3">Date &amp; Time</th><th className="px-4 py-3">Source → Target</th><th className="px-4 py-3">Connection</th><th className="px-4 py-3">Upload</th><th className="px-4 py-3">Download</th><th className="px-4 py-3">Path latency / loss</th><th className="px-4 py-3">Status</th></tr>
            </thead>
            <tbody>
              {tests.map((test) => (
                <tr className="border-t border-border" key={test.jobId}>
                  <td className="px-4 py-3 font-data text-meta">{formatTimestamp(test.measuredAt)}</td>
                  <td className="px-4 py-3"><p>{test.sourceLabel} → {test.targetLabel}</p><p className="mt-1 font-data text-meta text-text-muted">{test.targetHost}</p>{test.environment === "localhost_demo" ? <p className="mt-1 text-meta font-medium text-severity-medium">TEST / not LAN</p> : null}</td>
                  <td className="px-4 py-3">{formatConnection(test.connectionType)}</td>
                  <td className="px-4 py-3 font-data text-accent">{formatMbps(test.upload?.bitrate_mbps)}</td>
                  <td className="px-4 py-3 font-data text-accent">{formatMbps(test.download?.bitrate_mbps)}</td>
                  <td className="px-4 py-3 font-data text-meta">{formatLatency(test.highestPathLatencyMs)} / {formatLoss(test.highestPathLossPercent)}</td>
                  <td className="px-4 py-3"><p className="text-meta">✓ Completed</p><button className="mt-2 text-meta font-medium text-accent hover:underline" onClick={() => onSelect(test)} type="button">View detail</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="grid gap-3 p-4 md:hidden">
          {tests.map((test) => (
            <article className="rounded-control border border-border p-3" key={test.jobId}>
              <div className="flex items-start justify-between gap-3"><div><p className="font-medium">{test.sourceLabel} → {test.targetLabel}</p><p className="mt-1 text-meta text-text-secondary">{formatConnection(test.connectionType)} · {test.environment === "localhost_demo" ? "TEST / not LAN" : "LAN"}</p></div><span className="text-meta">✓ Completed</span></div>
              <time className="mt-3 block font-data text-meta text-text-muted">{formatTimestamp(test.measuredAt)}</time>
              <dl className="mt-3 grid grid-cols-2 gap-3 text-meta"><Metric label="Upload" value={formatMbps(test.upload?.bitrate_mbps)} /><Metric label="Download" value={formatMbps(test.download?.bitrate_mbps)} /><Metric label="Max path latency" value={formatLatency(test.highestPathLatencyMs)} /><Metric label="Max path loss" value={formatLoss(test.highestPathLossPercent)} /></dl>
              <button className="mt-3 rounded-control border border-border px-3 py-2 text-meta font-medium text-text-primary hover:border-accent" onClick={() => onSelect(test)} type="button">View detail</button>
            </article>
          ))}
        </div>
      </div>

      {selectedTest ? <DiagnosticDetail test={selectedTest} onClose={() => onSelect(null)} /> : null}
    </div>
  );
}

function DiagnosticDetail({ test, onClose }: { test: DiagnosticTest; onClose: () => void }) {
  return (
    <section className="rounded-panel border border-accent bg-bg-base p-4 md:p-6" aria-label="Diagnostic test detail">
      <div className="flex items-start justify-between gap-4"><div><p className="text-meta font-medium uppercase tracking-wide text-accent">Diagnostic detail</p><h4 className="mt-2 text-section font-semibold">{test.sourceLabel} → {test.targetLabel}</h4><p className="mt-1 font-data text-meta text-text-muted">job {test.jobId}</p></div><button aria-label="Tutup detail" className="rounded-control border border-border px-3 py-2 text-body text-text-secondary hover:border-accent" onClick={onClose} type="button">Tutup</button></div>

      {test.environment === "localhost_demo" ? <div className="mt-4 rounded-control border border-severity-medium p-4 text-text-secondary"><p className="font-medium text-severity-medium">TEST ENVIRONMENT · Localhost simulation</p><p className="mt-2">Hasil ini tidak valid untuk analisis bottleneck LAN.</p></div> : null}

      <dl className="mt-4 grid gap-3 text-meta sm:grid-cols-2 lg:grid-cols-4"><Metric label="Measured at" value={formatTimestamp(test.measuredAt)} /><Metric label="Started at" value={formatTimestamp(test.startedAt)} /><Metric label="Completed at" value={formatTimestamp(test.completedAt)} /><Metric label="Connection" value={formatConnection(test.connectionType)} /><Metric label="Target host" value={test.targetHost} /><Metric label="Duration / direction" value={`${test.durationSeconds} detik`} /><Metric label="Environment" value={test.environment === "localhost_demo" ? "TEST / not LAN" : "LAN"} /></dl>

      {test.networkContext || test.routeContext ? <div className="mt-6"><h5 className="text-section font-medium">Network context at test time</h5><dl className="mt-3 grid gap-3 text-meta sm:grid-cols-2 lg:grid-cols-4"><Metric label="Local interface" value={test.networkContext?.interface_alias ?? "—"} /><Metric label="Local IPv4" value={test.networkContext ? `${test.networkContext.local_ipv4}/${test.networkContext.prefix_length}` : "—"} /><Metric label="Local link speed" value={test.networkContext?.link_speed_mbps == null ? "—" : `${test.networkContext.link_speed_mbps.toFixed(2)} Mbps`} /><Metric label="Default gateway" value={test.networkContext?.default_gateway ?? "—"} /><Metric label="Route type" value={test.routeContext?.route_type === "on_link" ? "On-link" : test.routeContext ? "Routed" : "—"} /><Metric label="Route next hop" value={test.routeContext?.next_hop ?? (test.routeContext?.route_type === "on_link" ? "Direct / on-link" : "—")} /></dl><p className="mt-3 text-meta text-text-muted">Local link speed bukan available bandwidth. Route lokal menunjukkan interface/next hop; MTR menunjukkan hop Layer-3 yang merespons.</p></div> : null}

      <div className="mt-6 grid gap-4 md:grid-cols-2"><DirectionDetail label="Upload" measurement={test.upload} /><DirectionDetail label="Download" measurement={test.download} /></div>

      <div className="mt-6"><h5 className="text-section font-medium">Path hops</h5><p className="mt-1 text-meta text-text-muted">MTR hanya menampilkan hop Layer-3 yang merespons, bukan setiap switch, kabel, access point bridge, atau patch panel fisik. Label berarti IP tersebut dikenal dalam inventory manual, bukan bukti seluruh perangkat Layer-2 yang dilalui.</p><div className="mt-4">{test.hops.length ? <HopLatencyTable measurements={test.hops} sourceIp={test.networkContext?.local_ipv4} /> : <div className="rounded-control border border-border p-4 text-text-secondary">Tidak ada path measurement yang terkait dengan job ini.</div>}</div></div>
    </section>
  );
}

function DirectionDetail({ label, measurement }: { label: string; measurement: DiagnosticTest["upload"] }) {
  return <div className="rounded-control border border-border p-4"><h5 className="font-medium">{label}</h5>{measurement ? <dl className="mt-3 grid grid-cols-2 gap-3 text-meta"><Metric label="Average" value={formatMbps(measurement.bitrate_mbps)} /><Metric label="Peak" value={formatMbps(measurement.peak_mbps)} /><Metric label="Minimum" value={formatMbps(measurement.minimum_mbps)} /><Metric label="Transferred" value={measurement.transferred_mb === null ? "—" : `${measurement.transferred_mb.toFixed(2)} MB`} /><Metric label="Retransmits" value={measurement.retransmits === null ? "—" : String(measurement.retransmits)} /><Metric label="Measured at" value={formatTimestamp(measurement.measured_at)} /></dl> : <p className="mt-3 text-text-secondary">Measurement tidak tersedia.</p>}</div>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div><dt className="text-text-muted">{label}</dt><dd className="mt-1 font-data text-text-primary">{value}</dd></div>; }
function formatConnection(value: DiagnosticTest["connectionType"]) { return value === "wifi" ? "WiFi" : "Ethernet"; }
function formatMbps(value: number | null | undefined) { return value == null ? "—" : `${value.toFixed(2)} Mbps`; }
function formatLatency(value: number | null) { return value === null ? "—" : `${value.toFixed(2)} ms`; }
function formatLoss(value: number | null) { return value === null ? "—" : `${value.toFixed(1)}%`; }
function formatTimestamp(value: string | null) { return value ? new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value)) : "—"; }
