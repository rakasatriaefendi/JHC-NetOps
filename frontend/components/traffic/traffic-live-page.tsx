"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { useNetworkNodes } from "@/components/diagnostics/network-nodes-provider";
import { useDeviceProfile } from "@/components/device-profile/device-profile-provider";
import { findNetworkNode } from "@/lib/network-nodes";
import type { DiagnosticsData } from "@/lib/diagnostics";
import { createClient } from "@/lib/supabase/client";
import { canOperateNetwork } from "@/lib/authorization";
import {
  filterFlows,
  type TrafficFlow,
  type TrafficSnapshot,
  type TrafficState,
} from "@/lib/traffic";

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
  const online = Boolean(
    runner &&
      runner.health_status === "online" &&
      now - Date.parse(runner.last_seen_at) <= 30_000,
  );
  const elapsedSeconds = active?.started_at
    ? Math.max(0, Math.floor((now - Date.parse(active.started_at)) / 1000))
    : 0;

  useEffect(() => {
    let disposed = false;
    const supabase = createClient();

    async function refresh() {
      const { data, error } = await supabase.functions.invoke<{ data: TrafficState }>(
        "traffic-live",
        { method: "GET" },
      );
      if (!disposed && !error && data?.data) setState(data.data);
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
    const body =
      actionName === "create_session"
        ? { action: actionName, runner_id: runner.id, duration_seconds: duration }
        : { action: actionName, session_id: active?.id };
    const { data, error } = await supabase.functions.invoke<{ data: unknown }>(
      "traffic-live",
      { body },
    );
    if (error || !data?.data) setError(await functionError(error));
    const latest = await supabase.functions.invoke<{ data: TrafficState }>("traffic-live", {
      method: "GET",
    });
    if (latest.data?.data) setState(latest.data.data);
    setBusy(false);
  }

  return (
    <div className="grid min-w-0 gap-6">
      {loadError ? (
        <Notice tone="critical">
          Traffic state gagal dimuat. Pastikan migration dan Edge Function sudah dideploy.
        </Notice>
      ) : null}

      <section className="min-w-0 rounded-panel border border-border bg-bg-surface p-4 md:p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-meta font-medium uppercase tracking-wide text-accent">
              Traffic capture
            </p>
            <h2 className="mt-2 text-section font-semibold">Capture scope: This Device</h2>
            <p className="mt-2 max-w-3xl text-text-secondary">
              Hanya traffic yang terlihat oleh interface perangkat runner ini. Ini bukan
              seluruh LAN dan bukan pengukuran available bandwidth.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 md:justify-end">
            <StatePill active={online} label={online ? "RUNNER ONLINE" : "RUNNER OFFLINE"} />
            <StatePill
              active={Boolean(active && active.status !== "stopping")}
              label={active ? (active.status === "stopping" ? "STOPPING" : "CAPTURE LIVE") : "CAPTURE STOPPED"}
            />
          </div>
        </div>

        <dl className="mt-5 grid gap-3 sm:grid-cols-3">
          <StatusValue label="Runner" value={runner?.display_name ?? "Tidak tersedia"} />
          <StatusValue label="Started" value={active?.started_at ? formatTime(active.started_at) : "-"} data />
          <StatusValue label="Elapsed" value={active?.started_at ? formatDuration(elapsedSeconds) : "-"} data />
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
            label="Batas waktu capture"
            value={String(duration)}
            onChange={(value) => setDuration(Number(value))}
            disabled={Boolean(active)}
            options={durations.map((value) => ({
              value: String(value),
              label: `${value / 60} menit`,
            }))}
          />
        </div>
        <p className="mt-3 text-meta text-text-muted">
          Capture otomatis berhenti maksimal 30 menit. Browser tidak dapat mengirim shell
          command atau packet filter.
        </p>

        {canOperateNetwork(state.role) ? (
          <div className="mt-5 flex min-w-0 gap-3">
            {active ? (
              <Button
                variant="destructive"
                disabled={busy || active.status === "stopping"}
                onClick={() => void runAction("stop_session")}
              >
                {active.status === "stopping" ? "Menghentikan…" : "Stop capture"}
              </Button>
            ) : (
              <Button
                className="w-full sm:w-auto"
                data-testid="start-traffic-capture"
                disabled={busy || !online || state.storage_status.status === "critical"}
                onClick={() => void runAction("create_session")}
              >
                {busy ? "Menyiapkan…" : "Start capture"}
              </Button>
            )}
          </div>
        ) : (
          <p className="mt-5 text-text-secondary">
            Viewer bersifat read-only. Role Operator diperlukan untuk start/stop capture.
          </p>
        )}
        {error ? <p className="mt-4 text-severity-critical">{error}</p> : null}
      </section>

      <StorageNotice status={state.storage_status.status} mb={Number(state.storage_status.storage_mb)} />

      <section className="min-w-0 rounded-panel border border-border bg-bg-surface p-4 md:p-6">
        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-meta font-medium uppercase tracking-wide text-accent">
              Live observed traffic
            </p>
            <h2 className="mt-2 text-section font-semibold">Flow activity</h2>
          </div>
          <div className="text-meta text-text-muted md:text-right">
            <p>{realtime ? "● Realtime tersambung" : "○ Reconnecting · fallback polling"}</p>
            <p className="mt-1 font-data">
              {snapshot ? formatTime(snapshot.captured_at) : "Belum ada snapshot"}
            </p>
          </div>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <Metric label="Observed RX" value={metric(snapshot?.summary.observed_rx_mbps, "Mbps")} />
          <Metric label="Observed TX" value={metric(snapshot?.summary.observed_tx_mbps, "Mbps")} />
          <Metric label="Packets/sec" value={formatNumber(snapshot?.summary.packets_per_second)} />
          <Metric label="Active flows" value={formatNumber(snapshot?.summary.active_flows)} />
          <Metric label="Top talker" value={snapshot?.top_talkers[0]?.ip ?? "-"} />
          <Metric label="Dominant protocol" value={snapshot?.summary.dominant_protocol?.toUpperCase() ?? "-"} />
        </div>
        <p className="mt-3 text-meta text-text-muted">
          RX/TX adalah observed traffic rate selama interval snapshot, bukan kapasitas atau
          available bandwidth link.
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
              {value === "flows" ? "Live Flows" : value === "conversations" ? "Conversations" : "Top Talkers"}
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
          IP atau port
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="rounded-control border border-border bg-bg-base px-3 py-2 text-text-primary"
            placeholder="10.0.0.1 atau 443"
          />
        </label>
        <Select
          label="Protocol"
          value={protocol}
          onChange={setProtocol}
          options={["all", "tcp", "udp", "icmp"].map((value) => ({
            value,
            label: value.toUpperCase(),
          }))}
        />
        <Select
          label="Status"
          value={status}
          onChange={setStatus}
          options={[
            { value: "all", label: "All" },
            { value: "active", label: "Active ≤ 5s" },
            { value: "idle", label: "Recently idle 5–30s" },
          ]}
        />
      </div>

      <div className="mt-4 hidden max-w-full overflow-x-auto md:block">
        <table className="w-full min-w-[1100px] border-collapse text-left">
          <thead>
            <tr className="border-y border-border text-meta text-text-secondary">
              {["Last seen", "Source", "Destination", "Protocol / service", "Observed rate", "Transferred", "Packets", "Status", ""].map((heading) => (
                <th className="px-3 py-3 font-medium" key={heading}>{heading}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {flows.map((flow) => (
              <tr className="border-b border-border" key={flow.flow_key}>
                <td className="px-3 py-3 font-data text-meta">{formatTime(flow.last_seen)}</td>
                <td className="px-3 py-3">{endpointCell(flow.src_ip, flow.src_port)}</td>
                <td className="px-3 py-3">{endpointCell(flow.dst_ip, flow.dst_port)}</td>
                <td className="px-3 py-3">
                  {flow.protocol.toUpperCase()}
                  <span className="block text-meta text-text-muted">{flow.service ?? "Unknown"}</span>
                </td>
                <td className="px-3 py-3 font-data text-accent">
                  {(flow.rate_mbps ?? 0).toFixed(3)} Mbps
                  <span className="block text-meta text-text-muted">{trendLabel(flow.rate_trend)}</span>
                </td>
                <td className="px-3 py-3 font-data">{bytes(flow.total_bytes)}</td>
                <td className="px-3 py-3 font-data">{formatNumber(flow.packet_count)}</td>
                <td className="px-3 py-3">{flow.status}</td>
                <td className="px-3 py-3">
                  <button className="text-accent underline" onClick={() => onDetail(flow)}>Detail</button>
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
              {flow.protocol.toUpperCase()} · {(flow.rate_mbps ?? 0).toFixed(3)} Mbps · {bytes(flow.total_bytes)}
            </p>
            <p className="mt-1 font-data text-meta text-text-muted">{formatTime(flow.last_seen)} · {flow.status}</p>
          </button>
        ))}
      </div>
      {flows.length === 0 ? <p className="mt-5 text-text-secondary">Belum ada flow yang cocok.</p> : null}
    </div>
  );
}

function Conversations({ snapshot }: { snapshot?: TrafficSnapshot }) {
  return (
    <div className="mt-5 grid gap-3">
      {snapshot?.conversations.map((conversation) => (
        <article className="rounded-control border border-border bg-bg-base p-4" key={`${conversation.endpoint_a}-${conversation.endpoint_b}`}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="font-data">{conversation.endpoint_a} ↔ {conversation.endpoint_b}</p>
              <p className="mt-2 text-meta text-text-secondary">
                {(conversation.protocol ?? "unknown").toUpperCase()} · {conversation.service ?? "Unknown"} · {conversation.active_flows ?? 0} active flows
              </p>
            </div>
            <p className="font-data text-accent">{(conversation.rate_mbps ?? 0).toFixed(3)} Mbps</p>
          </div>
          <p className="mt-3 text-meta text-text-muted">
            A→B {bytes(conversation.a_to_b_bytes)} · B→A {bytes(conversation.b_to_a_bytes)} · total {bytes(conversation.total_bytes)}
          </p>
          <p className="mt-1 font-data text-meta text-text-muted">
            {formatTime(conversation.first_seen)} – {formatTime(conversation.last_seen)}
          </p>
        </article>
      ))}
      {!snapshot?.conversations.length ? <p className="text-text-secondary">Belum ada conversation.</p> : null}
    </div>
  );
}

function Talkers({ snapshot }: { snapshot?: TrafficSnapshot }) {
  const { nodes } = useNetworkNodes();
  const { openDeviceProfile } = useDeviceProfile();
  return (
    <div className="mt-5 grid gap-3">
      {snapshot?.top_talkers.map((talker, index) => (
        <article className="flex items-center justify-between rounded-control border border-border bg-bg-base p-4" key={talker.ip}>
          <p>
            <span className="mr-3 font-data text-text-muted">#{index + 1}</span>
            {findNetworkNode(nodes, talker.ip) ? <button className="text-accent hover:underline" onClick={() => openDeviceProfile({ ipAddress: talker.ip })}><span className="font-medium">{findNetworkNode(nodes, talker.ip)?.name}</span><span className="ml-2 font-data text-meta">{talker.ip}</span></button> : <span className="font-data">{talker.ip}</span>}
            <span className="ml-3 text-meta text-text-muted">{talker.active_flows ?? 0} active flows</span>
          </p>
          <p className="font-data text-accent">{(talker.rate_mbps ?? 0).toFixed(3)} Mbps</p>
        </article>
      ))}
      {!snapshot?.top_talkers.length ? <p className="text-text-secondary">Belum ada top talker.</p> : null}
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
  const related = latestMeasuredPath(diagnostics, flow.dst_ip);
  const durationSeconds = Math.max(0, Math.floor((Date.parse(flow.last_seen) - Date.parse(flow.first_seen)) / 1000));
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-bg-base/80" role="dialog" aria-modal="true">
      <aside className="h-full w-full max-w-lg overflow-y-auto border-l border-border bg-bg-surface p-6">
        <div className="flex justify-between">
          <h2 className="text-section font-semibold">Flow detail</h2>
          <button onClick={close} aria-label="Tutup" className="text-text-secondary">×</button>
        </div>
        <dl className="mt-6 grid gap-4">
          {[
            ["Source", endpoint(flow.src_ip, flow.src_port)],
            ["Destination", endpoint(flow.dst_ip, flow.dst_port)],
            ["Protocol", flow.protocol.toUpperCase()],
            ["Service", flow.service ?? "Unknown / tidak diinferensikan"],
            ["Current observed rate", `${(flow.rate_mbps ?? 0).toFixed(3)} Mbps (${trendLabel(flow.rate_trend)})`],
            ["Peak observed rate", `${(flow.peak_rate_mbps ?? 0).toFixed(3)} Mbps`],
            ["Packets/sec", formatNumber(flow.packets_per_second)],
            ["Packets", formatNumber(flow.packet_count)],
            ["Transferred", bytes(flow.total_bytes)],
            ["First seen", formatTime(flow.first_seen)],
            ["Last seen", formatTime(flow.last_seen)],
            ["Duration", formatDuration(durationSeconds)],
            ["Status", flow.status],
          ].map(([key, value]) => (
            <div className="rounded-control border border-border bg-bg-base p-3" key={key}>
              <dt className="text-meta text-text-secondary">{key}</dt>
              <dd className="mt-1 break-all font-data">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-5 text-meta text-text-muted">
          Service adalah inferensi port bila berlabel “inferred”; payload, content, dan PCAP tidak disimpan.
        </p>

        <div className="mt-6 border-t border-border pt-6">
          <p className="text-meta font-medium uppercase tracking-wide text-accent">Latest measured path</p>
          {related ? (
            <div className="mt-3 rounded-control border border-border bg-bg-base p-4">
              <p className="font-medium">{related.targetLabel}</p>
              <p className="mt-1 font-data text-meta text-text-muted">{formatTime(related.measuredAt)}</p>
              <div className="mt-3 grid grid-cols-2 gap-3 text-meta">
                <span>Upload <strong className="font-data text-accent">{metric(related.upload, "Mbps")}</strong></span>
                <span>Download <strong className="font-data text-accent">{metric(related.download, "Mbps")}</strong></span>
                <span>Highest latency <strong className="font-data">{metric(related.highestLatency, "ms")}</strong></span>
                <span>Highest loss <strong className="font-data">{metric(related.highestLoss, "%")}</strong></span>
              </div>
              <p className="mt-3 text-meta text-text-muted">
                Ini measurement terpisah menuju target, bukan bukti bahwa flow ini melewati setiap hop MTR tersebut.
              </p>
            </div>
          ) : (
            <p className="mt-3 text-text-secondary">No recent path diagnostic untuk destination ini.</p>
          )}
          <Link className="mt-4 inline-block text-accent underline" href={`/diagnostics?target=${encodeURIComponent(flow.dst_ip)}`}>
            Open LAN Diagnostics
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
  if (status === "healthy") return null;
  return <Notice tone={status === "critical" ? "critical" : "normal"}>Storage flow {mb.toFixed(2)} MB — {status === "critical" ? "persistence dan capture baru dibatasi pada ambang 400 MB." : "mendekati ambang 300 MB; retention 48 jam tetap aktif."}</Notice>;
}

function endpoint(ip: string, port: number | null) { return port === null ? ip : `${ip}:${port}`; }
function formatTime(value: string) { return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value)); }
function formatDuration(totalSeconds: number) { const minutes = Math.floor(totalSeconds / 60); const seconds = totalSeconds % 60; return `${minutes}:${String(seconds).padStart(2, "0")}`; }
function bytes(value: number) { return new Intl.NumberFormat("id-ID", { style: "unit", unit: "byte", unitDisplay: "short" }).format(value); }
function formatNumber(value: number | null | undefined) { return value == null ? "-" : new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 }).format(value); }
function metric(value: number | null | undefined, unit: string) { return value == null ? "-" : `${value.toFixed(2)} ${unit}`; }
function trendLabel(value: TrafficFlow["rate_trend"] | undefined) { return value === "increasing" ? "↑ increasing" : value === "decreasing" ? "↓ decreasing" : "→ stable"; }
function maxNullable(values: (number | null)[]) { const numbers = values.filter((value): value is number => value !== null); return numbers.length ? Math.max(...numbers) : null; }

async function functionError(error: unknown) {
  if (error && typeof error === "object" && "context" in error) {
    const response = (error as { context?: unknown }).context;
    if (response instanceof Response) {
      try {
        const payload = (await response.clone().json()) as { error?: string };
        if (payload.error) return payload.error;
      } catch {}
    }
  }
  return "Traffic request gagal. Pastikan runner online dan backend sudah dideploy.";
}
