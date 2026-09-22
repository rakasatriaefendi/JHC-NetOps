"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import { Button } from "@/components/ui/button";
import { useNetworkNodes } from "@/components/diagnostics/network-nodes-provider";
import { useDeviceProfile } from "@/components/device-profile/device-profile-provider";
import { findNetworkNode } from "@/lib/network-nodes";
import type { DiagnosticsData } from "@/lib/diagnostics";
import { createClient } from "@/lib/supabase/client";
import { canOperateNetwork } from "@/lib/authorization";
import {
  filterFlows,
  isTrafficRunnerAvailable,
  mergeTrafficRunnerSnapshots,
  type TrafficFlow,
  type TrafficSnapshot,
  type TrafficState,
} from "@/lib/traffic";
import { mutateTrafficSessionAction } from "@/app/actions/legacy-network-control";
import { getTrafficRunnersAction } from "@/app/actions/traffic";

type Tab = "flows" | "conversations" | "talkers";

export function TrafficLivePage({
  initialState,
  diagnostics,
  loadError,
  initialSearch,
}: {
  initialState: TrafficState;
  diagnostics: DiagnosticsData;
  loadError: boolean;
  initialSearch?: string;
}) {
  const { t, i18n } = useTranslation("traffic");
  const [state, setState] = useState(initialState);
  const [runnerId, setRunnerId] = useState(initialState.runners[0]?.id ?? "");
  const [now, setNow] = useState(() => Date.now());
  const [duration, setDuration] = useState(600);
  const [tab, setTab] = useState<Tab>("flows");
  const [search, setSearch] = useState(initialSearch ?? "");
  const [protocol, setProtocol] = useState("all");
  const [status, setStatus] = useState("all");
  const [detail, setDetail] = useState<TrafficFlow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [realtime, setRealtime] = useState(false);
  const [runnerAuthority, setRunnerAuthority] = useState<"supabase" | "local_postgres" | null>(null);
  const runnerAuthorityRef = useRef<"supabase" | "local_postgres" | null>(null);

  const runner = state.runners.find((item) => item.id === runnerId) ?? state.runners[0];
  const active = state.sessions.find(
    (session) =>
      session.runner_id === runner?.id &&
      ["queued", "running", "stopping"].includes(session.status),
  );
  const snapshot = state.snapshots.find((item) => item.runner_id === runner?.id);
  const durations = runner?.capabilities.traffic_durations_seconds ?? [300, 600, 900, 1800];
  const filtered = useMemo(
    () => filterFlows(snapshot?.flows ?? [], search, protocol, status),
    [snapshot, search, protocol, status],
  );
  const online = isTrafficRunnerAvailable(runner, now);
  const elapsedSeconds = active?.started_at
    ? Math.max(0, Math.floor((now - Date.parse(active.started_at)) / 1000))
    : 0;

  useEffect(() => {
    let disposed = false;
    void getTrafficRunnersAction().then((result) => {
      if (disposed) return;
      runnerAuthorityRef.current = result.authority;
      setRunnerAuthority(result.authority);
      if (result.ok) {
        setState((current) => ({ ...current, runners: mergeTrafficRunnerSnapshots(current.runners, result.data) }));
        setNow(Date.now());
      }
    }).catch(() => {
      // Retain the last runner snapshot until its normal freshness window expires.
    });
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    if (runnerAuthority !== "local_postgres") return;
    let disposed = false;
    let refreshing = false;
    async function refreshRunners() {
      if (refreshing) return;
      refreshing = true;
      try {
        const result = await getTrafficRunnersAction();
        if (!disposed && result.ok && result.authority === "local_postgres") {
          setState((current) => ({ ...current, runners: mergeTrafficRunnerSnapshots(current.runners, result.data) }));
          setNow(Date.now());
        }
      } catch {
        // A transient refresh failure does not erase the last authoritative heartbeat.
      } finally {
        refreshing = false;
      }
    }
    const interval = window.setInterval(() => void refreshRunners(), 10_000);
    return () => { disposed = true; window.clearInterval(interval); };
  }, [runnerAuthority]);

  useEffect(() => {
    let disposed = false;
    const supabase = createClient();

    async function refresh() {
      const { data, error } = await supabase.functions.invoke<{ data: TrafficState }>(
        "traffic-live",
        { method: "GET" },
      );
      if (!disposed && !error && data?.data) {
        setState((current) => runnerAuthorityRef.current === "local_postgres"
          ? { ...data.data, runners: current.runners }
          : data.data);
      }
    }

    const poll = window.setInterval(() => void refresh(), 5_000);
    const clock = window.setInterval(() => setNow(Date.now()), 1_000);
    const channel = supabase
      .channel("traffic-live-snapshot")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "traffic_live_snapshots" },
        (payload) => {
          const next = payload.new as TrafficSnapshot;
          if (!next.runner_id) return;
          setState((current) => ({
            ...current,
            snapshots: [
              next,
              ...current.snapshots.filter((item) => item.runner_id !== next.runner_id),
            ],
          }));
        },
      )
      .subscribe((next) => {
        setRealtime(next === "SUBSCRIBED");
        if (next !== "SUBSCRIBED") void refresh();
      });

    return () => {
      disposed = true;
      window.clearInterval(poll);
      window.clearInterval(clock);
      void supabase.removeChannel(channel);
    };
  }, []);

  async function runAction(actionName: "create_session" | "stop_session") {
    if (!runner) return;
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const result = await mutateTrafficSessionAction(actionName === "create_session"
      ? { action: actionName, runnerId: runner.id, durationSeconds: duration }
      : { action: actionName, sessionId: active?.id });
    if (!result.ok) setError(t("requestFailed"));
    const latest = await supabase.functions.invoke<{ data: TrafficState }>("traffic-live", {
      method: "GET",
    });
    const latestState = latest.data?.data;
    if (latestState) {
      setState((current) => runnerAuthorityRef.current === "local_postgres"
        ? { ...latestState, runners: current.runners }
        : latestState);
    }
    setBusy(false);
  }

  return (
    <div className="grid min-w-0 gap-6">
      {loadError ? (
        <Notice tone="critical">
          {t("capture.loadError")}
        </Notice>
      ) : null}

      <section className="min-w-0 rounded-panel border border-border bg-bg-surface p-4 md:p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-meta font-medium uppercase tracking-wide text-accent">
              {t("capture.eyebrow")}
            </p>
            <h2 className="mt-2 text-section font-semibold">{t("capture.title")}</h2>
            <p className="mt-2 max-w-3xl text-text-secondary">
              {t("capture.description")}
            </p>
          </div>
          <div className="flex flex-wrap gap-2 md:justify-end">
            <StatePill active={online} label={t(online ? "capture.runnerOnline" : "capture.runnerOffline")} />
            <StatePill
              active={Boolean(active && active.status !== "stopping")}
              label={t(active ? (active.status === "stopping" ? "capture.stopping" : "capture.live") : "capture.stopped")}
            />
          </div>
        </div>

        <dl className="mt-5 grid gap-3 sm:grid-cols-3">
          <StatusValue label="Runner" value={runner?.display_name ?? t("capture.unavailable")} />
          <StatusValue label={t("capture.started")} value={active?.started_at ? formatTime(active.started_at, i18n.language) : "-"} data />
          <StatusValue label={t("capture.elapsed")} value={active?.started_at ? formatDuration(elapsedSeconds) : "-"} data />
        </dl>

        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <Select
            label="Runner"
            value={runner?.id ?? ""}
            onChange={setRunnerId}
            disabled={Boolean(active)}
            options={state.runners.map((item) => ({ value: item.id, label: item.display_name }))}
          />
          <Select
            label={t("capture.duration")}
            value={String(duration)}
            onChange={(value) => setDuration(Number(value))}
            disabled={Boolean(active)}
            options={durations.map((value) => ({
              value: String(value),
              label: t("capture.minutes", { count: value / 60 }),
            }))}
          />
        </div>
        <p className="mt-3 text-meta text-text-muted">
          {t("capture.safety")}
        </p>

        {canOperateNetwork(state.role) ? (
          <div className="mt-5 flex min-w-0 gap-3">
            {active ? (
              <Button
                variant="destructive"
                disabled={busy || active.status === "stopping"}
                onClick={() => void runAction("stop_session")}
              >
                {t(active.status === "stopping" ? "capture.stoppingAction" : "capture.stop")}
              </Button>
            ) : (
              <Button
                className="w-full sm:w-auto"
                data-testid="start-traffic-capture"
                disabled={busy || !online || state.storage_status.status === "critical"}
                onClick={() => void runAction("create_session")}
              >
                {t(busy ? "capture.preparing" : "capture.start")}
              </Button>
            )}
          </div>
        ) : (
          <p className="mt-5 text-text-secondary">
            {t("capture.viewer")}
          </p>
        )}
        {error ? <p className="mt-4 text-severity-critical">{error}</p> : null}
      </section>

      <StorageNotice status={state.storage_status.status} mb={Number(state.storage_status.storage_mb)} />

      <section className="min-w-0 rounded-panel border border-border bg-bg-surface p-4 md:p-6">
        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-meta font-medium uppercase tracking-wide text-accent">
              {t("live.eyebrow")}
            </p>
            <h2 className="mt-2 text-section font-semibold">{t("live.title")}</h2>
          </div>
          <div className="text-meta text-text-muted md:text-right">
            <p>{t(realtime ? "live.connected" : "live.reconnecting")}</p>
            <p className="mt-1 font-data">
              {snapshot ? formatTime(snapshot.captured_at, i18n.language) : t("live.noSnapshot")}
            </p>
          </div>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <Metric label={t("live.observedRx")} value={metric(snapshot?.summary.observed_rx_mbps, "Mbps")} />
          <Metric label={t("live.observedTx")} value={metric(snapshot?.summary.observed_tx_mbps, "Mbps")} />
          <Metric label={t("live.packetsSecond")} value={formatNumber(snapshot?.summary.packets_per_second, i18n.language)} />
          <Metric label={t("live.activeFlows")} value={formatNumber(snapshot?.summary.active_flows, i18n.language)} />
          <Metric label={t("live.topTalker")} value={snapshot?.top_talkers[0]?.ip ?? "-"} />
          <Metric label={t("live.protocol")} value={snapshot?.summary.dominant_protocol?.toUpperCase() ?? "-"} />
        </div>
        <p className="mt-3 text-meta text-text-muted">
          {t("live.footnote")}
        </p>

        <div className="mt-6 flex flex-wrap gap-2" role="tablist">
          {(["flows", "conversations", "talkers"] as Tab[]).map((value) => (
            <button
              key={value}
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className={`rounded-control border px-3 py-2 ${
                tab === value ? "border-accent text-accent" : "border-border text-text-secondary"
              }`}
            >
              {t(`live.tabs.${value}`)}
            </button>
          ))}
        </div>

        {tab === "flows" ? (
          <FlowExplorer
            flows={filtered}
            search={search}
            setSearch={setSearch}
            protocol={protocol}
            setProtocol={setProtocol}
            status={status}
            setStatus={setStatus}
            onDetail={setDetail}
          />
        ) : tab === "conversations" ? (
          <Conversations snapshot={snapshot} />
        ) : (
          <Talkers snapshot={snapshot} />
        )}
      </section>

      <Notice>
        Traffic metadata menunjukkan aktivitas, bukan diagnosis otomatis. Pilih flow untuk
        membuka latest measured path terpisah atau jalankan LAN Diagnostics secara manual.
      </Notice>
      {detail ? (
        <FlowDetail flow={detail} diagnostics={diagnostics} close={() => setDetail(null)} />
      ) : null}
    </div>
  );
}

function FlowExplorer({
  flows,
  search,
  setSearch,
  protocol,
  setProtocol,
  status,
  setStatus,
  onDetail,
}: {
  flows: TrafficFlow[];
  search: string;
  setSearch: (value: string) => void;
  protocol: string;
  setProtocol: (value: string) => void;
  status: string;
  setStatus: (value: string) => void;
  onDetail: (flow: TrafficFlow) => void;
}) {
  const { t, i18n } = useTranslation("traffic");
  const { nodes } = useNetworkNodes();
  const { openDeviceProfile } = useDeviceProfile();
  const endpointCell = (ip: string, port: number | null) => {
    const node = findNetworkNode(nodes, ip);
    if (!node) return <span className="font-data">{endpoint(ip, port)}</span>;
    return <button className="text-left text-accent hover:underline" onClick={() => openDeviceProfile({ ipAddress: ip })}><span className="block font-medium">{node.name}</span><span className="font-data text-meta text-text-secondary">{endpoint(ip, port)}</span>{node.detected_fingerprint ? <span className="block text-meta text-text-muted">{node.detected_fingerprint.detected_identity.likely_label ?? node.detected_fingerprint.likely_device_type}</span> : null}</button>;
  };
  return (
    <div className="mt-5">
      <div className="grid gap-3 md:grid-cols-3">
        <label className="grid gap-2 text-meta text-text-secondary">
          {t("flows.search")}
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="rounded-control border border-border bg-bg-base px-3 py-2 text-text-primary"
            placeholder={t("flows.placeholder")}
          />
        </label>
        <Select
          label={t("flows.protocol")}
          value={protocol}
          onChange={setProtocol}
          options={["all", "tcp", "udp", "icmp"].map((value) => ({
            value,
            label: value.toUpperCase(),
          }))}
        />
        <Select
          label={t("flows.status")}
          value={status}
          onChange={setStatus}
          options={[
            { value: "all", label: t("flows.all") },
            { value: "active", label: t("flows.active") },
            { value: "idle", label: t("flows.idle") },
          ]}
        />
      </div>

      <div className="mt-4 hidden max-w-full overflow-x-auto md:block">
        <table className="w-full min-w-[1100px] border-collapse text-left">
          <thead>
            <tr className="border-y border-border text-meta text-text-secondary">
              {[t("flows.columns.lastSeen"), t("flows.columns.source"), t("flows.columns.destination"), t("flows.columns.service"), t("flows.columns.rate"), t("flows.columns.transferred"), t("flows.columns.packets"), t("flows.columns.status"), ""].map((heading) => (
                <th className="px-3 py-3 font-medium" key={heading}>{heading}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {flows.map((flow) => (
              <tr className="border-b border-border" key={flow.flow_key}>
                <td className="px-3 py-3 font-data text-meta">{formatTime(flow.last_seen, i18n.language)}</td>
                <td className="px-3 py-3">{endpointCell(flow.src_ip, flow.src_port)}</td>
                <td className="px-3 py-3">{endpointCell(flow.dst_ip, flow.dst_port)}</td>
                <td className="px-3 py-3">
                  {flow.protocol.toUpperCase()}
                  <span className="block text-meta text-text-muted">{flow.service ?? t("flows.unknown")}</span>
                </td>
                <td className="px-3 py-3 font-data text-accent">
                  {(flow.rate_mbps ?? 0).toFixed(3)} Mbps
                  <span className="block text-meta text-text-muted">{trendLabel(flow.rate_trend, t)}</span>
                </td>
                <td className="px-3 py-3 font-data">{bytes(flow.total_bytes, i18n.language)}</td>
                <td className="px-3 py-3 font-data">{formatNumber(flow.packet_count, i18n.language)}</td>
                <td className="px-3 py-3">{flow.status}</td>
                <td className="px-3 py-3">
                  <button className="text-accent underline" onClick={() => onDetail(flow)}>{t("flows.detail")}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 grid gap-3 md:hidden">
        {flows.map((flow) => (
          <button
            className="rounded-control border border-border bg-bg-base p-4 text-left"
            key={flow.flow_key}
            onClick={() => onDetail(flow)}
          >
            <p className="font-data">{endpoint(flow.src_ip, flow.src_port)} → {endpoint(flow.dst_ip, flow.dst_port)}</p>
            <p className="mt-2 text-meta text-text-secondary">
              {flow.protocol.toUpperCase()} · {(flow.rate_mbps ?? 0).toFixed(3)} Mbps · {bytes(flow.total_bytes, i18n.language)}
            </p>
            <p className="mt-1 font-data text-meta text-text-muted">{formatTime(flow.last_seen, i18n.language)} · {flow.status}</p>
          </button>
        ))}
      </div>
      {flows.length === 0 ? <p className="mt-5 text-text-secondary">{t("flows.empty")}</p> : null}
    </div>
  );
}

function Conversations({ snapshot }: { snapshot?: TrafficSnapshot }) {
  const { t, i18n } = useTranslation("traffic");
  return (
    <div className="mt-5 grid gap-3">
      {snapshot?.conversations.map((conversation) => (
        <article className="rounded-control border border-border bg-bg-base p-4" key={`${conversation.endpoint_a}-${conversation.endpoint_b}`}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="font-data">{conversation.endpoint_a} ↔ {conversation.endpoint_b}</p>
              <p className="mt-2 text-meta text-text-secondary">
                {(conversation.protocol ?? "unknown").toUpperCase()} · {conversation.service ?? t("flows.unknown")} · {t("flows.activeFlows", { count: conversation.active_flows ?? 0 })}
              </p>
            </div>
            <p className="font-data text-accent">{(conversation.rate_mbps ?? 0).toFixed(3)} Mbps</p>
          </div>
          <p className="mt-3 text-meta text-text-muted">
            A→B {bytes(conversation.a_to_b_bytes, i18n.language)} · B→A {bytes(conversation.b_to_a_bytes, i18n.language)} · {t("flows.total")} {bytes(conversation.total_bytes, i18n.language)}
          </p>
          <p className="mt-1 font-data text-meta text-text-muted">
            {formatTime(conversation.first_seen, i18n.language)} – {formatTime(conversation.last_seen, i18n.language)}
          </p>
        </article>
      ))}
      {!snapshot?.conversations.length ? <p className="text-text-secondary">{t("flows.conversationEmpty")}</p> : null}
    </div>
  );
}

function Talkers({ snapshot }: { snapshot?: TrafficSnapshot }) {
  const { t } = useTranslation("traffic");
  const { nodes } = useNetworkNodes();
  const { openDeviceProfile } = useDeviceProfile();
  return (
    <div className="mt-5 grid gap-3">
      {snapshot?.top_talkers.map((talker, index) => (
        <article className="flex items-center justify-between rounded-control border border-border bg-bg-base p-4" key={talker.ip}>
          <p>
            <span className="mr-3 font-data text-text-muted">#{index + 1}</span>
            {findNetworkNode(nodes, talker.ip) ? <button className="text-accent hover:underline" onClick={() => openDeviceProfile({ ipAddress: talker.ip })}><span className="font-medium">{findNetworkNode(nodes, talker.ip)?.name}</span><span className="ml-2 font-data text-meta">{talker.ip}</span></button> : <span className="font-data">{talker.ip}</span>}
            <span className="ml-3 text-meta text-text-muted">{t("flows.activeFlows", { count: talker.active_flows ?? 0 })}</span>
          </p>
          <p className="font-data text-accent">{(talker.rate_mbps ?? 0).toFixed(3)} Mbps</p>
        </article>
      ))}
      {!snapshot?.top_talkers.length ? <p className="text-text-secondary">{t("flows.talkerEmpty")}</p> : null}
    </div>
  );
}

function FlowDetail({
  flow,
  diagnostics,
  close,
}: {
  flow: TrafficFlow;
  diagnostics: DiagnosticsData;
  close: () => void;
}) {
  const { t, i18n } = useTranslation("traffic");
  const related = latestMeasuredPath(diagnostics, flow.dst_ip);
  const durationSeconds = Math.max(0, Math.floor((Date.parse(flow.last_seen) - Date.parse(flow.first_seen)) / 1000));
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-bg-base/80" role="dialog" aria-modal="true">
      <aside className="h-full w-full max-w-lg overflow-y-auto border-l border-border bg-bg-surface p-6">
        <div className="flex justify-between">
          <h2 className="text-section font-semibold">{t("detail.title")}</h2>
          <button onClick={close} aria-label={t("detail.close")} className="text-text-secondary">×</button>
        </div>
        <dl className="mt-6 grid gap-4">
          {[
            [t("detail.source"), endpoint(flow.src_ip, flow.src_port)],
            [t("detail.destination"), endpoint(flow.dst_ip, flow.dst_port)],
            [t("detail.protocol"), flow.protocol.toUpperCase()],
            [t("detail.service"), flow.service ?? t("detail.unknownService")],
            [t("detail.currentRate"), `${(flow.rate_mbps ?? 0).toFixed(3)} Mbps (${trendLabel(flow.rate_trend, t)})`],
            [t("detail.peakRate"), `${(flow.peak_rate_mbps ?? 0).toFixed(3)} Mbps`],
            [t("detail.packetsSecond"), formatNumber(flow.packets_per_second, i18n.language)],
            [t("detail.packets"), formatNumber(flow.packet_count, i18n.language)],
            [t("detail.transferred"), bytes(flow.total_bytes, i18n.language)],
            [t("detail.firstSeen"), formatTime(flow.first_seen, i18n.language)],
            [t("detail.lastSeen"), formatTime(flow.last_seen, i18n.language)],
            [t("detail.duration"), formatDuration(durationSeconds)],
            [t("detail.status"), flow.status],
          ].map(([key, value]) => (
            <div className="rounded-control border border-border bg-bg-base p-3" key={key}>
              <dt className="text-meta text-text-secondary">{key}</dt>
              <dd className="mt-1 break-all font-data">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-5 text-meta text-text-muted">
          {t("detail.serviceNotice")}
        </p>

        <div className="mt-6 border-t border-border pt-6">
          <p className="text-meta font-medium uppercase tracking-wide text-accent">{t("detail.pathTitle")}</p>
          {related ? (
            <div className="mt-3 rounded-control border border-border bg-bg-base p-4">
              <p className="font-medium">{related.targetLabel}</p>
              <p className="mt-1 font-data text-meta text-text-muted">{formatTime(related.measuredAt, i18n.language)}</p>
              <div className="mt-3 grid grid-cols-2 gap-3 text-meta">
                <span>{t("detail.upload")} <strong className="font-data text-accent">{metric(related.upload, "Mbps")}</strong></span>
                <span>{t("detail.download")} <strong className="font-data text-accent">{metric(related.download, "Mbps")}</strong></span>
                <span>{t("detail.highestLatency")} <strong className="font-data">{metric(related.highestLatency, "ms")}</strong></span>
                <span>{t("detail.highestLoss")} <strong className="font-data">{metric(related.highestLoss, "%")}</strong></span>
              </div>
              <p className="mt-3 text-meta text-text-muted">
                {t("detail.pathNotice")}
              </p>
            </div>
          ) : (
            <p className="mt-3 text-text-secondary">{t("detail.noPath")}</p>
          )}
          <Link className="mt-4 inline-block text-accent underline" href={`/diagnostics?target=${encodeURIComponent(flow.dst_ip)}`}>
            {t("detail.openDiagnostics")}
          </Link>
        </div>
      </aside>
    </div>
  );
}

function latestMeasuredPath(data: DiagnosticsData, targetHost: string) {
  const bandwidth = data.bandwidth
    .filter((item) => item.target_host === targetHost)
    .sort((left, right) => Date.parse(right.measured_at) - Date.parse(left.measured_at));
  if (!bandwidth.length) return null;
  const latest = bandwidth[0];
  const sameRun = latest.job_id
    ? bandwidth.filter((item) => item.job_id === latest.job_id)
    : bandwidth.filter((item) => item.measured_at === latest.measured_at);
  const hops = data.hops.filter((item) =>
    latest.job_id ? item.job_id === latest.job_id : item.target_host === targetHost,
  );
  return {
    targetLabel: latest.target_label,
    measuredAt: latest.measured_at,
    upload: sameRun.find((item) => item.direction === "upload")?.bitrate_mbps ?? null,
    download: sameRun.find((item) => item.direction === "download")?.bitrate_mbps ?? null,
    highestLatency: maxNullable(hops.map((item) => item.avg_latency_ms)),
    highestLoss: hops.length ? Math.max(...hops.map((item) => item.loss_percent)) : null,
  };
}

function StatePill({ active, label }: { active: boolean; label: string }) {
  return <span className={`rounded-full border px-3 py-1 text-meta ${active ? "border-severity-low text-severity-low" : "border-severity-medium text-severity-medium"}`}>{label}</span>;
}

function StatusValue({ label, value, data = false }: { label: string; value: string; data?: boolean }) {
  return <div className="min-w-0 rounded-control border border-border bg-bg-base p-3"><dt className="text-meta text-text-secondary">{label}</dt><dd className={`mt-1 break-words ${data ? "font-data text-meta" : ""}`}>{value}</dd></div>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-control border border-border bg-bg-base p-3"><p className="text-meta text-text-secondary">{label}</p><p className="mt-2 break-words font-data text-section text-accent">{value}</p></div>;
}

function Select({ label, value, onChange, options, disabled = false }: { label: string; value: string; onChange: (value: string) => void; options: { value: string; label: string }[]; disabled?: boolean }) {
  return <label className="grid min-w-0 gap-2 text-meta text-text-secondary">{label}<select disabled={disabled} className="w-full min-w-0 rounded-control border border-border bg-bg-base px-3 py-2 text-body text-text-primary disabled:opacity-60" value={value} onChange={(event) => onChange(event.target.value)}>{options.map((option) => <option key={`${label}:${option.value}`} value={option.value}>{option.label}</option>)}</select></label>;
}

function Notice({ children, tone = "normal" }: { children: React.ReactNode; tone?: "normal" | "critical" }) {
  return <div className={`rounded-panel border bg-bg-surface p-4 ${tone === "critical" ? "border-severity-critical text-severity-critical" : "border-border text-text-secondary"}`}>{children}</div>;
}

function StorageNotice({ status, mb }: { status: string; mb: number }) {
  const { t } = useTranslation("traffic");
  if (status === "healthy") return null;
  return <Notice tone={status === "critical" ? "critical" : "normal"}>{t(status === "critical" ? "storage.critical" : "storage.warning", { mb: mb.toFixed(2) })}</Notice>;
}

function endpoint(ip: string, port: number | null) { return port === null ? ip : `${ip}:${port}`; }
function formatTime(value: string, language = "id") { return new Intl.DateTimeFormat(language === "en" ? "en-US" : "id-ID", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value)); }
function formatDuration(totalSeconds: number) { const minutes = Math.floor(totalSeconds / 60); const seconds = totalSeconds % 60; return `${minutes}:${String(seconds).padStart(2, "0")}`; }
function bytes(value: number, language = "id") { return new Intl.NumberFormat(language === "en" ? "en-US" : "id-ID", { style: "unit", unit: "byte", unitDisplay: "short" }).format(value); }
function formatNumber(value: number | null | undefined, language = "id") { return value == null ? "-" : new Intl.NumberFormat(language === "en" ? "en-US" : "id-ID", { maximumFractionDigits: 2 }).format(value); }
function metric(value: number | null | undefined, unit: string) { return value == null ? "-" : `${value.toFixed(2)} ${unit}`; }
function trendLabel(value: TrafficFlow["rate_trend"] | undefined, t: TFunction) { return t(value === "increasing" ? "trend.increasing" : value === "decreasing" ? "trend.decreasing" : "trend.stable"); }
function maxNullable(values: (number | null)[]) { const numbers = values.filter((value): value is number => value !== null); return numbers.length ? Math.max(...numbers) : null; }
