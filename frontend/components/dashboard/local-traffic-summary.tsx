"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { startLocalRealtimeInvalidation } from "@/lib/network-health-realtime";
import type { TrafficState } from "@/lib/traffic";
import { getTrafficStateAction } from "@/app/actions/traffic";

export function LocalTrafficSummary({ initialState, loadError }: {
  initialState: TrafficState;
  loadError: boolean;
  initialAuthority: "local_postgres";
}) {
  const { t, i18n } = useTranslation("dashboard");
  const [state, setState] = useState(initialState);
  const active = state.sessions.some((session) => ["queued", "running", "stopping"].includes(session.status));
  const snapshot = useMemo(() => [...state.snapshots].sort((left, right) => Date.parse(right.captured_at) - Date.parse(left.captured_at))[0], [state.snapshots]);

  useEffect(() => {
    let disposed = false;
    const refresh = () => getTrafficStateAction().then((result) => {
      if (disposed) return;
      if (result.ok && result.data) setState(result.data);
    }).catch(() => {
      // Retain the last authoritative snapshot on a transient refresh failure.
    });
    // The initial snapshot is already loaded; SSE sync (or fallback) refreshes it.

    const stopRealtime = startLocalRealtimeInvalidation({
      topics: ["traffic"],
      refresh,
      onStatus: () => {},
      debounceMs: 250,
      fallbackIntervalMs: 60_000,
    });
    return () => { disposed = true; stopRealtime(); };
  }, []);

  return (
    <section className="mt-6 rounded-panel border border-border bg-bg-surface p-4 md:p-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-meta font-medium uppercase tracking-wide text-accent">{t("trafficSummary.eyebrow")}</p>
          <h2 className="mt-2 text-section font-semibold">{t("trafficSummary.title")}</h2>
          {loadError ? <p className="mt-2 text-severity-critical">{t("trafficSummary.unavailable")}</p>
            : !active ? <p className="mt-2 text-text-secondary">{t("trafficSummary.stopped")}</p>
              : <p className="mt-2 text-text-secondary">{t("trafficSummary.active")}</p>}
        </div>
        <Link className="rounded-control border border-accent px-4 py-2 text-center font-medium text-accent hover:bg-accent/10" href="/traffic">{t("trafficSummary.open")}</Link>
      </div>
      {active && snapshot ? (
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label={t("trafficSummary.observedRx")} value={`${snapshot.summary.observed_rx_mbps.toFixed(2)} Mbps`} detail={t("trafficSummary.receiveHelp")} />
          <Metric label={t("trafficSummary.observedTx")} value={`${snapshot.summary.observed_tx_mbps.toFixed(2)} Mbps`} detail={t("trafficSummary.transmitHelp")} />
          <Metric label={t("trafficSummary.activeFlows")} value={new Intl.NumberFormat(i18n.language === "en" ? "en-US" : "id-ID").format(snapshot.summary.active_flows)} />
          <Metric label={t("trafficSummary.topTalker")} value={snapshot.top_talkers[0]?.ip ?? "-"} />
        </div>
      ) : null}
      <p className="mt-4 text-meta text-text-muted">{t("trafficSummary.footnote")}</p>
    </section>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <div className="rounded-control border border-border bg-bg-base p-3"><p className="text-meta text-text-secondary">{label}</p><p className="mt-2 break-words font-data text-section text-accent">{value}</p>{detail ? <p className="mt-2 text-meta text-text-muted">{detail}</p> : null}</div>;
}
