"use client";

import Link from "next/link";
import { createContext, useContext, useEffect, useMemo, useState } from "react";

import { useNetworkNodes } from "@/components/diagnostics/network-nodes-provider";
import { Button } from "@/components/ui/button";
import {
  canLaunchActiveInspection,
  confidenceLabel,
  detectedLabel,
  inspectionErrorDetails,
  operatorIdentityConflict,
  shouldOfferHealthPromotion,
  type DeviceFingerprint,
  type DeviceInspectionSession,
  type InspectorRunner,
} from "@/lib/device-inspector";
import {
  NETWORK_NODE_TYPES,
  findNetworkNode,
  networkNodeTypeLabel,
  type NetworkNodeInput,
  type NetworkNodeType,
} from "@/lib/network-nodes";
import { createClient } from "@/lib/supabase/client";

type OpenOptions = {
  ipAddress: string;
  runnerId?: string;
  inspect?: boolean;
  observedStatus?: "online" | "degraded" | "offline" | "unknown";
};
type DeviceProfileContextValue = { openDeviceProfile: (options: OpenOptions) => void };
const DeviceProfileContext = createContext<DeviceProfileContextValue | null>(null);

export function DeviceProfileProvider({ children, role, runners = [] }: {
  children: React.ReactNode;
  role: "admin" | "viewer";
  runners?: InspectorRunner[];
}) {
  const { nodes, saveNode, saveFingerprint } = useNetworkNodes();
  const [opened, setOpened] = useState<OpenOptions | null>(null);
  const [session, setSession] = useState<DeviceInspectionSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [monitored, setMonitored] = useState<boolean | null>(null);
  const node = opened ? findNetworkNode(nodes, opened.ipAddress) ?? null : null;
  const fingerprint = session?.status === "completed" && session.result ? session.result : node?.detected_fingerprint ?? null;
  const runner = useMemo(() => runners.find((item) => item.id === opened?.runnerId)
    ?? runners.find((item) => item.capabilities.operations?.includes("device_inspect")), [opened?.runnerId, runners]);

  useEffect(() => {
    if (!opened || !runner) return;
    const supabase = createClient();
    const channel = supabase.channel(`device-inspector:${runner.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "device_inspection_sessions", filter: `runner_id=eq.${runner.id}` }, (payload) => {
        const next = payload.new as DeviceInspectionSession;
        if (next.target_ip === opened.ipAddress) setSession(next);
      }).subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [opened, runner]);

  useEffect(() => {
    let cancelled = false;
    if (!opened || !node || !runner) return;
    const supabase = createClient();
    void supabase.from("network_targets").select("id").eq("runner_id", runner.id)
      .eq("node_id", node.id).eq("enabled", true).limit(1).maybeSingle()
      .then(({ data }) => { if (!cancelled) setMonitored(Boolean(data)); });
    return () => { cancelled = true; };
  }, [opened, node, runner]);

  function openDeviceProfile(options: OpenOptions) {
    setOpened(options);
    setSession(null);
    setError(null);
    setMonitored(null);
    if (options.inspect) queueMicrotask(() => void startInspection(options));
  }

  async function startInspection(options = opened) {
    const selectedRunner = runners.find((item) => item.id === options?.runnerId)
      ?? runners.find((item) => item.capabilities.operations?.includes("device_inspect"));
    if (!options || !canLaunchActiveInspection(role)) return setError("Hanya admin yang boleh menjalankan active inspection.");
    if (!selectedRunner) return setError("Tidak ada runner yang mengizinkan Device Inspector.");
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { data, error: invokeError } = await supabase.functions.invoke<{ data: DeviceInspectionSession }>("device-inspector", {
      body: { action: "start_inspection", runner_id: selectedRunner.id, target_ip: options.ipAddress },
    });
    if (invokeError || !data?.data) setError(await functionError(invokeError));
    else setSession(data.data);
    setBusy(false);
  }

  return <DeviceProfileContext.Provider value={{ openDeviceProfile }}>
    {children}
    {opened ? <DeviceProfileDrawer key={opened.ipAddress}
      opened={opened} node={node} fingerprint={fingerprint} session={session}
      canManage={canLaunchActiveInspection(role)} runnerId={runner?.id ?? null} monitored={monitored} busy={busy} error={error}
      close={() => setOpened(null)} inspect={() => void startInspection()}
      saveIdentity={async (input) => {
        setBusy(true); setError(null);
        const saveError = await saveNode(node, input, fingerprint);
        setBusy(false); if (saveError) setError(saveError);
      }}
      saveDetected={node && fingerprint ? async () => {
        setBusy(true); const saveError = await saveFingerprint(node, fingerprint);
        setBusy(false); if (saveError) setError(saveError);
      } : null}
      addToHealth={shouldOfferHealthPromotion(monitored, node?.id, runner?.id) ? async () => {
        setBusy(true); setError(null);
        const supabase = createClient();
        const { error: healthError } = await supabase.from("network_targets").upsert({ runner_id: runner!.id, node_id: node!.id, enabled: true }, { onConflict: "runner_id,node_id" });
        setBusy(false);
        if (healthError) setError("Target gagal ditambahkan ke Network Health Watch.");
        else setMonitored(true);
      } : null}
      setError={setError}
    /> : null}
  </DeviceProfileContext.Provider>;
}

export function useDeviceProfile() {
  const value = useContext(DeviceProfileContext);
  if (!value) throw new Error("useDeviceProfile must be used inside DeviceProfileProvider");
  return value;
}

function DeviceProfileDrawer({ opened, node, fingerprint, session, canManage, runnerId, monitored, busy, error, close, inspect, saveIdentity, saveDetected, addToHealth, setError }: {
  opened: OpenOptions;
  node: ReturnType<typeof findNetworkNode> | null;
  fingerprint: DeviceFingerprint | null;
  session: DeviceInspectionSession | null;
  canManage: boolean;
  runnerId: string | null;
  monitored: boolean | null;
  busy: boolean;
  error: string | null;
  close: () => void;
  inspect: () => void;
  saveIdentity: (input: NetworkNodeInput) => Promise<void>;
  saveDetected: (() => Promise<void>) | null;
  addToHealth: (() => Promise<void>) | null;
  setError: (value: string | null) => void;
}) {
  const [name, setName] = useState(node?.name ?? "");
  const [location, setLocation] = useState(node?.location ?? "");
  const [notes, setNotes] = useState(node?.notes ?? "");
  const suggested = fingerprint && NETWORK_NODE_TYPES.includes(fingerprint.likely_device_type as NetworkNodeType)
    ? fingerprint.likely_device_type as NetworkNodeType : null;
  const [type, setType] = useState<NetworkNodeType | "">(node?.device_type ?? suggested ?? "");
  const active = busy || Boolean(session && ["queued", "running"].includes(session.status));
  const insufficient = fingerprint ? detectedLabel(fingerprint) === "Insufficient evidence" : false;
  const missingIdentity = fingerprint ? [
    !fingerprint.detected_identity.manufacturer ? "manufacturer" : null,
    !fingerprint.detected_identity.model ? "model" : null,
    !fingerprint.detected_identity.os_family ? "OS family" : null,
  ].filter((value): value is string => Boolean(value)) : [];
  const identityConflict = operatorIdentityConflict(node?.device_type, fingerprint);

  return <div className="fixed inset-0 z-[70] flex justify-end bg-bg-base/80" role="dialog" aria-modal="true" aria-label={`Device Profile ${opened.ipAddress}`} onClick={close}>
    <aside className="h-full w-full max-w-2xl overflow-y-auto border-l border-border bg-bg-surface p-4 md:p-6" onClick={(event) => event.stopPropagation()}>
      <div className="flex items-start justify-between gap-4"><div><p className="text-meta font-medium uppercase tracking-wide text-accent">Device Profile</p><h2 className="mt-2 text-heading font-semibold">{node?.name || opened.ipAddress}</h2><p className="mt-1 font-data text-text-secondary">{opened.ipAddress}</p></div><Button variant="secondary" onClick={close}>Tutup</Button></div>
      {opened.observedStatus ? <p className="mt-4 text-meta uppercase tracking-wide text-text-secondary">Observed status: {opened.observedStatus}</p> : null}
      {active ? <Progress stage={session?.stage ?? "validating_target"} /> : null}
      {session?.status === "failed" ? <InspectionFailure code={session.error_code} /> : null}
      {error ? <Notice critical>{error}</Notice> : null}
      {fingerprint?.probe_summary.partial && !insufficient ? <Notice><p className="font-medium text-text-primary">Inspection completed — partial evidence.</p><p className="mt-2">{fingerprint.probe_summary.deadline_reached ? "The internal safety deadline stopped optional probes." : "One or more optional enrichment probes did not complete."} Evidence already collected remains valid; missing fields were not inferred.</p></Notice> : null}
      {insufficient ? <Notice><p className="font-medium text-text-primary">Inspection completed — insufficient identity evidence.</p><p className="mt-2">The target responded, but the bounded probes did not expose enough metadata to name a manufacturer, model, or exact device type. This is a successful partial result, not an inspection failure.</p></Notice> : null}

      <Section title="Likely identity">
        <dl className="grid gap-3 sm:grid-cols-2"><Value label="Detected" value={fingerprint ? detectedLabel(fingerprint) : "Belum ada hasil inspeksi"} /><Value label="Device type" value={fingerprint?.likely_device_type ? networkNodeTypeLabelSafe(fingerprint.likely_device_type) : "Belum diinspeksi"} /><Value label="Confidence" value={fingerprint ? confidenceLabel(fingerprint.confidence) : "BELUM DIINSPEKSI"} /><Value label="Capabilities" value={fingerprint ? fingerprint.capabilities.map(capabilityLabel).join(", ") || "Tidak terdeteksi" : "Belum diinspeksi"} /></dl>
      </Section>
      <Section title="Network identity">
        <dl className="grid gap-3 sm:grid-cols-2"><Value label="IP" value={opened.ipAddress} data /><Value label="MAC" value={fingerprint?.network_identity.mac ?? (fingerprint?.same_subnet === false ? "Unavailable for routed target" : "Unavailable")} data /><Value label="MAC vendor" value={fingerprint?.network_identity.mac_kind === "locally_administered" ? "Randomized / locally administered MAC" : fingerprint?.network_identity.mac_vendor ?? "Unavailable"} /><Value label="Network relation" value={fingerprint?.network_context?.is_this_device ? "This Device" : fingerprint?.route_role?.replaceAll("_", " ") ?? "Unknown"} /><Value label="Source interface" value={fingerprint?.network_context?.interface_alias ?? "Not observed"} /><Value label="Source adapter" value={fingerprint?.network_context?.interface_description ?? "Not observed"} /><Value label="Interface type" value={fingerprint?.network_context?.interface_type ?? "Not observed"} /><Value label="TLS identity" value={fingerprint?.network_identity.tls_identity ?? "Not observed"} /></dl>
      </Section>
      <Section title="Detected identity">
        <dl className="grid gap-3 sm:grid-cols-2"><Value label="Manufacturer" value={fingerprint?.detected_identity.manufacturer ?? "Tidak terdeteksi"} /><Value label="Model" value={fingerprint?.detected_identity.model ?? "Tidak terdeteksi"} /><Value label="Model number" value={fingerprint?.detected_identity.model_number ?? "Tidak terdeteksi"} /><Value label="OS family" value={fingerprint?.detected_identity.os_family ?? "Tidak terdeteksi"} /></dl>
      </Section>
      <Section title="Observed services">
        {fingerprint?.observed_services.length ? <ul className="grid gap-2 sm:grid-cols-2">{fingerprint.observed_services.map((service) => <li key={`${service.protocol}-${service.port}`} className="rounded-control border border-border bg-bg-base p-3"><span>{service.name}</span> <span className="font-data text-text-secondary">{service.protocol.toUpperCase()}/{service.port}</span></li>)}</ul> : <p className="text-text-secondary">No identifying service metadata observed in the bounded allow-list.</p>}
        {fingerprint?.probe_summary.tcp_states?.length ? <details className="mt-3 rounded-control border border-border bg-bg-base p-3 text-meta"><summary className="cursor-pointer text-text-secondary">Checked TCP port states</summary><ul className="mt-3 grid gap-2 sm:grid-cols-2">{fingerprint.probe_summary.tcp_states.map((service) => <li key={`state-${service.port}`} className="flex justify-between gap-3"><span>{service.name} <span className="font-data text-text-muted">TCP/{service.port}</span></span><span className="font-data uppercase text-text-secondary">{service.state}</span></li>)}</ul><p className="mt-3 text-text-muted">Timeout is reported as timeout, not guessed to be firewall-filtered. Ports outside the allow-list were not tested.</p></details> : null}
      </Section>
      <Section title="Observed software">
        {fingerprint?.observed_software.length ? <ul className="flex flex-wrap gap-2">{fingerprint.observed_software.map((software) => <li key={software} className="rounded-control border border-border bg-bg-base px-3 py-2 font-data">{software}</li>)}</ul> : <p className="text-text-secondary">No software identity was exposed by the selected HTTP endpoints.</p>}
      </Section>
      <Section title="Why this result?">
        {fingerprint?.evidence.length ? <ul className="grid gap-2">{fingerprint.evidence.map((item, index) => <li key={`${item.source}-${index}`} className="rounded-control border border-border bg-bg-base p-3"><p className="text-meta text-text-muted">{item.label}</p><p className="mt-1">{item.value}</p></li>)}</ul> : <p className="text-text-secondary">Host may still be useful as manual inventory even when no identity metadata is returned.</p>}
        {missingIdentity.length ? <p className="mt-3 text-meta text-text-muted">Not exposed by this inspection: {missingIdentity.join(", ")}. Absence is not evidence that those attributes do not exist.</p> : null}
      </Section>

      <Section title="Operator identity">
        {identityConflict ? <Notice critical><p className="font-medium">Saved operator category may not match the detected network role.</p><p className="mt-2">Inspection identified this address as This Device. The saved category remains unchanged; review and edit it explicitly if needed.</p></Notice> : null}
        {canManage ? <div className="grid gap-3 sm:grid-cols-2"><Field label="Name" value={name} setValue={setName} /><Field label="Location" value={location} setValue={setLocation} /><label className="grid gap-2 text-meta text-text-secondary">Device category<select className="rounded-control border border-border bg-bg-base px-3 py-2 text-text-primary" value={type} onChange={(event) => setType(event.target.value as NetworkNodeType | "")}><option value="">Unspecified</option>{NETWORK_NODE_TYPES.map((item) => <option key={item} value={item}>{networkNodeTypeLabel(item)}</option>)}</select></label><label className="grid gap-2 text-meta text-text-secondary sm:col-span-2">Notes<textarea className="min-h-24 rounded-control border border-border bg-bg-base px-3 py-2 text-text-primary" value={notes} onChange={(event) => setNotes(event.target.value)} /></label><Button disabled={busy || !name.trim()} onClick={() => void saveIdentity({ ip_address: opened.ipAddress, name, location, notes, device_type: type || null })}>Save identity</Button>{saveDetected ? <Button variant="secondary" disabled={busy} onClick={() => void saveDetected()}>Save detected evidence</Button> : null}</div> : <dl className="grid gap-3 sm:grid-cols-2"><Value label="Name" value={node?.name ?? "Not saved"} /><Value label="Location" value={node?.location ?? "Not saved"} /><Value label="Category" value={node?.device_type ? networkNodeTypeLabel(node.device_type) : "Not saved"} /><Value label="Notes" value={node?.notes ?? "Not saved"} /></dl>}
      </Section>

      <Section title="Actions"><div className="flex flex-wrap gap-2">{canManage ? <Button disabled={busy || !runnerId || Boolean(active)} onClick={() => { setError(null); inspect(); }}>{fingerprint ? "Inspect again" : "Inspect"}</Button> : null}{canManage && addToHealth ? <Button variant="secondary" disabled={busy} onClick={() => void addToHealth()}>Add to Health Watch</Button> : null}{monitored ? <Link className="rounded-control border border-border px-4 py-2" href="/dashboard">View Health Status</Link> : null}<Link className="rounded-control border border-border px-4 py-2" href="/diagnostics">Open LAN Diagnostics</Link><Link className="rounded-control border border-border px-4 py-2" href={`/traffic?ip=${encodeURIComponent(opened.ipAddress)}`}>View Traffic</Link></div></Section>
      <div className="mt-6 rounded-control border border-border bg-bg-base p-4 text-meta text-text-secondary">Quick Inspect uses a fixed, bounded service allow-list. It is not a vulnerability scan. Routed targets do not expose their target MAC through local ARP; unmanaged Layer-2 switches may have no discoverable IP; MTR shows responding Layer-3 hops only.</div>
    </aside>
  </div>;
}

function Progress({ stage }: { stage: DeviceInspectionSession["stage"] }) {
  const stages: DeviceInspectionSession["stage"][] = ["validating_target", "network_role", "identity", "services", "normalizing", "complete"];
  const active = stages.indexOf(stage);
  return <section className="mt-6 rounded-control border border-accent bg-bg-base p-4"><p className="font-medium">Inspecting device…</p><ul className="mt-3 grid gap-2 sm:grid-cols-2">{stages.slice(0, -1).map((item, index) => <li key={item} className={index <= active ? "text-accent" : "text-text-muted"}>{index < active ? "✓" : index === active ? "●" : "○"} {stageLabel(item)}</li>)}</ul></section>;
}
function Section({ title, children }: { title: string; children: React.ReactNode }) { return <section className="mt-6 border-t border-border pt-5"><h3 className="text-section font-semibold">{title}</h3><div className="mt-3">{children}</div></section>; }
function InspectionFailure({ code }: { code: string | null }) { const details = inspectionErrorDetails(code); return <Notice critical><p className="font-medium">{details.title}</p><p className="mt-2 text-text-secondary">{details.action}</p><details className="mt-3 text-meta text-text-muted"><summary className="cursor-pointer">Detail teknis</summary><p className="mt-2 font-data">{code ?? "INSPECTION_FAILED"}</p></details></Notice>; }
function Value({ label, value, data = false }: { label: string; value: string; data?: boolean }) { return <div className="rounded-control border border-border bg-bg-base p-3"><dt className="text-meta text-text-muted">{label}</dt><dd className={`mt-1 ${data ? "font-data" : ""}`}>{value}</dd></div>; }
function Field({ label, value, setValue }: { label: string; value: string; setValue: (value: string) => void }) { return <label className="grid gap-2 text-meta text-text-secondary">{label}<input className="rounded-control border border-border bg-bg-base px-3 py-2 text-text-primary" value={value} onChange={(event) => setValue(event.target.value)} /></label>; }
function Notice({ children, critical = false }: { children: React.ReactNode; critical?: boolean }) { return <div className={`mt-4 rounded-control border bg-bg-base p-4 ${critical ? "border-severity-critical text-severity-critical" : "border-border text-text-secondary"}`}>{children}</div>; }
function networkNodeTypeLabelSafe(value: string) { return NETWORK_NODE_TYPES.includes(value as NetworkNodeType) ? networkNodeTypeLabel(value as NetworkNodeType) : value.replaceAll("_", " "); }
function capabilityLabel(value: string) { return ({ wifi_ap: "WiFi AP", layer3_forwarding: "Layer-3 forwarding", gateway: "Gateway", upnp: "UPnP" } as Record<string, string>)[value] ?? value.replaceAll("_", " "); }
function stageLabel(value: DeviceInspectionSession["stage"]) { return ({ validating_target: "Validating authorized target", network_role: "Network role", identity: "Checking identity", services: "Checking selected services", normalizing: "Normalizing fingerprint", complete: "Complete" })[value]; }
async function functionError(error: unknown) { if (error && typeof error === "object" && "context" in error) { const response = (error as { context?: unknown }).context; if (response instanceof Response) { try { const payload = await response.clone().json() as { error?: string; code?: string }; if (payload.code) { const details = inspectionErrorDetails(payload.code); return `${details.title} ${details.action}`; } if (payload.error) return payload.error; } catch {} } } return "Device inspection request failed."; }
