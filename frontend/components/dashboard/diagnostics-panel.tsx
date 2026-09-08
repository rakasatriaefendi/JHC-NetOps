"use client";

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

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
  const { t } = useTranslation("diagnostics");
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
          {t("panel.eyebrow")}
        </p>
        <h2 className="mt-2 text-section font-semibold">{t("panel.title")}</h2>
        <p className="mt-2 text-text-secondary">{t("panel.description")}</p>
      </div>

      {loadError ? (
        <div className="mt-6 rounded-control border border-severity-critical bg-bg-base p-4">
          <p className="font-medium text-severity-critical">{t("panel.loadError")}</p>
          <p className="mt-2 text-text-secondary">{t("panel.loadErrorHelp")}</p>
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
            <h3 className="text-section font-medium">{t("panel.latestComparison")}</h3>
            <p className="mt-1 text-meta text-text-muted">{t("panel.comparisonHelp")}</p>
            <div className="mt-4">
              <BandwidthComparison
                measurements={filtered.bandwidth}
                sortOrder={sortOrder}
              />
            </div>
          </div>

          <div>
            <h3 className="text-section font-medium">{t("panel.selectedHistory")}</h3>
            <p className="mt-1 text-meta text-text-muted">{t("panel.historyHelp")}</p>
            <div className="mt-4">
              {hasExactHistorySelection ? (
                <BandwidthChart measurements={filtered.bandwidth} />
              ) : (
                <div className="rounded-control border border-border bg-bg-base p-4 text-text-secondary">
                  {t("panel.selectFilters")}
                </div>
              )}
            </div>
          </div>

          <div className="border-t border-border pt-6">
            <h3 className="text-section font-medium">{t("panel.pathHistory")}</h3>
            <p className="mt-1 text-meta text-text-muted">{t("panel.pathHelp")}</p>
            <div className="mt-4">
              <HopLatencyTable measurements={filtered.hops} sortOrder={sortOrder} collapsible />
            </div>
          </div>

          <aside className="rounded-control border border-border bg-bg-base p-4">
            <h3 className="text-body font-medium">{t("panel.readingTitle")}</h3>
            <ul className="mt-3 grid gap-2 text-body text-text-secondary">
              <li>{t("panel.wifi")}</li>
              <li>{t("panel.mtr")}</li>
              <li>{t("panel.suspected")}</li>
            </ul>
          </aside>
        </div>
      )}
    </section>
  );
}
