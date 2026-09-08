"use client";

import { useTranslation } from "react-i18next";

import { localeForLanguage } from "@/i18n/config";
import { latestBandwidthComparisons, type BandwidthMeasurement, type DiagnosticSortOrder } from "@/lib/diagnostics";

type Props = { measurements: BandwidthMeasurement[]; sortOrder?: DiagnosticSortOrder };

export function BandwidthComparison({ measurements, sortOrder = "newest" }: Props) {
  const { t, i18n } = useTranslation("diagnostics");
  const locale = localeForLanguage(i18n.resolvedLanguage ?? i18n.language);
  const rows = latestBandwidthComparisons(measurements, sortOrder);
  if (rows.length === 0) return <div className="rounded-control border border-border bg-bg-base p-4 text-text-secondary">{t("comparison.empty")}</div>;

  const connection = (value: BandwidthMeasurement["connection_type"]) => value === "wifi" ? "WiFi" : value === "ethernet" ? "Ethernet" : t("comparison.legacyConnection");
  return (
    <div className="overflow-hidden rounded-control border border-border bg-bg-base">
      <div className="hidden md:block">
        <table className="w-full border-collapse text-left text-body">
          <thead className="text-meta font-medium text-text-secondary"><tr>{(["target", "source", "type", "direction", "environment", "latest", "measured"] as const).map((key) => <th className="px-4 py-3" key={key}>{t(`comparison.${key}`)}</th>)}</tr></thead>
          <tbody>{rows.map((row) => (
            <tr className="border-t border-border" key={row.id}>
              <td className="px-4 py-3"><p>{row.target_label}</p><p className="mt-1 font-data text-meta text-text-muted">{row.target_host ?? t("comparison.legacyTarget")}</p></td>
              <td className="px-4 py-3">{row.source_label}</td><td className="px-4 py-3">{connection(row.connection_type)}</td>
              <td className="px-4 py-3 capitalize">{row.direction ?? t("comparison.legacy")}</td>
              <td className="px-4 py-3">{row.environment === "localhost_demo" ? t("comparison.testShort") : row.environment ?? t("comparison.legacy")}</td>
              <td className="px-4 py-3 font-data text-accent">{row.bitrate_mbps.toFixed(2)}</td>
              <td className="px-4 py-3 font-data text-meta">{formatTimestamp(row.measured_at, locale)}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <div className="grid gap-3 p-4 md:hidden">{rows.map((row) => (
        <article className="rounded-control border border-border p-3" key={row.id}>
          <div className="flex items-start justify-between gap-4"><div><p className="font-medium">{row.source_label}</p><p className="mt-1 text-meta text-text-secondary">{row.target_label} · {connection(row.connection_type)}</p><p className="mt-1 font-data text-meta text-text-muted">{row.target_host ?? t("comparison.legacyTarget")}</p></div><p className="font-data text-section font-medium text-accent">{row.bitrate_mbps.toFixed(2)} Mbps</p></div>
          <time className="mt-3 block font-data text-meta text-text-muted">{formatTimestamp(row.measured_at, locale)}</time>
          {row.environment === "localhost_demo" ? <p className="mt-2 text-meta font-medium text-severity-medium">{t("comparison.test")}</p> : null}
        </article>
      ))}</div>
    </div>
  );
}

function formatTimestamp(timestamp: string, locale: string) { return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(timestamp)); }
