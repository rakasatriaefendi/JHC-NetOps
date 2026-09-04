"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { useDeviceProfile } from "@/components/device-profile/device-profile-provider";
import { ManualPingProvider, useManualPing } from "./manual-ping-provider";
import { ReachabilityMap } from "./reachability-map";
import { NetworkHealthTrends } from "./network-health-trends";
import { NetworkDiscoveryDrawer } from "@/components/dashboard/network-discovery-drawer";
import type { DiscoverySession } from "@/lib/network-discovery";
import { createClient } from "@/lib/supabase/client";
import { healthTargetPagination, type HealthStatus, type NetworkHealthEvent, type NetworkHealthTarget, type NetworkHealthSample } from "@/lib/network-health";

type DiscoveryRunner = { id: string; display_name: string; last_seen_at: string; health_status: "online" | "degraded"; capabilities: { operations?: string[] } };

export function NetworkHealthDashboard({ targets, events, samples, loadError, isAdmin, discoveryRunners, discoverySessions, trafficIps }: { targets: NetworkHealthTarget[]; events: NetworkHealthEvent[]; samples: NetworkHealthSample[]; loadError: boolean; isAdmin: boolean; discoveryRunners: DiscoveryRunner[]; discoverySessions: DiscoverySession[]; trafficIps: string[] }) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  const [realtime, setRealtime] = useState(false);
  const selected = targets.find((target) => target.id === selectedId) ?? null;
  const summary = useMemo(() => {
    const status = (value: HealthStatus) => targets.filter((target) => target.latest?.status === value).length;
    const latencies = targets.map((target) => target.latest?.latency_ms).filter((value): value is number => typeof value === "number");
    return { online: status("online"), degraded: status("degraded"), offline: status("offline"), average: latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : null };
  }, [targets]);

  useEffect(() => {
    const supabase = createClient();
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => router.refresh(), 250); };
    const channel = supabase.channel("dashboard-network-health")
      .on("postgres_changes", { event: "*", schema: "public", table: "network_health_latest" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "network_targets" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "events", filter: "source=eq.network_health" }, refresh)
      .subscribe((status) => setRealtime(status === "SUBSCRIBED"));
    return () => { clearTimeout(refreshTimer); void supabase.removeChannel(channel); };
  }, [router]);

  if (loadError) return <section className="mt-6 rounded-panel border border-severity-critical bg-bg-surface p-6"><p className="font-medium text-severity-critical">Network Health gagal dimuat</p><p className="mt-2 text-text-secondary">Periksa migration, RLS, dan koneksi Supabase.</p></section>;

  return (
    <ManualPingProvider targets={targets} isAdmin={isAdmin}>
      <section className="mt-6 rounded-panel border border-border bg-bg-surface p-4 md:p-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div><p className="text-meta font-medium uppercase tracking-wide text-accent">Network Health Watch</p><h2 className="mt-2 text-section font-semibold">Known-target reachability</h2><p className="mt-2 max-w-3xl text-text-secondary">Status ringan berbasis ICMP untuk inventory yang disetujui. Offline berarti target tidak merespons setelah threshold; perangkat belum tentu mati karena ICMP dapat diblokir.</p></div>
          <div className="flex flex-col items-start gap-3 md:items-end">
            <p className={realtime ? "text-meta text-severity-low" : "text-meta text-severity-medium"}>● Realtime {realtime ? "tersambung" : "menghubungkan"}</p>
            {isAdmin ? <Button variant="secondary" onClick={() => setDiscoveryOpen(true)}>Discover Network</Button> : null}
          </div>
        </div>
        {targets.length === 0 ? (
          <div className="mt-6 rounded-control border border-border bg-bg-base p-4"><p className="font-medium">Belum ada target health yang aktif.</p><p className="mt-2 text-text-secondary">Monitoring tidak memindai subnet. Operator harus memilih device inventory dan runner secara eksplisit.</p>{isAdmin ? <Link className="mt-3 inline-block text-accent hover:underline" href="/devices">Atur Health Watch di Devices</Link> : null}</div>
        ) : (
          <>
            <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <Summary label="Known targets" value={targets.length} />
              <Summary label="Online" value={summary.online} tone="online" />
              <Summary label="Degraded" value={summary.degraded} tone="degraded" />
              <Summary label="Offline" value={summary.offline} tone="offline" />
              <Summary label="Average latency" value={summary.average === null ? "—" : `${summary.average.toFixed(1)} ms`} />
            </div>
            <TargetGroup title="Critical targets" targets={targets.filter((target) => target.critical)} onSelect={setSelectedId} />
            <TargetGroup title="Other known targets" targets={targets.filter((target) => !target.critical)} onSelect={setSelectedId} paginate showManualPing={isAdmin} />
          </>
        )}
      </section>

      {selected ? <Detail target={selected} onClose={() => setSelectedId(null)} /> : null}

      <NetworkHealthTrends targets={targets} samples={samples} />

      <ReachabilityMap key={targets.map((target) => target.id).sort().join(":")} targets={targets} samples={samples} events={events} runnerId="raka-local-wsl" />

      <section className="mt-6 rounded-panel border border-border bg-bg-surface p-4 md:p-6">
        <h2 className="text-section font-semibold">Recent health changes</h2>
        <p className="mt-2 text-text-secondary">Hanya perubahan status bermakna; bukan satu event untuk setiap ping.</p>
        {events.length ? <div className="mt-4 divide-y divide-border">{events.map((event) => <article className="py-3" key={event.id}><div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between"><div><p className="font-medium"><span className={severityColor(event.severity)}>●</span> {event.title}</p><p className="mt-1 text-meta text-text-secondary">{event.description}</p></div><time className="shrink-0 font-data text-meta text-text-muted">{formatTime(event.created_at)}</time></div></article>)}</div> : <p className="mt-4 text-text-muted">Belum ada perubahan status.</p>}
      </section>

      {isAdmin ? <NetworkDiscoveryDrawer open={discoveryOpen} onClose={() => setDiscoveryOpen(false)} runners={discoveryRunners} initialSessions={discoverySessions} targets={targets} trafficIps={trafficIps} /> : null}
    </ManualPingProvider>
  );
}

function Summary({ label, value, tone }: { label: string; value: number | string; tone?: HealthStatus }) {
  return <div className="rounded-control border border-border bg-bg-base p-3"><p className="text-meta text-text-secondary">{label}</p><p className={`mt-2 font-data text-section ${tone ? statusColor(tone) : "text-text-primary"}`}>{value}</p></div>;
}

function TargetGroup({ title, targets, onSelect, paginate = false, showManualPing = false }: {
  title: string;
  targets: NetworkHealthTarget[];
  onSelect: (id: string) => void;
  paginate?: boolean;
  showManualPing?: boolean;
}) {
  const [requestedPage, setRequestedPage] = useState(0);
  if (!targets.length) return null;
  const pagination = healthTargetPagination(targets.length, paginate ? requestedPage : 0);
  const visibleTargets = paginate ? targets.slice(pagination.start, pagination.end) : targets;

  return (
    <div className="mt-6 min-w-0">
      <h3 className="font-medium">{title}</h3>
      <div className="mt-3 hidden overflow-x-auto rounded-control border border-border md:block">
        <table className="w-full text-left">
          <thead className="bg-bg-base text-meta text-text-secondary">
            <tr>
              <th className="p-3">Status</th><th className="p-3">Target</th><th className="p-3">IP</th><th className="p-3">Location</th><th className="p-3">Latency</th><th className="p-3">Loss</th><th className="p-3">Checked</th>
              {showManualPing ? <th className="p-3">Action</th> : null}
            </tr>
          </thead>
          <tbody>{visibleTargets.map((target) => (
            <tr className="cursor-pointer border-t border-border hover:bg-bg-base/50" key={target.id} onClick={() => onSelect(target.id)}>
              <td className="p-3"><HealthBadge status={target.latest?.status ?? null} /></td>
              <td className="p-3 font-medium">{target.node.name}</td>
              <td className="p-3 font-data">{target.node.ip_address}</td>
              <td className="p-3 text-text-secondary">{target.node.location ?? "—"}</td>
              <td className="p-3 font-data">{formatLatency(target.latest?.latency_ms)}</td>
              <td className="p-3 font-data">{target.latest ? `${Number(target.latest.packet_loss_percent).toFixed(0)}%` : "—"}</td>
              <td className="p-3 font-data text-meta text-text-muted">{target.latest ? formatTime(target.latest.last_checked_at) : "Belum diperiksa"}</td>
              {showManualPing ? <td className="p-3"><ManualPingAction target={target} /></td> : null}
            </tr>
          ))}</tbody>
        </table>
      </div>
      <div className="mt-3 grid gap-3 md:hidden">{visibleTargets.map((target) => (
        <article className="min-w-0 rounded-control border border-border bg-bg-base p-4" key={target.id}>
          <button className="block w-full min-w-0 text-left" type="button" onClick={() => onSelect(target.id)}>
            <span className="flex items-center justify-between gap-3"><span className="truncate font-medium">{target.node.name}</span><HealthBadge status={target.latest?.status ?? null} /></span>
            <span className="mt-2 block truncate font-data text-meta text-text-secondary">{target.node.ip_address}</span>
            <span className="mt-2 block font-data text-meta">{formatLatency(target.latest?.latency_ms)} · {target.latest ? `${Number(target.latest.packet_loss_percent).toFixed(0)}% loss` : "belum ada sampel"}</span>
          </button>
          {showManualPing ? <div className="mt-3 border-t border-border pt-3"><ManualPingAction target={target} /></div> : null}
        </article>
      ))}</div>
      {paginate && pagination.pageCount > 1 ? (
        <nav className="mt-3 flex min-w-0 flex-wrap items-center justify-between gap-3" aria-label={`${title} pagination`}>
          <p className="text-meta text-text-muted">{pagination.start + 1}–{pagination.end} of {targets.length}</p>
          <div className="flex items-center gap-2">
            <Button variant="secondary" className="px-3 py-1.5 text-meta" disabled={pagination.page === 0} onClick={() => setRequestedPage(pagination.page - 1)}>Previous</Button>
            <span className="whitespace-nowrap font-data text-meta text-text-secondary">{pagination.page + 1} / {pagination.pageCount}</span>
            <Button variant="secondary" className="px-3 py-1.5 text-meta" disabled={pagination.page === pagination.pageCount - 1} onClick={() => setRequestedPage(pagination.page + 1)}>Next</Button>
          </div>
        </nav>
      ) : null}
    </div>
  );
}

function ManualPingAction({ target }: { target: NetworkHealthTarget }) {
  const manualPing = useManualPing();
  const state = manualPing.states[target.id];
  return (
    <div className="flex min-w-[8rem] flex-col items-start gap-1">
      <Button
        type="button"
        variant="secondary"
        className="px-3 py-1.5 text-meta"
        disabled={!target.manual_ping_available || state?.phase === "loading"}
        onClick={(event) => {
          event.stopPropagation();
          manualPing.run(target.id);
        }}
      >
        {state?.phase === "loading" ? "Pinging…" : "Ping"}
      </Button>
      {!target.manual_ping_available ? <span className="text-meta text-text-muted">Manual ping unavailable</span> : state ? (
        <span className={`font-data text-meta ${state.phase === "error" ? "text-severity-critical" : state.phase === "success" ? "text-severity-low" : "text-accent"}`}>{state.message}</span>
      ) : null}
    </div>
  );
}

function HealthBadge({ status }: { status: HealthStatus | null }) {
  const label = status ? status[0].toUpperCase() + status.slice(1) : "Pending";
  return <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-meta font-medium ${status ? statusBackground(status) : "bg-text-muted/10 text-text-muted"}`}>● {label}</span>;
}

function Detail({ target, onClose }: { target: NetworkHealthTarget; onClose: () => void }) {
  const { openDeviceProfile } = useDeviceProfile();
  const latest = target.latest;
  const diagnosticHref = `/diagnostics?target=${encodeURIComponent(target.diagnostic_target_id ?? target.node.ip_address)}`;
  const viewProfile = () => {
    onClose();
    openDeviceProfile({ ipAddress: target.node.ip_address, runnerId: target.runner_id, observedStatus: latest?.status ?? "unknown" });
  };
  return <div className="fixed inset-0 z-50 flex justify-end bg-bg-base/70" role="dialog" aria-modal="true" aria-label={`Detail ${target.node.name}`} onClick={onClose}><aside className="h-full w-full max-w-lg overflow-y-auto border-l border-border bg-bg-surface p-6" onClick={(event) => event.stopPropagation()}><div className="flex items-start justify-between gap-4"><div><p className="text-meta uppercase tracking-wide text-accent">Target detail</p><h2 className="mt-2 text-heading font-semibold">{target.node.name}</h2><p className="mt-1 font-data text-text-secondary">{target.node.ip_address}</p></div><Button variant="secondary" onClick={onClose}>Tutup</Button></div><dl className="mt-6 grid gap-3 sm:grid-cols-2"><DetailItem label="Status"><HealthBadge status={latest?.status ?? null} /></DetailItem><DetailItem label="Critical">{target.critical ? "Ya" : "Tidak"}</DetailItem><DetailItem label="Location">{target.node.location ?? "—"}</DetailItem><DetailItem label="Device type">{target.node.device_type ?? "—"}</DetailItem><DetailItem label="Detected">{target.node.detected_fingerprint?.detected_identity.likely_label ?? "Belum disimpan"}</DetailItem><DetailItem label="Last inspected">{target.node.last_inspected_at ? formatTime(target.node.last_inspected_at) : "Belum diperiksa"}</DetailItem><DetailItem label="Latency">{formatLatency(latest?.latency_ms)}</DetailItem><DetailItem label="Short-window loss">{latest ? `${Number(latest.packet_loss_percent).toFixed(1)}%` : "—"}</DetailItem><DetailItem label="Last checked">{latest ? formatTime(latest.last_checked_at) : "—"}</DetailItem><DetailItem label="Last success">{latest?.last_success_at ? formatTime(latest.last_success_at) : "—"}</DetailItem><DetailItem label="Consecutive failures">{latest?.consecutive_failures ?? 0}</DetailItem><DetailItem label="Probe interval">{target.probe_interval_seconds} detik</DetailItem></dl><div className="mt-6 rounded-control border border-severity-medium bg-bg-base p-4 text-text-secondary">ICMP hanya membuktikan ada atau tidaknya respons pada saat probe. Firewall, rate-limit, atau jalur sementara dapat menghasilkan status offline tanpa membuktikan perangkat mati.</div><div className="mt-6 flex flex-wrap gap-2"><Button variant="secondary" onClick={viewProfile}>View Device Profile</Button><Link className="inline-flex rounded-control border border-accent bg-accent px-4 py-2 font-medium text-bg-base" href={diagnosticHref}>Buka LAN Diagnostics</Link></div><p className="mt-2 text-meta text-text-muted">Diagnostics dan active inspection tetap on-demand dan tidak dijalankan otomatis.</p></aside></div>;
}

function DetailItem({ label, children }: { label: string; children: React.ReactNode }) { return <div className="rounded-control border border-border bg-bg-base p-3"><dt className="text-meta text-text-secondary">{label}</dt><dd className="mt-2 font-data">{children}</dd></div>; }
function formatLatency(value: number | null | undefined) { return typeof value === "number" ? `${value.toFixed(1)} ms` : "—"; }
function formatTime(value: string) { return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value)); }
function statusColor(status: HealthStatus) { return status === "online" ? "text-severity-low" : status === "degraded" ? "text-severity-medium" : "text-severity-critical"; }
function statusBackground(status: HealthStatus) { return status === "online" ? "bg-severity-low/10 text-severity-low" : status === "degraded" ? "bg-severity-medium/10 text-severity-medium" : "bg-severity-critical/10 text-severity-critical"; }
function severityColor(severity: NetworkHealthEvent["severity"]) { return severity === "low" ? "text-severity-low" : severity === "medium" ? "text-severity-medium" : severity === "high" ? "text-severity-high" : "text-severity-critical"; }
