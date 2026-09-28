"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import { Button } from "@/components/ui/button";
import { diagnosticSteps, safeFailureMessage, type StepState } from "@/lib/diagnostic-ux";
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
import { localeForLanguage } from "@/i18n/config";
import { createDiagnosticJobAction, requestDiagnosticPreflightAction } from "@/app/actions/legacy-network-control";
import { getDiagnosticJobStateAction, getDiagnosticsAction } from "@/app/actions/diagnostics";
import type { ApplicationAuthority } from "@/lib/application-persistence";
import { startLocalRealtimeInvalidation } from "@/lib/network-health-realtime";

type Props = {
  initialState: DiagnosticJobState;
  diagnostics: DiagnosticsData;
  onDiagnosticsChange: (data: DiagnosticsData) => void;
  loadError: boolean;
  initialAuthority: ApplicationAuthority;
  prefillTarget?: string;
  role: ProfileRole;
};

export function OneClickDiagnostics({ initialState, diagnostics, onDiagnosticsChange, loadError, initialAuthority, prefillTarget, role }: Props) {
  const { t } = useTranslation("diagnostics");
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
  const [authority, setAuthority] = useState(initialAuthority);
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
    const clock = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(clock);
  }, []);

  useEffect(() => {
    let disposed = false;
    async function refetchState() {
      const result = await getDiagnosticJobStateAction().catch(() => null);
      if (!disposed && result?.ok) {
        setAuthority(result.authority);
        setRunners(result.data.runners);
        setJobs(result.data.jobs);
        if (result.data.jobs[0]?.status === "completed") void reloadMeasurements(onDiagnosticsChange);
      }
    }
    void refetchState();
    const onlineRefetch = () => void refetchState();
    window.addEventListener("online", onlineRefetch);

    if (authority === "local_postgres") {
      const stopRealtime = startLocalRealtimeInvalidation({
        topics: ["diagnostics"],
        refresh: () => void refetchState(),
        onStatus: (status) => setRealtimeConnected(status === "connected"),
        debounceMs: 250,
        fallbackIntervalMs: 4_000,
      });
      return () => {
        disposed = true;
        window.removeEventListener("online", onlineRefetch);
        stopRealtime();
      };
    }

    const supabase = createClient();
    const fallback = window.setInterval(() => void refetchState(), 4000);
    const channel = supabase.channel("lan-diagnostics-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "diagnostic_runners" }, (payload) => {
        const next = payload.new as DiagnosticRunner;
        if (next.id) setRunners((current) => [next, ...current.filter((item) => item.id !== next.id)]);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "diagnostic_jobs" }, (payload) => {
        const next = payload.new as DiagnosticJob;
        if (!next.id) return;
        setJobs((current) => [next, ...current.filter((item) => item.id !== next.id)].slice(0, 25));
        if (next.status === "completed") void reloadMeasurements(onDiagnosticsChange);
      })
      .subscribe((status) => {
        const connected = status === "SUBSCRIBED";
        setRealtimeConnected(connected);
        if (!connected) void refetchState();
      });
    return () => {
      disposed = true;
      window.clearInterval(fallback);
      window.removeEventListener("online", onlineRefetch);
      void supabase.removeChannel(channel);
    };
  }, [authority, onDiagnosticsChange]);

  useEffect(() => {
    if (!canOperateNetwork(role) || !runnerOnline || !runner || !target || jobActive) return;
    const key = `${runner.id}:${target.id}`;
    const freshComplete = preflight?.status === "completed" && preflight.completed_at && now - Date.parse(preflight.completed_at) < 80_000;
    if (requestedPreflight.current === key && (preflight?.status === "queued" || preflight?.status === "running" || freshComplete)) return;
    requestedPreflight.current = key;
    void requestDiagnosticPreflightAction(runner.id, target.id).then(({ ok }) => {
      if (!ok) setFormError(t("workspace.requestFailed"));
    });
  }, [jobActive, now, preflight?.completed_at, preflight?.status, role, runner, runnerOnline, t, target]);

  async function createJob() {
    const location = source.trim();
    if (!canOperateNetwork(role) || !runner || !target || !location || jobActive || !preflightReady) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const result = await createDiagnosticJobAction({
        runnerId: runner.id, sourceLabel: location, targetId: target.id, durationSeconds: selectedDuration,
      });
      if (!result.ok || !result.data) setFormError(t("workspace.requestFailed"));
      else {
        const job = result.data;
        setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
      }
    } finally { setSubmitting(false); }
  }

  const jobBandwidth = displayedJob ? diagnostics.bandwidth.filter((item) => item.job_id === displayedJob.id) : [];
  const jobHops = displayedJob ? diagnostics.hops.filter((item) => item.job_id === displayedJob.id) : [];

  return (
    <div className="grid min-w-0 gap-6">
      {loadError ? <Notice tone="critical">{t("workspace.loadError")}</Notice> : null}
      <RunnerHealth runner={runner} online={runnerOnline} />

      {network ? <CurrentNetwork network={network} runnerLabel={runner?.display_name ?? "-"} /> : (
        <section className="rounded-panel border border-border bg-bg-surface p-4 md:p-6">
          <SectionTitle eyebrow={t("workspace.currentNetwork")} title={t("workspace.waitingContext")} />
          <p className="mt-3 text-text-secondary">{t("workspace.chooseTarget")}</p>
        </section>
      )}

      <section className="rounded-panel border border-border bg-bg-surface p-4 md:p-6">
        <SectionTitle eyebrow={t("workspace.diagnosticTarget")} title={t("workspace.locationServer")} />
        <fieldset disabled={jobActive || submitting} className="mt-5 grid gap-4 disabled:opacity-60 md:grid-cols-2">
          <Select label={t("workspace.runner")} value={runner?.id ?? ""} onChange={(value) => { setRunnerId(value); setTargetId(""); requestedPreflight.current = ""; }} options={runners.map((item) => ({ value: item.id, label: item.display_name }))} />
          <SourceInput value={source} onChange={setSource} suggestions={sourceSuggestions} />
          <Select label={t("workspace.targetServer")} value={selectedTargetId} onChange={(value) => { setTargetId(value); requestedPreflight.current = ""; setFormError(null); }} options={(capabilities?.targets ?? []).map((item) => ({ value: item.id, label: `${item.label} - ${item.host}` }))} />
          <Select label={t("workspace.duration")} value={String(selectedDuration)} onChange={(value) => setDuration(Number(value))} options={(capabilities?.durations ?? []).map((item) => ({ value: String(item), label: t("workspace.seconds", { count: item }) }))} />
        </fieldset>
        {!target ? <NoTargetState /> : null}
        {target?.environment === "localhost_demo" ? <LocalhostWarning /> : null}
        {target && route ? <RouteToTarget targetLabel={target.label} route={route} connection={network?.connection_type} /> : null}
      </section>

      {target ? <ReadinessCard status={preflight?.status} network={network} route={route} checks={checks} errorCode={preflight?.error_code} /> : null}

      <section className="rounded-panel border border-border bg-bg-surface p-4 md:p-6">
        <SectionTitle eyebrow={t("workspace.runEyebrow")} title={t("workspace.runTitle")} />
        <p className="mt-3 text-text-secondary">{t("workspace.activeTraffic", { count: selectedDuration })}</p>
        {!canOperateNetwork(role) ? <Notice>{t("workspace.viewerNotice")}</Notice> : null}
        {formError ? <p className="mt-4 text-severity-critical">{formError}</p> : null}
        <Button className="mt-5 w-full sm:w-auto sm:min-w-52" disabled={!canOperateNetwork(role) || !runnerOnline || !target || !source.trim() || !preflightReady || submitting || jobActive} onClick={createJob} type="button">
          {t(jobActive || submitting ? "workspace.running" : displayedJob ? "workspace.runAgain" : "workspace.run")}
        </Button>
        {target && checks && !checks.iperf.ready ? <p className="mt-3 text-severity-medium">{t("workspace.iperfUnavailable", { port: checks.iperf.port })}</p> : null}
      </section>

      {displayedJob ? <DiagnosticProgressPanel job={displayedJob} bandwidth={jobBandwidth} hops={jobHops} realtimeConnected={realtimeConnected} /> : <Notice>{t("workspace.noJob")}</Notice>}
      <div className="flex flex-wrap gap-3"><Link className="text-accent hover:underline" href="/history">{t("workspace.viewHistory")}</Link><Link className="text-accent hover:underline" href="/traffic">{t("workspace.openTraffic")}</Link></div>
    </div>
  );
}

function RunnerHealth({ runner, online }: { runner?: DiagnosticRunner; online: boolean }) {
  const { t } = useTranslation("diagnostics");
  return <section className="rounded-panel border border-border bg-bg-surface p-4 md:p-6"><div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between"><div><SectionTitle eyebrow={t("workspace.runnerHealth")} title={runner?.display_name ?? t("workspace.runnerMissing")} /><p className="mt-2 text-text-secondary">{t(online ? "workspace.runnerReady" : "workspace.runnerOffline")}</p></div><StatusPill ok={online} label={online ? "ONLINE" : "OFFLINE"} /></div>{runner?.health_error_code ? <p className="mt-3 font-data text-meta text-severity-medium">{runner.health_error_code}</p> : null}</section>;
}

function CurrentNetwork({ network, runnerLabel }: { network: NetworkContext; runnerLabel: string }) {
  const { t, i18n } = useTranslation("diagnostics");
  return <section className="rounded-panel border border-border bg-bg-surface p-4 md:p-6"><SectionTitle eyebrow={t("workspace.currentNetwork")} title={t("workspace.contextTitle")} /><dl className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4"><Info label={t("workspace.host")} value={network.host_name} data /><Info label={t("workspace.runner")} value={runnerLabel} /><Info label={t("workspace.connection")} value={connectionLabel(network.connection_type, t)} /><Info label={t("workspace.operationalState")} value={network.operational_status.toUpperCase()} /><Info label={t("workspace.interface")} value={network.interface_alias} /><Info label={t("workspace.description")} value={network.interface_description} /><Info label={t("workspace.localIpv4")} value={`${network.local_ipv4}/${network.prefix_length}`} data /><Info label={t("workspace.subnet")} value={network.subnet_cidr} data /><Info label={t("workspace.subnetMask")} value={network.subnet_mask} data /><Info label={t("workspace.gateway")} value={network.default_gateway ?? "-"} data /><Info label={t("workspace.dns")} value={network.dns_servers.join(", ") || "-"} data /><Info label={t("workspace.linkSpeed")} value={network.link_speed_mbps == null ? "-" : `${formatNumber(network.link_speed_mbps, i18n.language)} Mbps`} data />{network.ssid ? <Info label="SSID" value={network.ssid} /> : null}{network.wifi_signal_percent != null ? <Info label={t("workspace.wifiSignal")} value={`${network.wifi_signal_percent}%`} data /> : null}</dl><p className="mt-4 text-meta text-text-muted">{t("workspace.linkHelp")}</p></section>;
}

function RouteToTarget({ targetLabel, route, connection }: { targetLabel: string; route: RouteContext; connection?: string }) {
  const { t } = useTranslation("diagnostics");
  return <div className="mt-5 border-t border-border pt-5"><p className="text-meta font-medium uppercase tracking-wide text-accent">{t("workspace.routeTarget")}</p><dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4"><Info label={t("workspace.target")} value={targetLabel} /><Info label={t("workspace.targetAddress")} value={route.resolved_target_ip} data /><Info label={t("workspace.route")} value={t(route.route_type === "on_link" ? "workspace.onLink" : "workspace.routed")} /><Info label={t("workspace.detectedConnection")} value={connectionLabel(connection, t)} /><Info label={t("workspace.sourceInterface")} value={route.interface_alias} /><Info label={t("workspace.sourceIp")} value={route.source_ip} data /><Info label={t("workspace.nextHop")} value={route.next_hop ?? t("workspace.direct")} data /><Info label={t("workspace.routeMetric")} value={String(route.route_metric)} data /></dl></div>;
}

function ReadinessCard({ status, network, route, checks, errorCode }: { status?: string; network?: NetworkContext; route?: RouteContext; checks?: PreflightContext; errorCode?: string }) {
  const { t } = useTranslation("diagnostics");
  const pending = status === "queued" || status === "running";
  return <section className="rounded-panel border border-border bg-bg-surface p-4 md:p-6"><SectionTitle eyebrow={t("workspace.preflight")} title={t(pending ? "workspace.checking" : checks?.iperf.ready ? "workspace.ready" : "workspace.bandwidthUnavailable")} /><div className="mt-5 grid gap-3 md:grid-cols-2"><Check label={t("workspace.runnerInterface")} ok={Boolean(network)} detail={network ? `${connectionLabel(network.connection_type, t)} · ${network.local_ipv4}/${network.prefix_length}` : t("workspace.waitingRunner")} /><Check label={t("workspace.runnerRoute")} ok={Boolean(route)} detail={route ? (route.route_type === "routed" ? `via ${route.next_hop}` : t("workspace.direct")) : t("workspace.unresolved")} /><Check label={t("workspace.gatewayNextHop")} ok={route?.route_type === "on_link" || checks?.gateway?.status === "responded"} neutral={checks?.gateway?.status === "no_response"} detail={route?.route_type === "on_link" ? t("workspace.unusedRoute") : pingDetail(checks?.gateway, t)} /><Check label={t("workspace.targetReachability")} ok={checks?.target.status === "responded"} neutral={checks?.target.status === "no_response"} detail={pingDetail(checks?.target, t)} /><Check label={t("workspace.iperfServer")} ok={checks?.iperf.ready === true} detail={checks ? t(checks.iperf.ready ? "workspace.readyPort" : "workspace.unavailablePort", { port: checks.iperf.port }) : t("workspace.notChecked")} /></div>{checks?.target.status === "no_response" ? <p className="mt-4 text-meta text-text-muted">{t("workspace.icmpNotice")}</p> : null}{errorCode ? <p className="mt-4 font-data text-meta text-severity-critical">{errorCode}</p> : null}</section>;
}

function DiagnosticProgressPanel({ job, bandwidth, hops, realtimeConnected }: { job: DiagnosticJob; bandwidth: DiagnosticsData["bandwidth"]; hops: DiagnosticsData["hops"]; realtimeConnected: boolean }) {
  const { t, i18n } = useTranslation("diagnostics");
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
  const eyebrow = t(active ? "workspace.activeDiagnostic" : complete ? "workspace.latestCompleted" : "workspace.latestAttempt");
  return <section className={`rounded-panel border bg-bg-surface p-4 md:p-6 ${active ? "border-accent" : "border-border"}`} aria-live="polite"><div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between"><div><SectionTitle eyebrow={eyebrow} title={`${job.source_label} → ${job.target_label}`} /><p className="mt-2 text-text-secondary">{t("workspace.perDirection", { connection: connectionLabel(job.connection_type, t), count: job.duration_seconds, time: formatTimestamp(job.created_at, i18n.language) })}</p></div><div className="md:text-right"><p className={job.status === "failed" ? "text-severity-critical" : complete ? "text-severity-low" : "text-accent"}>{diagnosticStageLabelForLocale(job, t)}</p><p className={`mt-1 text-meta ${realtimeConnected ? "text-severity-low" : "text-severity-medium"}`}>{t(realtimeConnected ? "workspace.realtimeConnected" : "workspace.realtimeFallback")}</p></div></div>{job.environment === "localhost_demo" ? <LocalhostWarning /> : null}<ContextSteps job={job} /><ProgressStepper job={job} /><div className="mt-5 grid gap-4 md:grid-cols-2"><DirectionCard direction="upload" summary={uploadSummary} active={runningDirection === "upload"} /><DirectionCard direction="download" summary={downloadSummary} active={runningDirection === "download"} /></div>{active && runningDirection ? <LiveThroughput progress={progress} direction={runningDirection} /> : null}{job.status === "failed" ? <Notice tone="critical">{safeFailureMessage(job.error_code)}{job.error_code ? ` (${job.error_code})` : ""}</Notice> : null}{complete ? <FinalResult job={job} bandwidth={bandwidth} upload={upload} download={download} hops={hops} highestLatency={highestLatency} highestLoss={highestLoss} /> : null}{complete && hops.length > 0 ? <div className="mt-6 rounded-control border border-border bg-bg-base p-4"><p className="font-medium">{t("workspace.pathStored")}</p><p className="mt-1 text-meta text-text-secondary">{t("workspace.pathStoredHelp")}</p><a className="mt-3 inline-block text-accent hover:underline" href="#diagnostic-results">{t("workspace.viewSessionHistory")}</a></div> : null}</section>;
}

function FinalResult({ job, bandwidth, upload, download, hops, highestLatency, highestLoss }: { job: DiagnosticJob; bandwidth: DiagnosticsData["bandwidth"]; upload?: BandwidthMeasurement; download?: BandwidthMeasurement; hops: DiagnosticsData["hops"]; highestLatency: number | null; highestLoss: number | null }) {
  const { t, i18n } = useTranslation("diagnostics");
  const network = job.network_context;
  const route = job.route_context;
  return <div className="mt-6 border-t border-border pt-6"><p className="text-meta font-medium uppercase tracking-wide text-severity-low">{t("workspace.complete")}</p><dl className="mt-4 grid gap-4 md:grid-cols-4"><Info label={t("workspace.source")} value={job.source_label} /><Info label={t("workspace.connection")} value={connectionLabel(job.connection_type, t)} /><Info label={t("workspace.localIp")} value={network?.local_ipv4 ?? "-"} data /><Info label={t("workspace.linkSpeed")} value={network?.link_speed_mbps == null ? "-" : `${formatNumber(network.link_speed_mbps, i18n.language)} Mbps`} data /><Info label={t("workspace.target")} value={`${job.target_label} · ${job.target_host}`} /><Info label={t("workspace.route")} value={route?.route_type === "routed" ? `via ${route.next_hop}` : t("workspace.onLink")} data /><Info label={t("workspace.measured")} value={formatTimestamp(job.completed_at ?? job.updated_at, i18n.language)} data /></dl><p className="mt-6 text-meta font-medium uppercase tracking-wide text-accent">{t("workspace.bandwidth")}</p><dl className="mt-3 grid gap-4 md:grid-cols-4"><ResultValue label={t("workspace.upload")} value={upload?.bitrate_mbps} suffix="Mbps" /><ResultValue label={t("workspace.download")} value={download?.bitrate_mbps} suffix="Mbps" /><ResultValue label={t("workspace.highestPeak")} value={maxNullable(bandwidth.map((item) => item.peak_mbps))} suffix="Mbps" /><ResultValue label={t("workspace.lowestMinimum")} value={minNullable(bandwidth.map((item) => item.minimum_mbps))} suffix="Mbps" /></dl><p className="mt-6 text-meta font-medium uppercase tracking-wide text-accent">{t("workspace.path")}</p><dl className="mt-3 grid gap-4 md:grid-cols-4"><ResultValue label={t("workspace.respondingHops")} value={hops.length} suffix="" /><ResultValue label={t("workspace.highestLatency")} value={highestLatency} suffix="ms" /><ResultValue label={t("workspace.highestLoss")} value={highestLoss} suffix="%" /></dl><Interpretation network={network} route={route} highestLoss={highestLoss} /></div>;
}

function Interpretation({ network, route, highestLoss }: { network: NetworkContext | null; route: RouteContext | null; highestLoss: number | null }) {
  const { t, i18n } = useTranslation("diagnostics");
  if (!network) return null;
  const speed = network.link_speed_mbps == null ? t("interpretation.unavailable") : `${formatNumber(network.link_speed_mbps, i18n.language)} Mbps`;
  return <div className="mt-6 rounded-control border border-border bg-bg-base p-4"><p className="text-meta font-medium uppercase tracking-wide text-accent">{t("interpretation.title")}</p><div className="mt-3 grid gap-2 text-text-secondary"><p>{t("interpretation.interface", { connection: connectionLabel(network.connection_type, t) })}</p><p>{t("interpretation.link", { speed })}</p><p>{t(network.connection_type === "wifi" ? "interpretation.wifi" : "interpretation.ethernet")}</p><p>{highestLoss != null && highestLoss > 0 ? t("interpretation.loss", { loss: highestLoss.toFixed(1) }) : t("interpretation.noLoss")}</p><p>{t(route?.route_type === "on_link" ? "interpretation.onLink" : "interpretation.routed")}</p><p>{t("interpretation.compare")}</p></div></div>;
}

function ContextSteps({ job }: { job: DiagnosticJob }) { const { t } = useTranslation("diagnostics"); const complete = Boolean(job.network_context && job.route_context && job.preflight_context); return <ol className="mt-5 grid gap-2 rounded-control border border-border bg-bg-base p-4 md:grid-cols-3"><Step ok={complete} label={t("workspace.contextCaptured")} /><Step ok={complete} label={t("workspace.routeResolved")} /><Step ok={job.preflight_context?.iperf.ready === true} label={t("workspace.targetReady")} /></ol>; }
function Step({ ok, label }: { ok: boolean; label: string }) { return <li className={`flex items-center gap-2 ${ok ? "text-severity-low" : "text-text-muted"}`}><span aria-hidden="true">{ok ? "✓" : "○"}</span>{label}</li>; }
function ProgressStepper({ job }: { job: DiagnosticJob }) { const { t } = useTranslation("diagnostics"); const labels = { runner: t("workspace.stepRunner"), target: t("workspace.stepTarget"), upload: t("workspace.upload"), download: t("workspace.download"), path: t("workspace.path"), save: t("workspace.stepSave") }; return <ol className="mt-3 grid gap-2 rounded-control border border-border bg-bg-base p-4 md:grid-cols-3">{diagnosticSteps(job).map((step) => <li className={`flex items-center gap-2 text-body ${stepColor(step.state)}`} key={step.id}><span className="font-data" aria-hidden="true">{stepIcon(step.state)}</span><span>{labels[step.id]}</span></li>)}</ol>; }
function LiveThroughput({ progress, direction }: { progress: DiagnosticProgress; direction: "upload" | "download" }) { const { t } = useTranslation("diagnostics"); const percent = Math.min(100, Math.max(0, progress.progress_percent ?? 0)); return <div className="mt-5 rounded-control border border-accent bg-bg-base p-4"><div className="flex items-center justify-between gap-4"><p className="font-medium text-accent">{t("workspace.measuring", { direction: t(`workspace.${direction}`) })}</p><p className="font-data text-meta text-text-secondary">{t("workspace.seconds", { count: `${(progress.elapsed_seconds ?? 0).toFixed(1)} / ${progress.duration_seconds ?? 0}` })}</p></div><div className="mt-3 h-2 overflow-hidden rounded-full bg-border" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><div className="h-full bg-accent" style={{ width: `${percent}%` }} /></div><dl className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4"><LiveValue label={t("workspace.current")} value={progress.current_mbps} suffix="Mbps" /><LiveValue label={t("workspace.average")} value={progress.average_mbps} suffix="Mbps" /><LiveValue label={t("workspace.peak")} value={progress.peak_mbps} suffix="Mbps" /><LiveValue label={t("workspace.minimum")} value={progress.minimum_mbps} suffix="Mbps" /></dl><div className="mt-4"><LiveChart samples={progress.live_samples ?? []} direction={direction} /></div></div>; }
function DirectionCard({ direction, summary, active }: { direction: "upload" | "download"; summary: DirectionSummary | null; active: boolean }) { const { t } = useTranslation("diagnostics"); return <article className={`rounded-control border bg-bg-base p-4 ${active ? "border-accent" : "border-border"}`}><div className="flex items-center justify-between"><p className="text-meta font-medium uppercase text-text-secondary">{t(`workspace.${direction}`)}</p><span className={summary ? "text-severity-low" : active ? "text-accent" : "text-text-muted"}>{t(summary ? "workspace.done" : active ? "workspace.active" : "workspace.waiting")}</span></div><p className="mt-3 font-data text-heading text-accent">{summary ? `${summary.average_mbps.toFixed(2)} Mbps` : "-"}</p>{summary ? <p className="mt-2 font-data text-meta text-text-muted">{t("workspace.summary", { peak: formatMaybe(summary.peak_mbps), minimum: formatMaybe(summary.minimum_mbps), retransmits: summary.retransmits ?? "-" })}</p> : null}</article>; }
function LiveChart({ samples, direction }: { samples: LiveSample[]; direction: "upload" | "download" }) { const { t } = useTranslation("diagnostics"); if (!samples.length) return <div className="h-36 rounded-control border border-border bg-bg-surface" />; const width=640,height=150,pad=16,max=Math.max(1,...samples.map((item)=>item.mbps)); const path=samples.map((sample,index)=>{const x=pad+(samples.length===1?0:index/(samples.length-1)*(width-pad*2)); const y=height-pad-sample.mbps/max*(height-pad*2); return `${index?"L":"M"} ${x.toFixed(1)} ${y.toFixed(1)}`;}).join(" "); return <svg className="w-full rounded-control border border-border bg-bg-surface" role="img" aria-label={t("workspace.liveChart", { direction: t(`workspace.${direction}`) })} viewBox={`0 0 ${width} ${height}`}><path d={path} className="fill-none stroke-accent" strokeWidth="3" /></svg>; }

function SourceInput({ value, onChange, suggestions }: { value: string; onChange: (value: string) => void; suggestions: string[] }) { const { t } = useTranslation("diagnostics"); return <label className="grid min-w-0 gap-2 text-meta font-medium text-text-secondary">{t("workspace.sourceLocation")}<input className="w-full min-w-0 rounded-control border border-border bg-bg-base px-3 py-2 text-body text-text-primary outline-none focus:border-accent" list="source-location-suggestions" maxLength={200} placeholder={t("workspace.sourcePlaceholder")} value={value} onChange={(event) => onChange(event.target.value)} /><span className="font-normal text-text-muted">{t("workspace.sourceHelp")}</span><datalist id="source-location-suggestions">{suggestions.map((item) => <option key={item} value={item} />)}</datalist></label>; }
function Select({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void }) { const { t } = useTranslation("diagnostics"); const unique=Array.from(new Map(options.map((option)=>[option.value,option])).values()); return <label className="grid min-w-0 gap-2 text-meta font-medium text-text-secondary">{label}<select className="w-full min-w-0 rounded-control border border-border bg-bg-base px-3 py-2 text-body text-text-primary outline-none focus:border-accent" value={value} onChange={(event)=>onChange(event.target.value)}>{unique.length ? unique.map((option)=><option key={`${label}:${option.value}`} value={option.value}>{option.label}</option>) : <option value="">{t("workspace.unavailable")}</option>}</select></label>; }
function NoTargetState() { const { t } = useTranslation("diagnostics"); return <div className="mt-5 rounded-control border border-severity-medium bg-bg-base p-4"><p className="font-medium text-severity-medium">{t("workspace.noTarget")}</p><p className="mt-2 text-text-secondary">{t("workspace.noTargetHelp")}</p></div>; }
function LocalhostWarning() { const { t } = useTranslation("diagnostics"); return <div className="mt-4 rounded-control border border-severity-medium bg-bg-base p-4"><p className="font-medium text-severity-medium">{t("workspace.testEnvironment")}</p><p className="mt-2 text-text-secondary">{t("workspace.testEnvironmentHelp")}</p></div>; }
function Check({ label, ok, neutral=false, detail }: { label: string; ok: boolean; neutral?: boolean; detail: string }) { const color=ok?"text-severity-low":neutral?"text-severity-medium":"text-text-muted"; return <div className="rounded-control border border-border bg-bg-base p-3"><p className={`font-medium ${color}`}>{ok?"✓":neutral?"!":"○"} {label}</p><p className="mt-1 text-meta text-text-secondary">{detail}</p></div>; }
function Info({ label, value, data=false }: { label: string; value: string; data?: boolean }) { return <div className="rounded-control border border-border bg-bg-base p-3"><dt className="text-meta text-text-secondary">{label}</dt><dd className={`mt-2 break-words text-body ${data?"font-data":""}`}>{value}</dd></div>; }
function SectionTitle({ eyebrow, title }: { eyebrow: string; title: string }) { return <><p className="text-meta font-medium uppercase tracking-wide text-accent">{eyebrow}</p><h2 className="mt-2 text-section font-semibold">{title}</h2></>; }
function StatusPill({ ok, label }: { ok: boolean; label: string }) { return <span className={`rounded-full border px-3 py-1 text-meta font-medium ${ok?"border-severity-low text-severity-low":"border-severity-medium text-severity-medium"}`}>{ok?"✓":"○"} {label}</span>; }
function Notice({ children, tone="normal" }: { children: React.ReactNode; tone?: "normal"|"critical" }) { return <div className={`mt-4 rounded-control border bg-bg-base p-4 ${tone==="critical"?"border-severity-critical text-severity-critical":"border-border text-text-secondary"}`}>{children}</div>; }
function LiveValue({ label, value, suffix }: { label: string; value?: number; suffix: string }) { return <div><dt className="text-meta text-text-secondary">{label}</dt><dd className="mt-1 font-data text-section text-accent">{value===undefined?"-":`${value.toFixed(2)} ${suffix}`}</dd></div>; }
function ResultValue({ label, value, suffix }: { label: string; value: number|null|undefined; suffix: string }) { return <div className="rounded-control border border-border bg-bg-base p-3"><dt className="text-meta text-text-secondary">{label}</dt><dd className="mt-2 font-data text-section text-accent">{value==null?"-":`${value.toFixed(2)}${suffix?` ${suffix}`:""}`}</dd></div>; }

async function reloadMeasurements(setData: (data: DiagnosticsData) => void) { const result=await getDiagnosticsAction(); if(result.ok)setData(result.data); }
function measurementSummary(value?: BandwidthMeasurement): DirectionSummary|null { if(!value?.direction)return null; return {direction:value.direction,average_mbps:value.bitrate_mbps,peak_mbps:value.peak_mbps,minimum_mbps:value.minimum_mbps,transferred_mb:value.transferred_mb,retransmits:value.retransmits,duration_seconds:value.duration_seconds}; }
function connectionLabel(value?: string, t?: TFunction) { return value==="wifi"?"WiFi":value==="ethernet"?"Ethernet":t ? t("workspace.otherConnection") : "Other / Unknown"; }
function pingDetail(value: PreflightContext["target"]|null|undefined, t: TFunction) { if(!value)return t("workspace.unusedUnchecked"); return value.status==="responded"?`${t("workspace.responded")}${value.latency_ms==null?"":` · ${value.latency_ms.toFixed(1)} ms`}`:t("workspace.noIcmp"); }
function stepIcon(state: StepState) { return state==="completed"?"✓":state==="active"?"●":state==="failed"?"×":"○"; }
function stepColor(state: StepState) { return state==="completed"?"text-severity-low":state==="active"?"text-accent":state==="failed"?"text-severity-critical":"text-text-muted"; }
function formatMaybe(value:number|null){return value===null?"-":`${value.toFixed(2)} Mbps`;}
function formatTimestamp(value:string, language="id"){return new Intl.DateTimeFormat(localeForLanguage(language),{dateStyle:"medium",timeStyle:"medium"}).format(new Date(value));}
function formatNumber(value:number, language="id"){return new Intl.NumberFormat(localeForLanguage(language),{maximumFractionDigits:2}).format(value);}
function diagnosticStageLabelForLocale(job: DiagnosticJob, t: TFunction) { if (job.status === "completed") return t("stage.completed"); if (job.status === "failed") return t("stage.failed"); return t(`stage.${job.stage}`, { defaultValue: t("stage.default") }); }
function maxNullable(values:(number|null)[]){const numbers=values.filter((value):value is number=>value!==null);return numbers.length?Math.max(...numbers):null;}
function minNullable(values:(number|null)[]){const numbers=values.filter((value):value is number=>value!==null);return numbers.length?Math.min(...numbers):null;}
