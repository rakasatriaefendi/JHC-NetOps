"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import type { TrafficSnapshot, TrafficState } from "@/lib/traffic";

export function LocalTrafficSummary({ initialState, loadError }: { initialState: TrafficState; loadError: boolean }) {
  const [state, setState] = useState(initialState);
  const active = state.sessions.some((session) => ["queued", "running", "stopping"].includes(session.status));
  const snapshot = useMemo(() => [...state.snapshots].sort((left, right) => Date.parse(right.captured_at) - Date.parse(left.captured_at))[0], [state.snapshots]);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase.channel("dashboard-local-traffic")
      .on("postgres_changes", { event: "*", schema: "public", table: "traffic_live_snapshots" }, (payload) => {
        const next = payload.new as TrafficSnapshot;
        if (!next.runner_id) return;
        setState((current) => ({ ...current, snapshots: [next, ...current.snapshots.filter((item) => item.runner_id !== next.runner_id)] }));
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "traffic_live_sessions" }, () => {
        void supabase.functions.invoke<{ data: TrafficState }>("traffic-live", { method: "GET" }).then(({ data }) => {
          if (data?.data) setState(data.data);
        });
      }).subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, []);

  return (
    <section className="mt-6 rounded-panel border border-border bg-bg-surface p-4 md:p-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-meta font-medium uppercase tracking-wide text-accent">Local Traffic — This Device</p>
          <h2 className="mt-2 text-section font-semibold">Current observed traffic</h2>
          {loadError ? <p className="mt-2 text-severity-critical">Traffic state tidak dapat dimuat.</p>
            : !active ? <p className="mt-2 text-text-secondary">Traffic capture is currently stopped.</p>
              : <p className="mt-2 text-text-secondary">Snapshot traffic pasif terbaru dari interface runner.</p>}
        </div>
        <Link className="rounded-control border border-accent px-4 py-2 text-center font-medium text-accent hover:bg-accent/10" href="/traffic">Open Traffic</Link>
      </div>
      {active && snapshot ? (
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Observed RX" value={`${snapshot.summary.observed_rx_mbps.toFixed(2)} Mbps`} detail="Receive — traffic yang diterima interface." />
          <Metric label="Observed TX" value={`${snapshot.summary.observed_tx_mbps.toFixed(2)} Mbps`} detail="Transmit — traffic yang dikirim interface." />
          <Metric label="Active flows" value={new Intl.NumberFormat("id-ID").format(snapshot.summary.active_flows)} />
          <Metric label="Top talker" value={snapshot.top_talkers[0]?.ip ?? "—"} />
        </div>
      ) : null}
      <p className="mt-4 text-meta text-text-muted">RX/TX menunjukkan traffic yang sedang teramati pada perangkat ini, bukan kapasitas maksimum link.</p>
    </section>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <div className="rounded-control border border-border bg-bg-base p-3"><p className="text-meta text-text-secondary">{label}</p><p className="mt-2 break-words font-data text-section text-accent">{value}</p>{detail ? <p className="mt-2 text-meta text-text-muted">{detail}</p> : null}</div>;
}
