"use client";

import Link from "next/link";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

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
import { healthTargetMonitoringStateAction, promoteHealthTargetsAction } from "@/app/actions/health-promotion";
import { ManagedTelemetrySection } from "@/components/device-profile/managed-telemetry-section";
import type { ProfileRole } from "@/lib/authorization";
import { startDeviceInspectionAction } from "@/app/actions/legacy-network-control";

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
  role: ProfileRole;
  runners?: InspectorRunner[];
}) {
  const { t } = useTranslation("devices");
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
  const runnerProfiles = useMemo(() => runners.map((item) => ({
    runnerId: item.id,
    profiles: item.capabilities?.snmp_telemetry?.credential_profiles ?? [],
  })), [runners]);

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
    void healthTargetMonitoringStateAction(runner.id, node.id)
      .then((value) => { if (!cancelled) setMonitored(value); });
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
    if (!options || !canLaunchActiveInspection(role)) return setError(t("profile.operatorRequired"));
    if (!selectedRunner) return setError(t("profile.runnerUnavailable"));
    setBusy(true);
    setError(null);
    const result = await startDeviceInspectionAction(selectedRunner.id, options.ipAddress);
    if (!result.ok || !result.data) setError(t("profile.requestFailed"));
    else setSession(result.data);
    setBusy(false);
  }

  return <DeviceProfileContext.Provider value={{ openDeviceProfile }}>
    {children}
    {opened ? <DeviceProfileDrawer key={opened.ipAddress}
      opened={opened} node={node} fingerprint={fingerprint} session={session}
      canManage={canLaunchActiveInspection(role)} runnerId={runner?.id ?? null} monitored={monitored} busy={busy} error={error}
      runnerProfiles={runnerProfiles}
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
        const { ok } = await promoteHealthTargetsAction(runner!.id, [node!.id]);
        setBusy(false);
        if (!ok) setError(t("profile.healthAddFailed"));
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

function DeviceProfileDrawer({ opened, node, fingerprint, session, canManage, runnerId, monitored, busy, error, runnerProfiles, close, inspect, saveIdentity, saveDetected, addToHealth, setError }: {
  opened: OpenOptions;
  node: ReturnType<typeof findNetworkNode> | null;
  fingerprint: DeviceFingerprint | null;
  session: DeviceInspectionSession | null;
  canManage: boolean;
  runnerId: string | null;
  monitored: boolean | null;
  busy: boolean;
  error: string | null;
  runnerProfiles: { runnerId: string; profiles: string[] }[];
  close: () => void;
  inspect: () => void;
  saveIdentity: (input: NetworkNodeInput) => Promise<void>;
  saveDetected: (() => Promise<void>) | null;
  addToHealth: (() => Promise<void>) | null;
  setError: (value: string | null) => void;
}) {
  const { t } = useTranslation("devices");
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
      <div className="flex items-start justify-between gap-4"><div><p className="text-meta font-medium uppercase tracking-wide text-accent">{t("profile.title")}</p><h2 className="mt-2 text-heading font-semibold">{node?.name || opened.ipAddress}</h2><p className="mt-1 font-data text-text-secondary">{opened.ipAddress}</p></div><Button variant="secondary" onClick={close}>{t("common:actions.close")}</Button></div>
      {opened.observedStatus ? <p className="mt-4 text-meta uppercase tracking-wide text-text-secondary">{t("profile.observedStatus", { status: t(`common:status.${opened.observedStatus}`) })}</p> : null}
      {active ? <Progress stage={session?.stage ?? "validating_target"} /> : null}
      {session?.status === "failed" ? <InspectionFailure code={session.error_code} /> : null}
      {error ? <Notice critical>{error}</Notice> : null}
      {fingerprint?.probe_summary.partial && !insufficient ? <Notice><p className="font-medium text-text-primary">{t("profile.partialTitle")}</p><p className="mt-2">{t(fingerprint.probe_summary.deadline_reached ? "profile.deadlinePartial" : "profile.collectorPartial")} {t("profile.partialEvidence")}</p></Notice> : null}
      {insufficient ? <Notice><p className="font-medium text-text-primary">{t("profile.insufficientTitle")}</p><p className="mt-2">{t("profile.insufficientBody")}</p></Notice> : null}

      <Section title={t("profile.sections.likely")}>
        <dl className="grid gap-3 sm:grid-cols-2"><Value label={t("profile.fields.detected")} value={fingerprint ? detectedLabel(fingerprint) : t("profile.notInspected")} /><Value label={t("profile.fields.deviceType")} value={fingerprint?.likely_device_type ? networkNodeTypeLabelSafe(fingerprint.likely_device_type) : t("profile.notInspected")} /><Value label={t("profile.fields.confidence")} value={fingerprint ? confidenceLabel(fingerprint.confidence) : t("profile.notInspected").toUpperCase()} /><Value label={t("profile.fields.capabilities")} value={fingerprint ? fingerprint.capabilities.map(capabilityLabel).join(", ") || t("profile.notDetected") : t("profile.notInspected")} /></dl>
      </Section>
      <Section title={t("profile.sections.network")}>
        <dl className="grid gap-3 sm:grid-cols-2"><Value label="IP" value={opened.ipAddress} data /><Value label="MAC" value={fingerprint?.network_identity.mac ?? (fingerprint?.same_subnet === false ? t("profile.routedUnavailable") : t("profile.unavailable"))} data /><Value label={t("profile.fields.macVendor")} value={fingerprint?.network_identity.mac_kind === "locally_administered" ? t("profile.randomizedMac") : fingerprint?.network_identity.mac_vendor ?? t("profile.unavailable")} /><Value label={t("profile.fields.relation")} value={fingerprint?.network_context?.is_this_device ? t("profile.thisDevice") : fingerprint?.route_role?.replaceAll("_", " ") ?? t("common:status.unknown")} /><Value label={t("profile.fields.sourceInterface")} value={fingerprint?.network_context?.interface_alias ?? t("profile.notObserved")} /><Value label={t("profile.fields.sourceAdapter")} value={fingerprint?.network_context?.interface_description ?? t("profile.notObserved")} /><Value label={t("profile.fields.interfaceType")} value={fingerprint?.network_context?.interface_type ?? t("profile.notObserved")} /><Value label={t("profile.fields.tlsIdentity")} value={fingerprint?.network_identity.tls_identity ?? t("profile.notObserved")} /></dl>
      </Section>
      <Section title={t("profile.sections.detected")}>
        <dl className="grid gap-3 sm:grid-cols-2"><Value label={t("profile.fields.manufacturer")} value={fingerprint?.detected_identity.manufacturer ?? t("profile.notDetected")} /><Value label={t("profile.fields.model")} value={fingerprint?.detected_identity.model ?? t("profile.notDetected")} /><Value label={t("profile.fields.modelNumber")} value={fingerprint?.detected_identity.model_number ?? t("profile.notDetected")} /><Value label={t("profile.fields.osFamily")} value={fingerprint?.detected_identity.os_family ?? t("profile.notDetected")} /></dl>
      </Section>
      <Section title={t("profile.sections.services")}>
        {fingerprint?.observed_services.length ? <ul className="grid gap-2 sm:grid-cols-2">{fingerprint.observed_services.map((service) => <li key={`${service.protocol}-${service.port}`} className="rounded-control border border-border bg-bg-base p-3"><span>{service.name}</span> <span className="font-data text-text-secondary">{service.protocol.toUpperCase()}/{service.port}</span></li>)}</ul> : <p className="text-text-secondary">{t("profile.servicesEmpty")}</p>}
        {fingerprint?.probe_summary.tcp_states?.length ? <details className="mt-3 rounded-control border border-border bg-bg-base p-3 text-meta"><summary className="cursor-pointer text-text-secondary">{t("profile.tcpStates")}</summary><ul className="mt-3 grid gap-2 sm:grid-cols-2">{fingerprint.probe_summary.tcp_states.map((service) => <li key={`state-${service.port}`} className="flex justify-between gap-3"><span>{service.name} <span className="font-data text-text-muted">TCP/{service.port}</span></span><span className="font-data uppercase text-text-secondary">{service.state}</span></li>)}</ul><p className="mt-3 text-text-muted">{t("profile.tcpNotice")}</p></details> : null}
      </Section>
      <Section title={t("profile.sections.software")}>
        {fingerprint?.observed_software.length ? <ul className="flex flex-wrap gap-2">{fingerprint.observed_software.map((software) => <li key={software} className="rounded-control border border-border bg-bg-base px-3 py-2 font-data">{software}</li>)}</ul> : <p className="text-text-secondary">{t("profile.softwareEmpty")}</p>}
      </Section>
      <Section title={t("profile.sections.why")}>
        {fingerprint?.evidence.length ? <ul className="grid gap-2">{fingerprint.evidence.map((item, index) => <li key={`${item.source}-${index}`} className="rounded-control border border-border bg-bg-base p-3"><p className="text-meta text-text-muted">{item.label}</p><p className="mt-1">{item.value}</p></li>)}</ul> : <p className="text-text-secondary">{t("profile.evidenceEmpty")}</p>}
        {missingIdentity.length ? <p className="mt-3 text-meta text-text-muted">{t("profile.missingIdentity", { fields: missingIdentity.join(", ") })}</p> : null}
      </Section>

      <Section title={t("profile.sections.operator")}>
        {identityConflict ? <Notice critical><p className="font-medium">{t("profile.conflictTitle")}</p><p className="mt-2">{t("profile.conflictBody")}</p></Notice> : null}
        {canManage ? <div className="grid gap-3 sm:grid-cols-2"><Field label={t("profile.fields.name")} value={name} setValue={setName} /><Field label={t("profile.fields.location")} value={location} setValue={setLocation} /><label className="grid gap-2 text-meta text-text-secondary">{t("profile.fields.category")}<select className="rounded-control border border-border bg-bg-base px-3 py-2 text-text-primary" value={type} onChange={(event) => setType(event.target.value as NetworkNodeType | "")}><option value="">{t("profile.unspecified")}</option>{NETWORK_NODE_TYPES.map((item) => <option key={item} value={item}>{networkNodeTypeLabel(item)}</option>)}</select></label><label className="grid gap-2 text-meta text-text-secondary sm:col-span-2">{t("profile.fields.notes")}<textarea className="min-h-24 rounded-control border border-border bg-bg-base px-3 py-2 text-text-primary" value={notes} onChange={(event) => setNotes(event.target.value)} /></label><Button disabled={busy || !name.trim()} onClick={() => void saveIdentity({ ip_address: opened.ipAddress, name, location, notes, device_type: type || null })}>{t("profile.saveIdentity")}</Button>{saveDetected ? <Button variant="secondary" disabled={busy} onClick={() => void saveDetected()}>{t("profile.saveEvidence")}</Button> : null}</div> : <dl className="grid gap-3 sm:grid-cols-2"><Value label={t("profile.fields.name")} value={node?.name ?? t("profile.notSaved")} /><Value label={t("profile.fields.location")} value={node?.location ?? t("profile.notSaved")} /><Value label={t("profile.fields.category")} value={node?.device_type ? networkNodeTypeLabel(node.device_type) : t("profile.notSaved")} /><Value label={t("profile.fields.notes")} value={node?.notes ?? t("profile.notSaved")} /></dl>}
      </Section>

      <ManagedTelemetrySection nodeId={node?.id ?? ""} runnerProfiles={runnerProfiles} />

      <Section title={t("profile.sections.actions")}><div className="flex flex-wrap gap-2">{canManage ? <Button disabled={busy || !runnerId || Boolean(active)} onClick={() => { setError(null); inspect(); }}>{t(fingerprint ? "profile.inspectAgain" : "profile.inspect")}</Button> : null}{canManage && addToHealth ? <Button variant="secondary" disabled={busy} onClick={() => void addToHealth()}>{t("profile.addHealth")}</Button> : null}{monitored ? <Link className="rounded-control border border-border px-4 py-2" href="/dashboard">{t("profile.viewHealth")}</Link> : null}<Link className="rounded-control border border-border px-4 py-2" href="/diagnostics">{t("profile.openDiagnostics")}</Link><Link className="rounded-control border border-border px-4 py-2" href={`/traffic?ip=${encodeURIComponent(opened.ipAddress)}`}>{t("profile.viewTraffic")}</Link></div></Section>
      <div className="mt-6 rounded-control border border-border bg-bg-base p-4 text-meta text-text-secondary">{t("profile.safetyNotice")}</div>
    </aside>
  </div>;
}

function Progress({ stage }: { stage: DeviceInspectionSession["stage"] }) {
  const { t } = useTranslation("devices");
  const stages: DeviceInspectionSession["stage"][] = ["validating_target", "network_role", "identity", "services", "normalizing", "complete"];
  const active = stages.indexOf(stage);
  return <section className="mt-6 rounded-control border border-accent bg-bg-base p-4"><p className="font-medium">{t("profile.inspecting")}</p><ul className="mt-3 grid gap-2 sm:grid-cols-2">{stages.slice(0, -1).map((item, index) => <li key={item} className={index <= active ? "text-accent" : "text-text-muted"}>{index < active ? "✓" : index === active ? "●" : "○"} {t(`profile.stages.${item}`)}</li>)}</ul></section>;
}
function Section({ title, children }: { title: string; children: React.ReactNode }) { return <section className="mt-6 border-t border-border pt-5"><h3 className="text-section font-semibold">{title}</h3><div className="mt-3">{children}</div></section>; }
function InspectionFailure({ code }: { code: string | null }) { const { t } = useTranslation("devices"); const details = inspectionErrorDetails(code); return <Notice critical><p className="font-medium">{details.title}</p><p className="mt-2 text-text-secondary">{details.action}</p><details className="mt-3 text-meta text-text-muted"><summary className="cursor-pointer">{t("profile.technicalDetails")}</summary><p className="mt-2 font-data">{code ?? "INSPECTION_FAILED"}</p></details></Notice>; }
function Value({ label, value, data = false }: { label: string; value: string; data?: boolean }) { return <div className="rounded-control border border-border bg-bg-base p-3"><dt className="text-meta text-text-muted">{label}</dt><dd className={`mt-1 ${data ? "font-data" : ""}`}>{value}</dd></div>; }
function Field({ label, value, setValue }: { label: string; value: string; setValue: (value: string) => void }) { return <label className="grid gap-2 text-meta text-text-secondary">{label}<input className="rounded-control border border-border bg-bg-base px-3 py-2 text-text-primary" value={value} onChange={(event) => setValue(event.target.value)} /></label>; }
function Notice({ children, critical = false }: { children: React.ReactNode; critical?: boolean }) { return <div className={`mt-4 rounded-control border bg-bg-base p-4 ${critical ? "border-severity-critical text-severity-critical" : "border-border text-text-secondary"}`}>{children}</div>; }
function networkNodeTypeLabelSafe(value: string) { return NETWORK_NODE_TYPES.includes(value as NetworkNodeType) ? networkNodeTypeLabel(value as NetworkNodeType) : value.replaceAll("_", " "); }
function capabilityLabel(value: string) { return ({ wifi_ap: "WiFi AP", layer3_forwarding: "Layer-3 forwarding", gateway: "Gateway", upnp: "UPnP" } as Record<string, string>)[value] ?? value.replaceAll("_", " "); }
