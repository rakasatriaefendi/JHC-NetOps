"use client";

import { useMemo, useState } from "react";

import { BandwidthComparison } from "@/components/dashboard/bandwidth-comparison";
import { BandwidthChart } from "@/components/dashboard/bandwidth-chart";
import { DiagnosticsFilterControls } from "@/components/dashboard/diagnostics-filters";
import { HopLatencyTable } from "@/components/dashboard/hop-latency-table";
import {
  filterDiagnostics,
  type DiagnosticsData,
  type DiagnosticsFilters,
  type DiagnosticSortOrder,
} from "@/lib/diagnostics";

type DiagnosticsPanelProps = {
  data: DiagnosticsData;
  loadError: boolean;
};

export function DiagnosticsPanel({ data, loadError }: DiagnosticsPanelProps) {
  const [filters, setFilters] = useState<DiagnosticsFilters>({
    source: "all",
    target: "all",
    connectionType: "all",
  });
  const [sortOrder, setSortOrder] = useState<DiagnosticSortOrder>("newest");
  const sources = useMemo(
    () =>
      Array.from(
        new Set([
          ...data.bandwidth.map((measurement) => measurement.source_label),
          ...data.hops.flatMap((measurement) =>
            measurement.source_label ? [measurement.source_label] : [],
          ),
        ]),
      ).sort(),
    [data],
  );
  const targets = useMemo(
    () =>
      Array.from(
        new Set([
          ...data.bandwidth.map((measurement) => measurement.target_label),
          ...data.hops.flatMap((measurement) =>
            measurement.target_label ? [measurement.target_label] : [],
          ),
        ]),
      ).sort(),
    [data],
  );
  const filtered = useMemo(() => filterDiagnostics(data, filters), [data, filters]);
  const hasExactHistorySelection =
    filters.source !== "all" &&
    filters.target !== "all" &&
    filters.connectionType !== "all";

  return (
    <section className="mt-8 scroll-mt-6 rounded-panel border border-border bg-bg-surface p-4 md:p-6" id="diagnostic-results">
      <div>
        <p className="text-meta font-medium uppercase tracking-wide text-accent">
          Diagnostic results
        </p>
        <h2 className="mt-2 text-section font-semibold">Riwayat hasil per sesi</h2>
        <p className="mt-2 text-text-secondary">
          Gunakan filter untuk membandingkan hasil. Detail path dibuka per sesi agar tidak tercampur dengan panel job aktif/latest di atas.
        </p>
      </div>

      {loadError ? (
        <div className="mt-6 rounded-control border border-severity-critical bg-bg-base p-4">
          <p className="font-medium text-severity-critical">Data diagnostik gagal dimuat</p>
          <p className="mt-2 text-text-secondary">
            Periksa deployment Edge Function diagnostics, sesi login, dan RLS.
          </p>
        </div>
      ) : (
        <div className="mt-6 grid gap-6">
          <DiagnosticsFilterControls
            filters={filters}
            sources={sources}
            targets={targets}
            sortOrder={sortOrder}
            onChange={setFilters}
            onSortOrderChange={setSortOrder}
          />

          <div>
            <h3 className="text-section font-medium">Latest bandwidth comparison</h3>
            <p className="mt-1 text-meta text-text-muted">
              Perbandingan numerik lintas lokasi dan tipe koneksi untuk target yang dipilih.
            </p>
            <div className="mt-4">
              <BandwidthComparison
                measurements={filtered.bandwidth}
                sortOrder={sortOrder}
              />
            </div>
          </div>

          <div>
            <h3 className="text-section font-medium">Selected bandwidth history</h3>
            <p className="mt-1 text-meta text-text-muted">
              Pilih satu source, target, dan connection type agar satu riwayat memakai satu skala.
            </p>
            <div className="mt-4">
              {hasExactHistorySelection ? (
                <BandwidthChart measurements={filtered.bandwidth} />
              ) : (
                <div className="rounded-control border border-border bg-bg-base p-4 text-text-secondary">
                  Lengkapi ketiga filter untuk menampilkan chart historis.
                </div>
              )}
            </div>
          </div>

          <div className="border-t border-border pt-6">
            <h3 className="text-section font-medium">Riwayat path per sesi</h3>
            <p className="mt-1 text-meta text-text-muted">
              Pilih satu sesi untuk melihat urutan responding Layer-3 hop, latency, dan loss.
            </p>
            <div className="mt-4">
              <HopLatencyTable measurements={filtered.hops} sortOrder={sortOrder} collapsible />
            </div>
          </div>

          <aside className="rounded-control border border-border bg-bg-base p-4">
            <h3 className="text-body font-medium">Cara membaca hasil</h3>
            <ul className="mt-3 grid gap-2 text-body text-text-secondary">
              <li>
                WiFi mengukur end-to-end client-ke-server dan bukan bukti bottleneck LAN kabel.
              </li>
              <li>
                MTR menampilkan hop Layer 3 yang merespons dan tidak memperlihatkan setiap switch Layer 2.
              </li>
              <li>
                Perbedaan hasil menunjukkan suspected bottleneck; hasil ini tidak membuktikan perangkat tertentu gagal.
              </li>
            </ul>
          </aside>
        </div>
      )}
    </section>
  );
}
