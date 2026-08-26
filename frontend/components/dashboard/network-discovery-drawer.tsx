"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { useDeviceProfile } from "@/components/device-profile/device-profile-provider";
import { useNetworkNodes } from "@/components/diagnostics/network-nodes-provider";
import { DISCOVERY_RUNNER_FRESHNESS_MS, isDiscoveryRunnerOnline, type DiscoveryHost, type DiscoveryRunner, type DiscoverySession } from "@/lib/network-discovery";
import { NETWORK_NODE_TYPES, findNetworkNode, networkNodeTypeLabel, type NetworkNode, type NetworkNodeInput, type NetworkNodeType } from "@/lib/network-nodes";
import type { NetworkHealthTarget } from "@/lib/network-health";
import { createClient } from "@/lib/supabase/client";
import type { TrafficSnapshot } from "@/lib/traffic";

export function NetworkDiscoveryDrawer({
  open,
  onClose,
  runners,
  initialSessions,
  targets,
  trafficIps,
}: {
  open: boolean;
  onClose: () => void;
  runners: DiscoveryRunner[];
  initialSessions: DiscoverySession[];
  targets: NetworkHealthTarget[];
  trafficIps: string[];
}) {
  const router = useRouter();
  const eligibleRunners = useMemo(() => runners.filter((runner) => runner.capabilities.operations?.includes("network_discovery")), [runners]);
  const [runnerId, setRunnerId] = useState(() => runners.find((runner) => runner.capabilities.operations?.includes("network_discovery"))?.id ?? "");
  const [sessions, setSessions] = useState(initialSessions);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editingIp, setEditingIp] = useState<string | null>(null);
  const [promotedNodes, setPromotedNodes] = useState<Set<string>>(new Set());
  const [recentTrafficIps, setRecentTrafficIps] = useState<Set<string>>(() => new Set(trafficIps));
  const [runnerHeartbeats, setRunnerHeartbeats] = useState<Record<string, DiscoveryRunner>>({});
  const [freshnessNow, setFreshnessNow] = useState(() => Date.now());
  const prepared = useRef<Set<string>>(new Set());
  const { nodes } = useNetworkNodes();
  const selectedRunner = eligibleRunners.find((item) => item.id === runnerId) ?? eligibleRunners[0];
  const realtimeRunner = selectedRunner ? runnerHeartbeats[selectedRunner.id] : undefined;
  const runner = selectedRunner && realtimeRunner
    && Date.parse(realtimeRunner.last_seen_at) > Date.parse(selectedRunner.last_seen_at)
    ? { ...selectedRunner, ...realtimeRunner }
    : selectedRunner;
  const session = sessions.find((item) => item.runner_id === runner?.id) ?? null;
  const runnerOnline = isDiscoveryRunnerOnline(runner, freshnessNow);

  const runnerLastSeenAt = runner?.last_seen_at;

  useEffect(() => {
    if (!open || !runnerLastSeenAt) return;
    const now = Date.now();
    const expiresAt = Date.parse(runnerLastSeenAt) + DISCOVERY_RUNNER_FRESHNESS_MS;
    const timer = window.setTimeout(
      () => setFreshnessNow(Date.now()),
      Math.max(0, expiresAt - now + 1),
    );
    return () => window.clearTimeout(timer);
  }, [open, runnerLastSeenAt]);

  useEffect(() => {
    if (!open || !runner?.id) return;
    const supabase = createClient();
    const channel = supabase.channel(`network-discovery:${runner.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "network_discovery_sessions", filter: `runner_id=eq.${runner.id}` }, (payload) => {
        const next = payload.new as DiscoverySession;
        if (!next.runner_id) return;
        setSessions((current) => [next, ...current.filter((item) => item.runner_id !== next.runner_id)]);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "traffic_live_snapshots", filter: `runner_id=eq.${runner.id}` }, (payload) => {
        const snapshot = payload.new as TrafficSnapshot;
        setRecentTrafficIps(new Set([
          ...snapshot.flows.flatMap((flow) => [flow.src_ip, flow.dst_ip]),
          ...snapshot.top_talkers.map((talker) => talker.ip),
        ]));
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "diagnostic_runners", filter: `id=eq.${runner.id}` }, (payload) => {
        const heartbeat = payload.new as DiscoveryRunner;
        if (heartbeat.id !== runner.id) return;
        setRunnerHeartbeats((current) => ({
          ...current,
          [heartbeat.id]: { ...current[heartbeat.id], ...heartbeat },
        }));
        setFreshnessNow(Date.now());
      }).subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [open, runner?.id]);

  useEffect(() => {
    if (!open || !runnerOnline || !runner || session || prepared.current.has(runner.id)) return;
    prepared.current.add(runner.id);
    void invoke("prepare_session", runner.id);
  // invoke is intentionally driven only by drawer/runner/session identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, runnerOnline, runner?.id, session?.session_id]);

  async function invoke(action: "prepare_session" | "start_session", targetRunnerId = runner?.id) {
    if (!targetRunnerId) return;
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const body = action === "prepare_session"
      ? { action, runner_id: targetRunnerId }
      : { action, runner_id: targetRunnerId, session_id: session?.session_id };
    const { data, error: invokeError } = await supabase.functions.invoke<{ data: DiscoverySession }>("network-discovery", { body });
    if (invokeError || !data?.data) {
      prepared.current.delete(targetRunnerId);
      setError(await functionError(invokeError));
    }
    else setSessions((current) => [data.data, ...current.filter((item) => item.runner_id !== data.data.runner_id)]);
    setBusy(false);
  }

  const expired = session?.status === "expired" || Boolean(session && Date.parse(session.expires_at) <= Date.now());
  const monitoredNodeIds = useMemo(() => new Set([
    ...targets.filter((target) => target.enabled && target.runner_id === runner?.id).map((target) => target.node.id),
    ...promotedNodes,
  ]), [promotedNodes, runner?.id, targets]);
  const enriched = (session?.results ?? []).map((host) => {
    const node = findNetworkNode(nodes, host.ip_address);
    return { host, node, monitored: Boolean(node && monitoredNodeIds.has(node.id)), seenInTraffic: recentTrafficIps.has(host.ip_address) };
  });
  const selectedRows = enriched.filter((row) => selected.has(row.host.ip_address));
  const invalidSelection = selectedRows.some((row) => !row.node || row.host.is_this_device);

  async function addToHealth(node: NetworkNode) {
    if (!runner) return;
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.from("network_targets").upsert({ runner_id: runner.id, node_id: node.id, enabled: true }, { onConflict: "runner_id,node_id" });
    if (error) setError("Target gagal ditambahkan ke Network Health Watch.");
    else {
      setPromotedNodes((current) => new Set([...current, node.id]));
      router.refresh();
    }
    setBusy(false);
  }

  async function addSelected() {
    if (!runner || !selectedRows.length || invalidSelection) return;
    setBusy(true);
    setError(null);
    const rows = selectedRows.map((row) => ({ runner_id: runner.id, node_id: row.node!.id, enabled: true }));
    const supabase = createClient();
    const { error } = await supabase.from("network_targets").upsert(rows, { onConflict: "runner_id,node_id" });
    if (error) setError("Sebagian target tidak dapat ditambahkan ke Network Health Watch.");
    else {
      setPromotedNodes((current) => new Set([...current, ...rows.map((row) => row.node_id)]));
      setSelected(new Set());
      router.refresh();
    }
    setBusy(false);
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-bg-base/75" role="dialog" aria-modal="true" aria-label="Network Discovery" onClick={onClose}>
      <aside className="h-full w-full max-w-5xl overflow-y-auto border-l border-border bg-bg-surface p-4 md:p-6" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <div><p className="text-meta font-medium uppercase tracking-wide text-accent">Network Discovery</p><h2 className="mt-2 text-heading font-semibold">Visible devices on the current subnet</h2><p className="mt-2 max-w-3xl text-text-secondary">This discovery runs once and does not automatically add devices to continuous monitoring.</p></div>
          <Button variant="secondary" onClick={onClose}>Tutup</Button>
        </div>

        {eligibleRunners.length > 1 ? <label className="mt-6 grid gap-2 text-meta text-text-secondary">Runner<select className="rounded-control border border-border bg-bg-base px-3 py-2 text-text-primary" value={runner?.id ?? ""} onChange={(event) => { setRunnerId(event.target.value); setSelected(new Set()); setError(null); }} disabled={busy}>{eligibleRunners.map((item) => <option key={item.id} value={item.id}>{item.display_name}</option>)}</select></label> : null}

        {!runnerOnline ? <Notice tone="critical">Local Runner is offline. Network discovery is unavailable.</Notice> : null}
        {runnerOnline && !session ? <Notice>No discovery session has been run yet. Detecting the current Windows network…</Notice> : null}
        {runnerOnline && session && !expired ? <Context session={session} runnerName={runner?.display_name ?? session.runner_id} /> : null}
        {expired ? <Notice>Discovery results expired. Run discovery again for current information.</Notice> : null}

        {runnerOnline && session?.status === "queued" && session.phase === "prepare" ? <Notice>Detecting and validating the runner&apos;s current local subnet…</Notice> : null}
        {runnerOnline && session?.status === "running" && session.phase === "prepare" ? <Notice>Reading current Windows network context…</Notice> : null}
        {runnerOnline && session?.status === "idle" ? <div className="mt-5"><Button disabled={busy} onClick={() => void invoke("start_session")}>{busy ? "Menyiapkan…" : "Start Discovery"}</Button></div> : null}
        {runnerOnline && expired ? <div className="mt-5"><Button disabled={busy} onClick={() => void invoke("prepare_session")}>Refresh current network</Button></div> : null}
        {runnerOnline && session?.status === "failed" ? <div className="mt-5"><Notice tone="critical">{discoveryError(session.error_code)}</Notice><Button className="mt-3" disabled={busy} onClick={() => void invoke("prepare_session")}>Try again</Button></div> : null}

        {session && ["queued", "running"].includes(session.status) && session.phase === "scan" ? (
          <Notice>Discovering devices on the current local subnet… <span className="font-data">{session.scanned_hosts}/{session.total_hosts}</span> checked, <span className="font-data">{session.found_count}</span> visible.</Notice>
        ) : null}

        {session && session.phase === "scan" && !expired && enriched.length ? (
          <section className="mt-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h3 className="text-section font-semibold">Discovered devices</h3><p className="mt-1 text-meta text-text-muted">Temporary results · deduplicated by IP · no ports or services scanned.</p></div><Button variant="secondary" disabled={busy || !selectedRows.length || invalidSelection} onClick={() => void addSelected()}>Add selected to monitoring</Button></div>
            {invalidSelection ? <p className="mt-3 text-meta text-severity-medium">Selected unknown devices must be named first. This Device is not promoted as a health target.</p> : null}
            <div className="mt-4 hidden overflow-x-auto rounded-control border border-border md:block">
              <table className="w-full min-w-[900px] text-left"><thead className="bg-bg-base text-meta text-text-secondary"><tr><th className="p-3">Select</th><th className="p-3">IP / identity</th><th className="p-3">Discovery</th><th className="p-3">Inventory</th><th className="p-3">Monitoring</th><th className="p-3">Actions</th></tr></thead><tbody>{enriched.map((row) => <DiscoveryRow key={row.host.ip_address} {...row} runnerId={runner?.id ?? ""} selected={selected.has(row.host.ip_address)} setSelected={setSelected} busy={busy} onName={setEditingIp} onMonitor={addToHealth} />)}</tbody></table>
            </div>
            <div className="mt-4 grid gap-3 md:hidden">{enriched.map((row) => <DiscoveryCard key={row.host.ip_address} {...row} runnerId={runner?.id ?? ""} selected={selected.has(row.host.ip_address)} setSelected={setSelected} busy={busy} onName={setEditingIp} onMonitor={addToHealth} />)}</div>
          </section>
        ) : null}
        {session?.status === "completed" && !expired && enriched.length === 0 ? <Notice>No responding devices were discovered.</Notice> : null}
        {session?.status === "completed" && !expired ? <Button className="mt-5" variant="secondary" disabled={busy} onClick={() => void invoke("start_session")}>Run discovery again</Button> : null}
        {error ? <p className="mt-4 text-severity-critical">{error}</p> : null}
        <div className="mt-6 rounded-control border border-border bg-bg-base p-4 text-meta text-text-secondary">Scope is determined and validated by the Windows runner. The browser cannot submit a CIDR, range, command, or scan flags. Only neighbor information and bounded ICMP host discovery are used.</div>
        {editingIp ? <NameEditor ipAddress={editingIp} current={findNetworkNode(nodes, editingIp) ?? null} onClose={() => setEditingIp(null)} /> : null}
      </aside>
    </div>
  );
}

function Context({ session, runnerName }: { session: DiscoverySession; runnerName: string }) {
  return <dl className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><Value label="Runner" value={runnerName} /><Value label="Connection" value={session.connection_type ? connectionLabel(session.connection_type) : "Detecting…"} /><Value label="Local IPv4" value={session.local_ipv4 ?? "Detecting…"} data /><Value label="Subnet" value={session.subnet_cidr ?? "Detecting…"} data /><Value label="Scope" value="Current local subnet" /></dl>;
}

type EnrichedRow = { host: DiscoveryHost; node: NetworkNode | undefined; monitored: boolean; seenInTraffic: boolean };
type RowActions = EnrichedRow & { runnerId: string; selected: boolean; setSelected: React.Dispatch<React.SetStateAction<Set<string>>>; busy: boolean; onName: (ip: string) => void; onMonitor: (node: NetworkNode) => Promise<void> };

function DiscoveryRow(props: RowActions) {
  const { host, node, monitored, seenInTraffic } = props;
  return <tr className="border-t border-border"><td className="p-3"><input aria-label={`Select ${host.ip_address}`} type="checkbox" disabled={monitored} checked={props.selected} onChange={() => toggleSelection(props.setSelected, host.ip_address)} /></td><td className="p-3"><p className="font-data">{host.ip_address}</p><p className="mt-1 font-medium">{node?.name ?? (host.is_gateway ? "Unknown node · Gateway" : host.is_this_device ? "This Device" : "Unknown node")}</p>{seenInTraffic ? <span className="mt-1 block text-meta text-accent">Seen in Traffic</span> : null}</td><td className="p-3"><DiscoveryEvidence host={host} /></td><td className="p-3">{node ? <Pill tone="known">KNOWN</Pill> : <Pill>DISCOVERED</Pill>}</td><td className="p-3">{monitored ? <Pill tone="monitored">MONITORED</Pill> : <span className="text-meta text-text-muted">NOT MONITORED</span>}</td><td className="p-3"><Actions {...props} /></td></tr>;
}

function DiscoveryCard(props: RowActions) {
  const { host, node, monitored, seenInTraffic } = props;
  return <article className="rounded-control border border-border bg-bg-base p-4"><div className="flex items-start justify-between gap-3"><div><p className="font-data">{host.ip_address}</p><p className="mt-1 font-medium">{node?.name ?? (host.is_this_device ? "This Device" : "Unknown node")}</p></div><input aria-label={`Select ${host.ip_address}`} type="checkbox" disabled={monitored} checked={props.selected} onChange={() => toggleSelection(props.setSelected, host.ip_address)} /></div><div className="mt-3 flex flex-wrap gap-2"><DiscoveryEvidence host={host} />{node ? <Pill tone="known">KNOWN</Pill> : <Pill>DISCOVERED</Pill>}{monitored ? <Pill tone="monitored">MONITORED</Pill> : <Pill>NOT MONITORED</Pill>}{seenInTraffic ? <Pill tone="known">SEEN IN TRAFFIC</Pill> : null}</div><div className="mt-4"><Actions {...props} /></div></article>;
}

function deriveObservedStatus(host: DiscoveryHost): "online" | "degraded" | "offline" | "unknown" {
  const reach = host.reachability_evidence;
  if (reach === "icmp_verified") return "online";
  if (reach === "l2_observed" || reach === "cached_only") return "unknown";
  // backward compat for legacy results without reachability_evidence
  if (host.evidence.includes("icmp")) return "online";
  return "unknown";
}
function Actions({ host, node, monitored, busy, onName, onMonitor, runnerId }: RowActions) {
  const { openDeviceProfile } = useDeviceProfile();
  const observedStatus = deriveObservedStatus(host);
  if (host.is_this_device) return <span className="text-meta text-text-muted">Runner device</span>;
  return <div className="flex flex-wrap gap-2">{!node ? <><Button disabled={busy} onClick={() => openDeviceProfile({ ipAddress: host.ip_address, runnerId, inspect: true, observedStatus })}>Inspect</Button><Button variant="secondary" disabled={busy} onClick={() => onName(host.ip_address)}>Beri nama</Button></> : <Button variant="secondary" disabled={busy} onClick={() => openDeviceProfile({ ipAddress: host.ip_address, runnerId, observedStatus })}>Detail</Button>}{node && !monitored ? <Button disabled={busy} onClick={() => void onMonitor(node)}>Add to Health Watch</Button> : null}</div>;
}

function NameEditor({ ipAddress, current, onClose }: { ipAddress: string; current: NetworkNode | null; onClose: () => void }) {
  const { saveNode } = useNetworkNodes();
  const [name, setName] = useState(current?.name ?? "");
  const [deviceType, setDeviceType] = useState<NetworkNodeType | "">(current?.device_type ?? "workstation");
  const [location, setLocation] = useState(current?.location ?? "");
  const [notes, setNotes] = useState(current?.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    const input: NetworkNodeInput = { ip_address: ipAddress, name, device_type: deviceType || null, location, notes };
    const saveError = await saveNode(current, input);
    setBusy(false);
    if (saveError) setError(saveError); else onClose();
  }
  return <div className="fixed inset-0 z-[60] grid place-items-center bg-bg-base/80 p-4" role="dialog" aria-modal="true" aria-label={`Identify ${ipAddress}`} onClick={onClose}><div className="w-full max-w-xl rounded-panel border border-border bg-bg-surface p-5" onClick={(event) => event.stopPropagation()}><div className="flex justify-between gap-3"><div><p className="text-meta uppercase tracking-wide text-accent">Network identity</p><h3 className="mt-2 text-section font-semibold">{current ? "Edit node" : "Beri nama"}</h3></div><Button variant="secondary" onClick={onClose}>Tutup</Button></div><div className="mt-5 grid gap-4 sm:grid-cols-2"><ReadOnly label="IP" value={ipAddress} /><Field label="Name" value={name} onChange={setName} /><label className="grid gap-2 text-meta text-text-secondary">Device type<select className="rounded-control border border-border bg-bg-base px-3 py-2 text-text-primary" value={deviceType} onChange={(event) => setDeviceType(event.target.value as NetworkNodeType | "")}><option value="">Unspecified</option>{NETWORK_NODE_TYPES.map((type) => <option key={type} value={type}>{networkNodeTypeLabel(type)}</option>)}</select></label><Field label="Location" value={location} onChange={setLocation} /><label className="grid gap-2 text-meta text-text-secondary sm:col-span-2">Notes<textarea className="min-h-24 rounded-control border border-border bg-bg-base px-3 py-2 text-text-primary" value={notes} onChange={(event) => setNotes(event.target.value)} /></label></div>{error ? <p className="mt-3 text-severity-critical">{error}</p> : null}<Button className="mt-5" disabled={busy || !name.trim()} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</Button><p className="mt-3 text-meta text-text-muted">Saving creates reusable inventory identity only. Continuous monitoring still requires an explicit Add to Health Watch action.</p></div></div>;
}

function DiscoveryEvidence({ host }: { host: DiscoveryHost }) {
  const reach = host.reachability_evidence;
  if (reach === "icmp_verified") {
    return <span className="text-meta text-text-secondary">Responded{host.latency_ms === null ? "" : ` · ${host.latency_ms.toFixed(1)} ms`}</span>;
  }
  if (reach === "l2_observed") {
    return <span className="text-meta text-text-secondary">Observed on LAN</span>;
  }
  if (reach === "cached_only") {
    return <span className="text-meta text-text-secondary">Cached · reachability unverified</span>;
  }
  // backward compat
  return <span className="text-meta text-text-secondary">{host.evidence.includes("icmp") ? `Responded${host.latency_ms === null ? "" : ` · ${host.latency_ms.toFixed(1)} ms`}` : "Neighbor cache"}</span>;
}
function Pill({ children, tone = "normal" }: { children: React.ReactNode; tone?: "normal" | "known" | "monitored" }) { return <span className={`inline-flex rounded-full border px-2 py-1 text-meta ${tone === "monitored" ? "border-severity-low text-severity-low" : tone === "known" ? "border-accent text-accent" : "border-border text-text-secondary"}`}>{children}</span>; }
function Value({ label, value, data = false }: { label: string; value: string; data?: boolean }) { return <div className="rounded-control border border-border bg-bg-base p-3"><dt className="text-meta text-text-secondary">{label}</dt><dd className={`mt-2 ${data ? "font-data" : ""}`}>{value}</dd></div>; }
function ReadOnly({ label, value }: { label: string; value: string }) { return <label className="grid gap-2 text-meta text-text-secondary">{label}<input readOnly className="rounded-control border border-border bg-bg-base px-3 py-2 font-data text-text-muted" value={value} /></label>; }
function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) { return <label className="grid gap-2 text-meta text-text-secondary">{label}<input className="rounded-control border border-border bg-bg-base px-3 py-2 text-text-primary" value={value} onChange={(event) => onChange(event.target.value)} /></label>; }
function Notice({ children, tone = "normal" }: { children: React.ReactNode; tone?: "normal" | "critical" }) { return <div className={`mt-5 rounded-control border bg-bg-base p-4 ${tone === "critical" ? "border-severity-critical text-severity-critical" : "border-border text-text-secondary"}`}>{children}</div>; }
function connectionLabel(value: DiscoverySession["connection_type"]) { return value === "wifi" ? "WiFi" : value === "ethernet" ? "Ethernet" : "Unknown"; }
function toggleSelection(setter: React.Dispatch<React.SetStateAction<Set<string>>>, ip: string) { setter((current) => { const next = new Set(current); if (next.has(ip)) next.delete(ip); else next.add(ip); return next; }); }
function discoveryError(code: string | null) { return code === "DISCOVERY_SCOPE_TOO_LARGE" ? "Detected subnet is larger than the safe /24 maximum. Discovery was not started." : code === "DISCOVERY_CONTEXT_UNAVAILABLE" ? "Windows network context could not be detected." : "Network discovery failed safely. No devices were promoted or monitored."; }
async function functionError(error: unknown) { if (error && typeof error === "object" && "context" in error) { const response = (error as { context?: unknown }).context; if (response instanceof Response) { try { const payload = await response.clone().json() as { error?: string }; if (payload.error) return payload.error; } catch {} } } return "Network discovery request failed."; }
