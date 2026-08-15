import Link from "next/link";

import type { DiagnosticsData } from "@/lib/diagnostics";

export function DiagnosticsSummary({ data, loadError }: { data: DiagnosticsData; loadError: boolean }) {
  const latest = [...data.bandwidth].sort((left, right) => Date.parse(right.measured_at) - Date.parse(left.measured_at))[0];
  return (
    <section className="mt-6 rounded-panel border border-border bg-bg-surface p-4 md:p-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-meta font-medium uppercase tracking-wide text-accent">LAN diagnostics</p>
          <h2 className="mt-2 text-section font-semibold">Latest on-demand measurement</h2>
          {loadError ? <p className="mt-2 text-severity-critical">Data diagnostik gagal dimuat.</p> : latest ? (
            <p className="mt-2 text-text-secondary">
              {latest.source_label} → {latest.target_label} · {latest.direction ?? "legacy"} · <span className="font-data text-accent">{latest.bitrate_mbps.toFixed(2)} Mbps</span>
              {latest.environment === "localhost_demo" ? " · TEST ENVIRONMENT" : ""}
            </p>
          ) : <p className="mt-2 text-text-secondary">Belum ada hasil diagnostik.</p>}
        </div>
        <Link className="rounded-control border border-accent px-4 py-2 text-center text-body font-medium text-accent hover:bg-accent/10" href="/diagnostics">Buka LAN Diagnostics</Link>
      </div>
    </section>
  );
}
