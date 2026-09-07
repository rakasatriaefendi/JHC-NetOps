"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { diagnosticStageLabel, diagnosticSteps, safeFailureMessage, type StepState } from "@/lib/diagnostic-ux";
import {
  isRunnerFresh,
  type DiagnosticJob,
  type DiagnosticJobState,
  type DiagnosticProgress,
  type DiagnosticRunner,
  type DirectionSummary,
  type LiveSample,
  type NetworkContext,
  type PreflightContext,
  type RouteContext,
} from "@/lib/diagnostic-jobs";
import type { BandwidthMeasurement, DiagnosticsData } from "@/lib/diagnostics";
import { createClient } from "@/lib/supabase/client";
import { canOperateNetwork, type ProfileRole } from "@/lib/authorization";

type Props = {
  initialState: DiagnosticJobState;
  diagnostics: DiagnosticsData;
  onDiagnosticsChange: (data: DiagnosticsData) => void;
  loadError: boolean;
  prefillTarget?: string;
  role: ProfileRole;
};

export function OneClickDiagnostics({ initialState, diagnostics, onDiagnosticsChange, loadError, prefillTarget, role }: Props) {
  const [runners, setRunners] = useState(initialState.runners);
  const [jobs, setJobs] = useState(initialState.jobs);
  const [now, setNow] = useState(() => Date.now());
  const [runnerId, setRunnerId] = useState(initialState.runners[0]?.id ?? "");
  const [source, setSource] = useState("");
  const [targetId, setTargetId] = useState("");
  const [duration, setDuration] = useState(5);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  const requestedPreflight = useRef("");

  const runner = runners.find((item) => item.id === runnerId) ?? runners[0];
  const capabilities = runner?.capabilities;
  const selectedTargetId = targetId || capabilities?.targets.find((item) => item.id === prefillTarget || item.host === prefillTarget)?.id || capabilities?.targets[0]?.id || "";
  const target = capabilities?.targets.find((item) => item.id === selectedTargetId);
  const selectedDuration = capabilities?.durations.includes(duration) ? duration : capabilities?.durations[0] ?? 5;
  const runnerOnline = Boolean(runner && runner.health_status === "online" && isRunnerFresh(runner, now));
  const displayedJob = useMemo(() => jobs.find((job) => job.status === "queued" || job.status === "running") ?? jobs[0] ?? null, [jobs]);
  const jobActive = Boolean(displayedJob && (displayedJob.status === "queued" || displayedJob.status === "running"));
  const preflight = runner?.preflight?.target_id === selectedTargetId ? runner.preflight : undefined;
  const network = preflight?.network_context;
  const route = preflight?.route_context;
  const checks = preflight?.checks;
  const detectedConnection = network?.connection_type;
  const preflightReady = preflight?.status === "completed" && Boolean(network && route && checks?.iperf.ready) && (detectedConnection === "wifi" || detectedConnection === "ethernet");
  const sourceSuggestions = useMemo(() => Array.from(new Set([
    ...(capabilities?.source_locations ?? []),
    ...jobs.filter((job) => job.environment === "lan").map((job) => job.source_label),
  ])).filter((label) => label !== "Local Development").slice(0, 12), [capabilities?.source_locations, jobs]);

  useEffect(() => {
    let disposed = false;
    const supabase = createClient();
    async function refetchState() {
      const { data, error } = await supabase.functions.invoke<{ data: DiagnosticJobState }>("diagnostic-jobs", { method: "GET" });
      if (!disposed && !error && data?.data) {
        setRunners(data.data.runners);
        setJobs(data.data.jobs);
        if (data.data.jobs[0]?.status === "completed") void reloadMeasurements(supabase, onDiagnosticsChange);
      }
    }
    const clock = window.setInterval(() => setNow(Date.now()), 5000);
    const fallback = window.setInterval(() => void refetchState(), 4000);
    const onlineRefetch = () => void refetchState();
    window.addEventListener("online", onlineRefetch);
    const channel = supabase.channel("lan-diagnostics-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "diagnostic_runners" }, (payload) => {
        const next = payload.new as DiagnosticRunner;
        if (next.id) setRunners((current) => [next, ...current.filter((item) => item.id !== next.id)]);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "diagnostic_jobs" }, (payload) => {
        const next = payload.new as DiagnosticJob;
        if (!next.id) return;
        setJobs((current) => [next, ...current.filter((item) => item.id !== next.id)].slice(0, 25));
        if (next.status === "completed") void reloadMeasurements(supabase, onDiagnosticsChange);
      })
      .subscribe((status) => {
        const connected = status === "SUBSCRIBED";
        setRealtimeConnected(connected);
        if (!connected) void refetchState();
      });
    return () => {
      disposed = true;
      window.clearInterval(clock);
      window.clearInterval(fallback);
      window.removeEventListener("online", onlineRefetch);
      void supabase.removeChannel(channel);
    };
  }, [onDiagnosticsChange]);

  useEffect(() => {
    if (!canOperateNetwork(role) || !runnerOnline || !runner || !target || jobActive) return;
    const key = `${runner.id}:${target.id}`;
    const freshComplete = preflight?.status === "completed" && preflight.completed_at && now - Date.parse(preflight.completed_at) < 80_000;
    if (requestedPreflight.current === key && (preflight?.status === "queued" || preflight?.status === "running" || freshComplete)) return;
    requestedPreflight.current = key;
    const supabase = createClient();
    void supabase.functions.invoke("diagnostic-jobs", {
      body: { action: "request_preflight", runner_id: runner.id, target_id: target.id },
    }).then(async ({ error }) => {
      if (error) setFormError(await diagnosticJobErrorMessage(error));
    });
  }, [jobActive, now, preflight?.completed_at, preflight?.status, role, runner, runnerOnline, target]);

  async function createJob() {
    const location = source.trim();
    if (!canOperateNetwork(role) || !runner || !target || !location || jobActive || !preflightReady) return;
    setSubmitting(true);
    setFormError(null);
    const supabase = createClient();
    try {
      const { data, error } = await supabase.functions.invoke<{ data: DiagnosticJob }>("diagnostic-jobs", {
        body: {
          action: "create_job",
          type: "bandwidth_and_path",
          runner_id: runner.id,
          source_label: location,
          target_id: target.id,
          duration_seconds: selectedDuration,
        },
      });
      if (error || !data?.data) setFormError(await diagnosticJobErrorMessage(error));
      else setJobs((current) => [data.data, ...current.filter((item) => item.id !== data.data.id)]);
    } finally { setSubmitting(false); }
  }

  const jobBandwidth = displayedJob ? diagnostics.bandwidth.filter((item) => item.job_id === displayedJob.id) : [];
  const jobHops = displayedJob ? diagnostics.hops.filter((item) => item.job_id === displayedJob.id) : [];

  return (
    <div className="grid min-w-0 gap-6">
      {loadError ? <Notice tone="critical">Status runner atau data diagnostik gagal dimuat.</Notice> : null}
      <RunnerHealth runner={runner} online={runnerOnline} />

      {network ? <CurrentNetwork network={network} runnerLabel={runner?.display_name ?? "-"} /> : (
        <section className="rounded-panel border border-border bg-bg-surface p-4 md:p-6">
          <SectionTitle eyebrow="Current network" title="Menunggu konteks jaringan lokal" />
          <p className="mt-3 text-text-secondary">Pilih target resmi agar local runner menentukan interface dan route yang benar.</p>
        </section>
      )}

      <section className="rounded-panel border border-border bg-bg-surface p-4 md:p-6">
        <SectionTitle eyebrow="Diagnostic target" title="Lokasi fisik dan server resmi" />
        <fieldset disabled={jobActive || submitting} className="mt-5 grid gap-4 disabled:opacity-60 md:grid-cols-2">
          <Select label="Runner" value={runner?.id ?? ""} onChange={(value) => { setRunnerId(value); setTargetId(""); requestedPreflight.current = ""; }} options={runners.map((item) => ({ value: item.id, label: item.display_name }))} />
          <SourceInput value={source} onChange={setSource} suggestions={sourceSuggestions} />
          <Select label="Target server" value={selectedTargetId} onChange={(value) => { setTargetId(value); requestedPreflight.current = ""; setFormError(null); }} options={(capabilities?.targets ?? []).map((item) => ({ value: item.id, label: `${item.label} — ${item.host}` }))} />
          <Select label="Duration per direction" value={String(selectedDuration)} onChange={(value) => setDuration(Number(value))} options={(capabilities?.durations ?? []).map((item) => ({ value: String(item), label: `${item} detik` }))} />
        </fieldset>
        {!target ? <NoTargetState /> : null}
        {target?.environment === "localhost_demo" ? <LocalhostWarning /> : null}
        {target && route ? <RouteToTarget targetLabel={target.label} route={route} connection={network?.connection_type} /> : null}
      </section>

      {target ? <ReadinessCard status={preflight?.status} network={network} route={route} checks={checks} errorCode={preflight?.error_code} /> : null}

      <section className="rounded-panel border border-border bg-bg-surface p-4 md:p-6">
        <SectionTitle eyebrow="Run diagnostic" title="Bandwidth upload/download + Layer-3 path" />
        <p className="mt-3 text-text-secondary">iperf3 menghasilkan traffic aktif. Test hanya berjalan setelah klik dan dibatasi {selectedDuration} detik per arah.</p>
        {!canOperateNetwork(role) ? <Notice>Viewer dapat membaca hasil, tetapi role Operator diperlukan untuk memulai bandwidth diagnostic aktif.</Notice> : null}
        {formError ? <p className="mt-4 text-severity-critical">{formError}</p> : null}
        <Button className="mt-5 w-full sm:w-auto sm:min-w-52" disabled={!canOperateNetwork(role) || !runnerOnline || !target || !source.trim() || !preflightReady || submitting || jobActive} onClick={createJob} type="button">
          {jobActive || submitting ? "Diagnostik sedang berjalan..." : displayedJob ? "Jalankan lagi" : "Jalankan diagnostik"}
        </Button>
        {target && checks && !checks.iperf.ready ? <p className="mt-3 text-severity-medium">Bandwidth test dinonaktifkan karena server iperf3 tidak tersedia pada TCP {checks.iperf.port}.</p> : null}
      </section>

      {displayedJob ? <DiagnosticProgressPanel job={displayedJob} bandwidth={jobBandwidth} hops={jobHops} realtimeConnected={realtimeConnected} /> : <Notice>Belum ada job diagnostik aktif atau tersimpan.</Notice>}
      <div className="flex flex-wrap gap-3"><Link className="text-accent hover:underline" href="/history">View History</Link><Link className="text-accent hover:underline" href="/traffic">Open related Traffic</Link></div>
    </div>
  );
}

function RunnerHealth({ runner, online }: { runner?: DiagnosticRunner; online: boolean }) {
  return <section className="rounded-panel border border-border bg-bg-surface p-4 md:p-6"><div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between"><div><SectionTitle eyebrow="Runner health" title={runner?.display_name ?? "Runner belum terdaftar"} /><p className="mt-2 text-text-secondary">{online ? "Online dan siap menerima job terstruktur." : "Offline atau heartbeat lebih lama dari 30 detik."}</p></div><StatusPill ok={online} label={online ? "ONLINE" : "OFFLINE"} /></div>{runner?.health_error_code ? <p className="mt-3 font-data text-meta text-severity-medium">{runner.health_error_code}</p> : null}</section>;
}

function CurrentNetwork({ network, runnerLabel }: { network: NetworkContext; runnerLabel: string }) {
  return <section className="rounded-panel border border-border bg-bg-surface p-4 md:p-6"><SectionTitle eyebrow="Current network" title="Konteks local runner" /><dl className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4"><Info label="Host" value={network.host_name} data /><Info label="Runner" value={runnerLabel} /><Info label="Connection" value={connectionLabel(network.connection_type)} /><Info label="Operational state" value={network.operational_status.toUpperCase()} /><Info label="Interface" value={network.interface_alias} /><Info label="Description" value={network.interface_description} /><Info label="Local IPv4" value={`${network.local_ipv4}/${network.prefix_length}`} data /><Info label="Subnet" value={network.subnet_cidr} data /><Info label="Subnet mask" value={network.subnet_mask} data /><Info label="Default gateway" value={network.default_gateway ?? "-"} data /><Info label="DNS" value={network.dns_servers.join(", ") || "-"} data /><Info label="Local link speed" value={network.link_speed_mbps == null ? "-" : `${formatNumber(network.link_speed_mbps)} Mbps`} data />{network.ssid ? <Info label="SSID" value={network.ssid} /> : null}{network.wifi_signal_percent != null ? <Info label="WiFi signal" value={`${network.wifi_signal_percent}%`} data /> : null}</dl><p className="mt-4 text-meta text-text-muted">Local link speed adalah negotiated link runner, bukan available bandwidth atau hasil iperf3.</p></section>;
}

function RouteToTarget({ targetLabel, route, connection }: { targetLabel: string; route: RouteContext; connection?: string }) {
  return <div className="mt-5 border-t border-border pt-5"><p className="text-meta font-medium uppercase tracking-wide text-accent">Route to target</p><dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4"><Info label="Target" value={targetLabel} /><Info label="Target address" value={route.resolved_target_ip} data /><Info label="Route" value={route.route_type === "on_link" ? "On-link" : "Routed"} /><Info label="Detected connection" value={connectionLabel(connection)} /><Info label="Source interface" value={route.interface_alias} /><Info label="Source IP" value={route.source_ip} data /><Info label="Next hop" value={route.next_hop ?? "Direct / on-link"} data /><Info label="Route metric" value={String(route.route_metric)} data /></dl></div>;
}

function ReadinessCard({ status, network, route, checks, errorCode }: { status?: string; network?: NetworkContext; route?: RouteContext; checks?: PreflightContext; errorCode?: string }) {
  const pending = status === "queued" || status === "running";
  return <section className="rounded-panel border border-border bg-bg-surface p-4 md:p-6"><SectionTitle eyebrow="Preflight" title={pending ? "Memeriksa route dan target..." : checks?.iperf.ready ? "Ready for diagnostic" : "Bandwidth test unavailable"} /><div className="mt-5 grid gap-3 md:grid-cols-2"><Check label="Runner network interface" ok={Boolean(network)} detail={network ? `${connectionLabel(network.connection_type)} · ${network.local_ipv4}/${network.prefix_length}` : "Menunggu runner"} /><Check label="Local runner route" ok={Boolean(route)} detail={route ? (route.route_type === "routed" ? `via ${route.next_hop}` : "Direct / on-link") : "Belum terselesaikan"} /><Check label="Gateway / next hop" ok={route?.route_type === "on_link" || checks?.gateway?.status === "responded"} neutral={checks?.gateway?.status === "no_response"} detail={route?.route_type === "on_link" ? "Tidak digunakan oleh route ini" : pingDetail(checks?.gateway)} /><Check label="Target network reachability" ok={checks?.target.status === "responded"} neutral={checks?.target.status === "no_response"} detail={pingDetail(checks?.target)} /><Check label="iperf3 server" ok={checks?.iperf.ready === true} detail={checks ? (checks.iperf.ready ? `Ready on TCP ${checks.iperf.port}` : `Unavailable on TCP ${checks.iperf.port}`) : "Belum diperiksa"} /></div>{checks?.target.status === "no_response" ? <p className="mt-4 text-meta text-text-muted">Tidak ada respons ICMP tidak otomatis berarti target offline; host atau firewall dapat memblokir ping.</p> : null}{errorCode ? <p className="mt-4 font-data text-meta text-severity-critical">{errorCode}</p> : null}</section>;
}

function DiagnosticProgressPanel({ job, bandwidth, hops, realtimeConnected }: { job: DiagnosticJob; bandwidth: DiagnosticsData["bandwidth"]; hops: DiagnosticsData["hops"]; realtimeConnected: boolean }) {
  const progress = job.progress ?? {};
  const runningDirection = job.stage === "upload" || job.stage === "download" ? job.stage : null;
  const upload = bandwidth.find((item) => item.direction === "upload");
  const download = bandwidth.find((item) => item.direction === "download");
  const uploadSummary = progress.summaries?.upload ?? measurementSummary(upload);
  const downloadSummary = progress.summaries?.download ?? measurementSummary(download);
  const active = job.status === "queued" || job.status === "running";
  const complete = job.status === "completed";
  const highestLatency = maxNullable(hops.map((hop) => hop.avg_latency_ms));
  const highestLoss = hops.length ? Math.max(...hops.map((hop) => hop.loss_percent)) : null;
  const eyebrow = active ? "Active diagnostic" : complete ? "Latest completed diagnostic" : "Latest diagnostic attempt";
  return <section className={`rounded-panel border bg-bg-surface p-4 md:p-6 ${active ? "border-accent" : "border-border"}`} aria-live="polite"><div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between"><div><SectionTitle eyebrow={eyebrow} title={`${job.source_label} → ${job.target_label}`} /><p className="mt-2 text-text-secondary">{connectionLabel(job.connection_type)} · {job.duration_seconds} detik per arah · {formatTimestamp(job.created_at)}</p></div><div className="md:text-right"><p className={job.status === "failed" ? "text-severity-critical" : complete ? "text-severity-low" : "text-accent"}>{diagnosticStageLabel(job)}</p><p className={`mt-1 text-meta ${realtimeConnected ? "text-severity-low" : "text-severity-medium"}`}>{realtimeConnected ? "● Realtime tersambung" : "○ Realtime reconnecting · fallback polling aktif"}</p></div></div>{job.environment === "localhost_demo" ? <LocalhostWarning /> : null}<ContextSteps job={job} /><ProgressStepper job={job} /><div className="mt-5 grid gap-4 md:grid-cols-2"><DirectionCard direction="upload" summary={uploadSummary} active={runningDirection === "upload"} /><DirectionCard direction="download" summary={downloadSummary} active={runningDirection === "download"} /></div>{active && runningDirection ? <LiveThroughput progress={progress} direction={runningDirection} /> : null}{job.status === "failed" ? <Notice tone="critical">{safeFailureMessage(job.error_code)}{job.error_code ? ` (${job.error_code})` : ""}</Notice> : null}{complete ? <FinalResult job={job} bandwidth={bandwidth} upload={upload} download={download} hops={hops} highestLatency={highestLatency} highestLoss={highestLoss} /> : null}{complete && hops.length > 0 ? <div className="mt-6 rounded-control border border-border bg-bg-base p-4"><p className="font-medium">Detail path tersimpan pada riwayat sesi.</p><p className="mt-1 text-meta text-text-secondary">Buka hanya sesi yang ingin diperiksa agar hasil terbaru tidak terduplikasi di halaman.</p><a className="mt-3 inline-block text-accent hover:underline" href="#diagnostic-results">Lihat riwayat hasil per sesi</a></div> : null}</section>;
}

function FinalResult({ job, bandwidth, upload, download, hops, highestLatency, highestLoss }: { job: DiagnosticJob; bandwidth: DiagnosticsData["bandwidth"]; upload?: BandwidthMeasurement; download?: BandwidthMeasurement; hops: DiagnosticsData["hops"]; highestLatency: number | null; highestLoss: number | null }) {
  const network = job.network_context;
  const route = job.route_context;
  return <div className="mt-6 border-t border-border pt-6"><p className="text-meta font-medium uppercase tracking-wide text-severity-low">Diagnostic complete</p><dl className="mt-4 grid gap-4 md:grid-cols-4"><Info label="Source" value={job.source_label} /><Info label="Connection" value={connectionLabel(job.connection_type)} /><Info label="Local IP" value={network?.local_ipv4 ?? "-"} data /><Info label="Local link speed" value={network?.link_speed_mbps == null ? "-" : `${formatNumber(network.link_speed_mbps)} Mbps`} data /><Info label="Target" value={`${job.target_label} · ${job.target_host}`} /><Info label="Route" value={route?.route_type === "routed" ? `via ${route.next_hop}` : "On-link"} data /><Info label="Measured" value={formatTimestamp(job.completed_at ?? job.updated_at)} data /></dl><p className="mt-6 text-meta font-medium uppercase tracking-wide text-accent">Bandwidth</p><dl className="mt-3 grid gap-4 md:grid-cols-4"><ResultValue label="Upload" value={upload?.bitrate_mbps} suffix="Mbps" /><ResultValue label="Download" value={download?.bitrate_mbps} suffix="Mbps" /><ResultValue label="Peak tertinggi" value={maxNullable(bandwidth.map((item) => item.peak_mbps))} suffix="Mbps" /><ResultValue label="Minimum terendah" value={minNullable(bandwidth.map((item) => item.minimum_mbps))} suffix="Mbps" /></dl><p className="mt-6 text-meta font-medium uppercase tracking-wide text-accent">Path</p><dl className="mt-3 grid gap-4 md:grid-cols-4"><ResultValue label="Responding hops" value={hops.length} suffix="" /><ResultValue label="Highest latency" value={highestLatency} suffix="ms" /><ResultValue label="Highest loss" value={highestLoss} suffix="%" /></dl><Interpretation network={network} route={route} highestLoss={highestLoss} /></div>;
}

function Interpretation({ network, route, highestLoss }: { network: NetworkContext | null; route: RouteContext | null; highestLoss: number | null }) {
  if (!network) return null;
  return <div className="mt-6 rounded-control border border-border bg-bg-base p-4"><p className="text-meta font-medium uppercase tracking-wide text-accent">Interpretation</p><div className="mt-3 grid gap-2 text-text-secondary"><p>Pengukuran menggunakan interface {connectionLabel(network.connection_type)} yang dipilih route Windows ke target.</p><p>Local link negotiated at {network.link_speed_mbps == null ? "nilai yang tidak tersedia" : `${formatNumber(network.link_speed_mbps)} Mbps`}; nilai ini bukan available bandwidth.</p>{network.connection_type === "wifi" ? <p>Test mencakup jalur wireless dan tidak dapat sendiri membuktikan bottleneck LAN kabel.</p> : <p>Pengukuran menggunakan interface Ethernet yang dipilih sistem operasi untuk target.</p>}<p>{highestLoss != null && highestLoss > 0 ? `Packet loss Layer-3 teramati sampai ${highestLoss.toFixed(1)}%.` : "Tidak ada packet loss Layer-3 signifikan pada hop yang merespons."}</p><p>{route?.route_type === "on_link" ? "Target on-link; jalur fisik Layer-2 tidak terlihat melalui MTR." : "MTR hanya menunjukkan hop Layer-3 yang merespons."}</p><p>Bandingkan lokasi lain ke server yang sama untuk mempersempit suspected bottleneck; hasil ini tidak memastikan perangkat fisik yang rusak.</p></div></div>;
}

function ContextSteps({ job }: { job: DiagnosticJob }) { const complete = Boolean(job.network_context && job.route_context && job.preflight_context); return <ol className="mt-5 grid gap-2 rounded-control border border-border bg-bg-base p-4 md:grid-cols-3"><Step ok={complete} label="Network context captured" /><Step ok={complete} label="Route resolved" /><Step ok={job.preflight_context?.iperf.ready === true} label="Target ready" /></ol>; }
function Step({ ok, label }: { ok: boolean; label: string }) { return <li className={`flex items-center gap-2 ${ok ? "text-severity-low" : "text-text-muted"}`}><span aria-hidden="true">{ok ? "✓" : "○"}</span>{label}</li>; }
function ProgressStepper({ job }: { job: DiagnosticJob }) { return <ol className="mt-3 grid gap-2 rounded-control border border-border bg-bg-base p-4 md:grid-cols-3">{diagnosticSteps(job).map((step) => <li className={`flex items-center gap-2 text-body ${stepColor(step.state)}`} key={step.id}><span className="font-data" aria-hidden="true">{stepIcon(step.state)}</span><span>{step.label}</span></li>)}</ol>; }
function LiveThroughput({ progress, direction }: { progress: DiagnosticProgress; direction: "upload" | "download" }) { const percent = Math.min(100, Math.max(0, progress.progress_percent ?? 0)); return <div className="mt-5 rounded-control border border-accent bg-bg-base p-4"><div className="flex items-center justify-between gap-4"><p className="font-medium text-accent">● Mengukur {direction}...</p><p className="font-data text-meta text-text-secondary">{(progress.elapsed_seconds ?? 0).toFixed(1)} / {progress.duration_seconds ?? 0} detik</p></div><div className="mt-3 h-2 overflow-hidden rounded-full bg-border" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><div className="h-full bg-accent" style={{ width: `${percent}%` }} /></div><dl className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4"><LiveValue label="Current" value={progress.current_mbps} suffix="Mbps" /><LiveValue label="Average" value={progress.average_mbps} suffix="Mbps" /><LiveValue label="Peak" value={progress.peak_mbps} suffix="Mbps" /><LiveValue label="Minimum" value={progress.minimum_mbps} suffix="Mbps" /></dl><div className="mt-4"><LiveChart samples={progress.live_samples ?? []} direction={direction} /></div></div>; }
function DirectionCard({ direction, summary, active }: { direction: "upload" | "download"; summary: DirectionSummary | null; active: boolean }) { return <article className={`rounded-control border bg-bg-base p-4 ${active ? "border-accent" : "border-border"}`}><div className="flex items-center justify-between"><p className="text-meta font-medium uppercase text-text-secondary">{direction}</p><span className={summary ? "text-severity-low" : active ? "text-accent" : "text-text-muted"}>{summary ? "✓ Selesai" : active ? "● Aktif" : "○ Menunggu"}</span></div><p className="mt-3 font-data text-heading text-accent">{summary ? `${summary.average_mbps.toFixed(2)} Mbps` : "-"}</p>{summary ? <p className="mt-2 font-data text-meta text-text-muted">peak {formatMaybe(summary.peak_mbps)} · min {formatMaybe(summary.minimum_mbps)} · retransmits {summary.retransmits ?? "-"}</p> : null}</article>; }
function LiveChart({ samples, direction }: { samples: LiveSample[]; direction: "upload" | "download" }) { if (!samples.length) return <div className="h-36 rounded-control border border-border bg-bg-surface" />; const width=640,height=150,pad=16,max=Math.max(1,...samples.map((item)=>item.mbps)); const path=samples.map((sample,index)=>{const x=pad+(samples.length===1?0:index/(samples.length-1)*(width-pad*2)); const y=height-pad-sample.mbps/max*(height-pad*2); return `${index?"L":"M"} ${x.toFixed(1)} ${y.toFixed(1)}`;}).join(" "); return <svg className="w-full rounded-control border border-border bg-bg-surface" role="img" aria-label={`Live ${direction} throughput Mbps`} viewBox={`0 0 ${width} ${height}`}><path d={path} className="fill-none stroke-accent" strokeWidth="3" /></svg>; }

function SourceInput({ value, onChange, suggestions }: { value: string; onChange: (value: string) => void; suggestions: string[] }) { return <label className="grid min-w-0 gap-2 text-meta font-medium text-text-secondary">Source location<input className="w-full min-w-0 rounded-control border border-border bg-bg-base px-3 py-2 text-body text-text-primary outline-none focus:border-accent" list="source-location-suggestions" maxLength={200} placeholder="Contoh: Lantai 3 - Ruang IT" value={value} onChange={(event) => onChange(event.target.value)} /><span className="font-normal text-text-muted">Isi nama lokasi fisik, bukan IP. IPv4 sumber dideteksi otomatis oleh runner.</span><datalist id="source-location-suggestions">{suggestions.map((item) => <option key={item} value={item} />)}</datalist></label>; }
function Select({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void }) { const unique=Array.from(new Map(options.map((option)=>[option.value,option])).values()); return <label className="grid min-w-0 gap-2 text-meta font-medium text-text-secondary">{label}<select className="w-full min-w-0 rounded-control border border-border bg-bg-base px-3 py-2 text-body text-text-primary outline-none focus:border-accent" value={value} onChange={(event)=>onChange(event.target.value)}>{unique.length ? unique.map((option)=><option key={`${label}:${option.value}`} value={option.value}>{option.label}</option>) : <option value="">Tidak tersedia</option>}</select></label>; }
function NoTargetState() { return <div className="mt-5 rounded-control border border-severity-medium bg-bg-base p-4"><p className="font-medium text-severity-medium">No authorized LAN diagnostic target configured.</p><p className="mt-2 text-text-secondary">Admin perlu menambahkan IP server iperf3 yang sudah diizinkan melalui tool lokal <span className="font-data">scripts/configure_diagnostic_target.py</span>, lalu restart runner. Lihat <span className="font-data">docs/PANDUAN.md</span>. Browser tidak menerima target IP bebas dan tidak akan fallback diam-diam ke localhost.</p></div>; }
function LocalhostWarning() { return <div className="mt-4 rounded-control border border-severity-medium bg-bg-base p-4"><p className="font-medium text-severity-medium">TEST ENVIRONMENT — LOCALHOST</p><p className="mt-2 text-text-secondary">Not valid for LAN performance analysis. Nilai hanya memverifikasi pipeline.</p></div>; }
function Check({ label, ok, neutral=false, detail }: { label: string; ok: boolean; neutral?: boolean; detail: string }) { const color=ok?"text-severity-low":neutral?"text-severity-medium":"text-text-muted"; return <div className="rounded-control border border-border bg-bg-base p-3"><p className={`font-medium ${color}`}>{ok?"✓":neutral?"!":"○"} {label}</p><p className="mt-1 text-meta text-text-secondary">{detail}</p></div>; }
function Info({ label, value, data=false }: { label: string; value: string; data?: boolean }) { return <div className="rounded-control border border-border bg-bg-base p-3"><dt className="text-meta text-text-secondary">{label}</dt><dd className={`mt-2 break-words text-body ${data?"font-data":""}`}>{value}</dd></div>; }
function SectionTitle({ eyebrow, title }: { eyebrow: string; title: string }) { return <><p className="text-meta font-medium uppercase tracking-wide text-accent">{eyebrow}</p><h2 className="mt-2 text-section font-semibold">{title}</h2></>; }
function StatusPill({ ok, label }: { ok: boolean; label: string }) { return <span className={`rounded-full border px-3 py-1 text-meta font-medium ${ok?"border-severity-low text-severity-low":"border-severity-medium text-severity-medium"}`}>{ok?"✓":"○"} {label}</span>; }
function Notice({ children, tone="normal" }: { children: React.ReactNode; tone?: "normal"|"critical" }) { return <div className={`mt-4 rounded-control border bg-bg-base p-4 ${tone==="critical"?"border-severity-critical text-severity-critical":"border-border text-text-secondary"}`}>{children}</div>; }
function LiveValue({ label, value, suffix }: { label: string; value?: number; suffix: string }) { return <div><dt className="text-meta text-text-secondary">{label}</dt><dd className="mt-1 font-data text-section text-accent">{value===undefined?"-":`${value.toFixed(2)} ${suffix}`}</dd></div>; }
function ResultValue({ label, value, suffix }: { label: string; value: number|null|undefined; suffix: string }) { return <div className="rounded-control border border-border bg-bg-base p-3"><dt className="text-meta text-text-secondary">{label}</dt><dd className="mt-2 font-data text-section text-accent">{value==null?"-":`${value.toFixed(2)}${suffix?` ${suffix}`:""}`}</dd></div>; }

async function reloadMeasurements(supabase: ReturnType<typeof createClient>, setData: (data: DiagnosticsData) => void) { const {data}=await supabase.functions.invoke<{data:DiagnosticsData}>("diagnostics",{method:"GET"}); if(data?.data)setData(data.data); }
async function diagnosticJobErrorMessage(error: unknown) { if(error&&typeof error==="object"&&"context" in error){const response=(error as {context?:unknown}).context;if(response instanceof Response){try{const payload=(await response.clone().json()) as {code?:unknown;error?:unknown};if(typeof payload.error==="string")return typeof payload.code==="string"?`${payload.error} (${payload.code})`:payload.error;}catch{}}} return "Permintaan diagnostik gagal. Periksa runner, target, dan hasil preflight."; }
function measurementSummary(value?: BandwidthMeasurement): DirectionSummary|null { if(!value?.direction)return null; return {direction:value.direction,average_mbps:value.bitrate_mbps,peak_mbps:value.peak_mbps,minimum_mbps:value.minimum_mbps,transferred_mb:value.transferred_mb,retransmits:value.retransmits,duration_seconds:value.duration_seconds}; }
function connectionLabel(value?: string) { return value==="wifi"?"WiFi":value==="ethernet"?"Ethernet":"Other / Unknown"; }
function pingDetail(value?: PreflightContext["target"]|null) { if(!value)return "Tidak digunakan / belum diperiksa"; return value.status==="responded"?`Responded${value.latency_ms==null?"":` · ${value.latency_ms.toFixed(1)} ms`}`:"No ICMP response"; }
function stepIcon(state: StepState) { return state==="completed"?"✓":state==="active"?"●":state==="failed"?"×":"○"; }
function stepColor(state: StepState) { return state==="completed"?"text-severity-low":state==="active"?"text-accent":state==="failed"?"text-severity-critical":"text-text-muted"; }
function formatMaybe(value:number|null){return value===null?"-":`${value.toFixed(2)} Mbps`;}
function formatTimestamp(value:string){return new Intl.DateTimeFormat("id-ID",{dateStyle:"medium",timeStyle:"medium"}).format(new Date(value));}
function formatNumber(value:number){return new Intl.NumberFormat("id-ID",{maximumFractionDigits:2}).format(value);}
function maxNullable(values:(number|null)[]){const numbers=values.filter((value):value is number=>value!==null);return numbers.length?Math.max(...numbers):null;}
function minNullable(values:(number|null)[]){const numbers=values.filter((value):value is number=>value!==null);return numbers.length?Math.min(...numbers):null;}
