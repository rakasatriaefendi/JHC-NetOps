"use client";

import Link from "next/link";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  deleteNetworkNodeAction,
  deleteNetworkTargetAction,
  saveManualNetworkNodeAction,
  saveNetworkTargetAction,
  updateNetworkNodeAction,
} from "@/app/actions/devices";
import { Button } from "@/components/ui/button";
import { MutationForm, PendingSubmit } from "@/components/ui/mutation-form";
import { MonitoringModeLabel, MonitoringModeSelector } from "@/components/monitoring-mode-selector";
import {
  NETWORK_NODE_TYPES,
  networkNodeTypeLabel,
  type NetworkNode,
} from "@/lib/network-nodes";

type Runner = { id: string; display_name: string };
export type DeviceHealthTarget = {
  id: string;
  node_id: string;
  runner_id: string;
  enabled: boolean;
  critical: boolean;
  probe_interval_seconds: number;
  timeout_ms: number;
  failure_threshold: number;
  recovery_threshold: number;
  latency_warning_ms: number;
  loss_warning_percent: number;
  network_health_latest?: { status: "online" | "degraded" | "offline"; last_checked_at: string } | { status: "online" | "degraded" | "offline"; last_checked_at: string }[] | null;
};

type Props = {
  nodes: NetworkNode[];
  runners: Runner[];
  targets: DeviceHealthTarget[];
  canManage: boolean;
  deviceNotice?: string;
  deviceError?: string;
  healthNotice?: string;
  healthError?: string;
};

export function DeviceInventory({ nodes, runners, targets, canManage, deviceNotice, deviceError, healthNotice, healthError }: Props) {
  const { t } = useTranslation("devices");
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [healthNodeId, setHealthNodeId] = useState<string | null>(null);
  const [editingHealthId, setEditingHealthId] = useState<string | null>(null);
  const editingNode = nodes.find((node) => node.id === editingNodeId);
  const healthNode = nodes.find((node) => node.id === healthNodeId);
  const editingHealth = targets.find((target) => target.id === editingHealthId);

  function openHealth(nodeId: string, targetId: string | null = null) {
    setHealthNodeId(nodeId);
    setEditingHealthId(targetId);
    setEditingNodeId(null);
  }

  return (
    <section id="device-inventory">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-meta font-medium uppercase tracking-wide text-accent">{t("page.eyebrow")}</p>
          <h1 className="mt-2 text-heading font-semibold">{t("page.title")}</h1>
          <p className="mt-2 max-w-3xl text-text-secondary">{t("page.description")}</p>
        </div>
        <div className="font-data text-meta text-text-muted">{t("page.count", { count: nodes.length })}</div>
      </div>

      <DeviceFeedback notice={deviceNotice} error={deviceError} />
      <HealthFeedback notice={healthNotice} error={healthError} />

      {canManage ? <div className="mt-6 rounded-panel border border-border bg-bg-surface p-4 md:p-6" id="add-device">
        <h2 className="text-section font-semibold">{t("add.title")}</h2>
        <p className="mt-1 text-meta text-text-muted">{t("add.description")}</p>
        <MutationForm action={saveManualNetworkNodeAction} kind="create" className="mt-5 grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-[repeat(4,minmax(0,1fr))]">
          <Field label={t("add.ip")}><input className={control} inputMode="decimal" maxLength={15} name="ip_address" placeholder="192.168.1.20" required /></Field>
          <Field label={t("add.name")}><input className={control} maxLength={200} name="name" placeholder={t("add.namePlaceholder")} required /></Field>
          <Field label={t("add.type")}><select className={control} defaultValue="" name="device_type"><option value="">{t("add.typeEmpty")}</option>{NETWORK_NODE_TYPES.map((value) => <option key={value} value={value}>{networkNodeTypeLabel(value)}</option>)}</select></Field>
          <Field label={t("add.location")}><input className={control} maxLength={200} name="location" placeholder={t("add.locationPlaceholder")} /></Field>
          <div className="min-w-0 md:col-span-2 xl:col-span-3"><Field label={t("add.notes")}><textarea className={control} maxLength={2000} name="notes" rows={2} /></Field></div>
          <div className="flex items-end xl:justify-end"><PendingSubmit className="w-full xl:w-auto" >{t("add.submit")}</PendingSubmit></div>
        </MutationForm>
      </div> : null}

      <div className="mt-6 rounded-control border border-border bg-bg-surface p-4 text-text-secondary">
        <p className="font-medium text-text-primary">{t("import.title")}</p>
        <p className="mt-1 text-meta">{t("import.description")}</p>
        <Link className="mt-3 inline-flex text-meta font-medium text-accent hover:underline" href="/dashboard">{t("import.open")}</Link>
      </div>

      <div className="mt-8">
        <h2 className="text-section font-semibold">{t("list.title")}</h2>
        <p className="mt-1 text-meta text-text-muted">{t("list.description")}</p>
        {nodes.length === 0 ? <div className="mt-4 rounded-control border border-border bg-bg-surface p-6 text-text-secondary">{t("list.empty")}</div> : (
          <div className="mt-4 overflow-x-auto rounded-control border border-border">
            <table className="w-full min-w-[980px] text-left">
              <thead className="bg-bg-surface text-meta text-text-secondary"><tr><th className="p-3">{t("list.device")}</th><th className="p-3">{t("list.typeLocation")}</th><th className="p-3">{t("list.identity")}</th><th className="p-3">{t("list.health")}</th>{canManage ? <th className="p-3 text-right">{t("list.actions")}</th> : null}</tr></thead>
              <tbody>{nodes.map((node) => {
                const nodeTargets = targets.filter((target) => target.node_id === node.id);
                return <tr className="border-t border-border bg-bg-base align-top" key={node.id}>
                  <td className="p-3"><p className="font-medium">{node.name}</p><p className="mt-1 font-data text-meta text-text-muted">{node.ip_address}</p></td>
                  <td className="p-3 text-text-secondary"><p>{node.device_type ? networkNodeTypeLabel(node.device_type) : "-"}</p><p className="mt-1 text-meta text-text-muted">{node.location ?? "-"}</p></td>
                  <td className="p-3 text-text-secondary">{node.detected_fingerprint?.detected_identity.likely_label ?? t("list.notObserved")}</td>
                  <td className="p-3"><HealthSummary targets={nodeTargets} runners={runners} /></td>
                  {canManage ? <td className="p-3"><div className="flex flex-wrap justify-end gap-2">
                    <Button variant="secondary" onClick={() => { setEditingNodeId(node.id); setHealthNodeId(null); }}>{t("list.edit")}</Button>
                    <Button variant="secondary" onClick={() => openHealth(node.id)}>{nodeTargets.length ? t("list.manageHealth") : t("list.configureHealth")}</Button>
                    <MutationForm action={deleteNetworkNodeAction} kind="delete" onSubmit={(event) => {
                      if (!window.confirm(t("list.deleteConfirm", { device: confirmationLabel(node) }))) event.preventDefault();
                    }}>
                      <input name="node_id" type="hidden" value={node.id} />
                      <input name="confirmation" type="hidden" value={confirmationLabel(node)} />
                      <PendingSubmit  variant="destructive">{t("list.delete")}</PendingSubmit>
                    </MutationForm>
                  </div></td> : null}
                </tr>;
              })}</tbody>
            </table>
          </div>
        )}
      </div>

      {canManage && editingNode ? <DeviceEditPanel node={editingNode} onClose={() => setEditingNodeId(null)} /> : null}
      {canManage && healthNode ? <HealthWatchPanel
        node={healthNode}
        runners={runners}
        targets={targets.filter((target) => target.node_id === healthNode.id)}
        editingTarget={editingHealth?.node_id === healthNode.id ? editingHealth : undefined}
        onEdit={(targetId) => setEditingHealthId(targetId)}
        onClose={() => { setHealthNodeId(null); setEditingHealthId(null); }}
      /> : null}
    </section>
  );
}

function DeviceEditPanel({ node, onClose }: { node: NetworkNode; onClose: () => void }) {
  const { t } = useTranslation("devices");
  return <div className="mt-6 rounded-panel border border-accent bg-bg-surface p-4 md:p-6">
    <div className="flex items-start justify-between gap-4"><div><p className="text-meta font-medium uppercase tracking-wide text-accent">{t("edit.title")}</p><h3 className="mt-2 text-section font-semibold">{node.name}</h3><p className="mt-1 font-data text-meta text-text-muted">{node.ip_address}</p></div><Button variant="secondary" onClick={onClose}>{t("common:actions.cancel")}</Button></div>
    <MutationForm action={updateNetworkNodeAction} kind="update" className="mt-5 grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-[repeat(4,minmax(0,1fr))]">
      <input name="node_id" type="hidden" value={node.id} />
      <Field label={t("edit.name")}><input className={control} defaultValue={node.name} maxLength={200} name="name" required /></Field>
      <Field label={t("edit.type")}><select className={control} defaultValue={node.device_type ?? ""} name="device_type"><option value="">{t("add.typeEmpty")}</option>{NETWORK_NODE_TYPES.map((value) => <option key={value} value={value}>{networkNodeTypeLabel(value)}</option>)}</select></Field>
      <Field label={t("edit.location")}><input className={control} defaultValue={node.location ?? ""} maxLength={200} name="location" /></Field>
      <Field label={t("edit.notes")}><textarea className={control} defaultValue={node.notes ?? ""} maxLength={2000} name="notes" rows={2} /></Field>
      <div className="md:col-span-2 xl:col-span-4 xl:text-right"><PendingSubmit >{t("edit.save")}</PendingSubmit></div>
    </MutationForm>
  </div>;
}

function HealthWatchPanel({ node, runners, targets, editingTarget, onEdit, onClose }: { node: NetworkNode; runners: Runner[]; targets: DeviceHealthTarget[]; editingTarget?: DeviceHealthTarget; onEdit: (id: string | null) => void; onClose: () => void }) {
  const { t } = useTranslation("devices");
  return <section className="mt-6 rounded-panel border border-accent bg-bg-surface p-4 md:p-6" id="network-health-targets">
    <div className="flex items-start justify-between gap-4"><div><p className="text-meta font-medium uppercase tracking-wide text-accent">{t("health.title")}</p><h3 className="mt-2 text-section font-semibold">{node.name}</h3><p className="mt-1 font-data text-meta text-text-muted">{node.ip_address}</p></div><Button variant="secondary" onClick={onClose}>{t("common:actions.close")}</Button></div>
    <p className="mt-3 max-w-3xl text-text-secondary">{t("health.description")}</p>
    {targets.length ? <div className="mt-5 grid gap-3">{targets.map((target) => <div className="flex flex-col gap-3 rounded-control border border-border bg-bg-base p-4 lg:flex-row lg:items-center lg:justify-between" key={target.id}>
      <HealthSummary targets={[target]} runners={runners} />
      <div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={() => onEdit(target.id)}>{t("health.edit")}</Button><MutationForm action={deleteNetworkTargetAction} kind="delete" onSubmit={(event) => {
        if (!window.confirm(t("health.removeConfirm", { device: confirmationLabel(node) }))) event.preventDefault();
      }}><input name="target_id" type="hidden" value={target.id} /><input name="confirmation" type="hidden" value={confirmationLabel(node)} /><PendingSubmit  variant="destructive">{t("health.remove")}</PendingSubmit></MutationForm></div>
    </div>)}</div> : <p className="mt-5 rounded-control border border-border bg-bg-base p-4 text-text-muted">{t("health.notMonitored")}</p>}
    {runners.length ? <div className="mt-6 border-t border-border pt-5"><h4 className="font-medium">{editingTarget ? t("health.editTitle") : targets.length ? t("health.addRunner") : t("health.configure")}</h4><TargetForm key={editingTarget?.id ?? `create-${targets.length}`} node={node} runners={runners} target={editingTarget} />{editingTarget ? <Button className="mt-3" variant="secondary" onClick={() => onEdit(null)}>{t("health.cancelEdit")}</Button> : null}</div> : <p className="mt-5 text-severity-medium">{t("health.runnerUnavailable")}</p>}
  </section>;
}

function HealthSummary({ targets, runners }: { targets: DeviceHealthTarget[]; runners: Runner[] }) {
  const { t } = useTranslation("devices");
  if (!targets.length) return <span className="text-text-muted">{t("health.notMonitored")}</span>;
  return <div className="grid gap-2">{targets.map((target) => {
    const latest = relation(target.network_health_latest);
    const runner = runners.find((item) => item.id === target.runner_id);
    return <div key={target.id}><div className="flex flex-wrap items-center gap-2"><MonitoringState target={target} />{latest ? <span className="text-meta capitalize text-text-secondary">{t("health.latest", { status: t(`common:status.${latest.status}`) })}</span> : null}</div><p className="mt-1 text-meta text-text-muted">{t("health.cadence", { runner: runner?.display_name ?? target.runner_id, interval: target.probe_interval_seconds, timeout: target.timeout_ms })}</p><p className="mt-1 text-meta text-text-muted"><MonitoringModeLabel interval={target.probe_interval_seconds} /></p></div>;
  })}</div>;
}

function MonitoringState({ target }: { target: DeviceHealthTarget }) {
  const { t } = useTranslation("devices");
  return <span className={`inline-flex rounded-full px-3 py-1 text-meta font-medium ${target.enabled ? "bg-severity-low/10 text-severity-low" : "bg-text-muted/10 text-text-muted"}`}>{target.enabled ? t("health.enabled") : t("health.disabled")}{target.critical ? ` · ${t("health.critical")}` : ""}</span>;
}

function TargetForm({ node, runners, target }: { node: NetworkNode; runners: Runner[]; target?: DeviceHealthTarget }) {
  const { t } = useTranslation("devices");
  return <MutationForm action={saveNetworkTargetAction} kind="save" className="mt-4 grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-[repeat(4,minmax(0,1fr))]">
    <input name="node_id" type="hidden" value={node.id} />
    <Field label={t("health.inventoryNode")}><div className="min-w-0 truncate rounded-control border border-border bg-bg-base px-3 py-2 text-text-primary" title={`${node.name} — ${node.ip_address}`}>{node.name} — {node.ip_address}</div></Field>
    <Field label={t("health.runner")}><select className={control} defaultValue={target?.runner_id ?? ""} disabled={Boolean(target)} name="runner_id" required><option disabled value="">{t("health.selectRunner")}</option>{runners.map((runner) => <option key={runner.id} value={runner.id}>{runner.display_name}</option>)}</select>{target ? <input name="runner_id" type="hidden" value={target.runner_id} /> : null}</Field>
    <MonitoringModeSelector currentInterval={target?.probe_interval_seconds ?? 900} name="probe_interval_seconds" />
    <NumberField label={t("health.timeout")} name="timeout_ms" value={target?.timeout_ms ?? 1000} min={250} max={5000} />
    <NumberField label={t("health.failures")} name="failure_threshold" value={target?.failure_threshold ?? 3} min={2} max={10} />
    <NumberField label={t("health.successes")} name="recovery_threshold" value={target?.recovery_threshold ?? 2} min={1} max={5} />
    <NumberField label={t("health.latency")} name="latency_warning_ms" value={target?.latency_warning_ms ?? 100} min={1} max={60000} />
    <NumberField label={t("health.loss")} name="loss_warning_percent" value={target?.loss_warning_percent ?? 40} min={0} max={100} />
    <label className="flex items-center gap-2"><input defaultChecked={target?.enabled ?? true} name="enabled" type="checkbox" /> {t("health.enabled")}</label>
    <label className="flex items-center gap-2"><input defaultChecked={target?.critical ?? false} name="critical" type="checkbox" /> {t("health.criticalTarget")}</label>
    <div className="md:col-span-2 md:text-right"><PendingSubmit >{target ? t("health.save") : t("health.add")}</PendingSubmit></div>
  </MutationForm>;
}

function DeviceFeedback({ notice, error }: { notice?: string; error?: string }) {
  const { t } = useTranslation("devices");
  const message = error ? null : notice === "existing" ? t("feedback.existing") : notice === "updated" ? t("feedback.updated") : notice === "deleted" ? t("feedback.deleted") : notice === "added" ? t("feedback.added") : null;
  const failure = ({
    "invalid-request": t("feedback.invalid"),
    "unknown-device": t("feedback.unknown"),
    "blocked-health": t("feedback.blockedHealth"),
    "blocked-snmp": t("feedback.blockedSnmp"),
    "blocked-health-snmp": t("feedback.blockedBoth"),
    "dependency-check-failed": t("feedback.dependency"),
    "delete-failed": t("feedback.deleteFailed"),
  } as Record<string, string>)[error ?? ""] ?? (error ? t("feedback.saveFailed") : null);
  return <>{message ? <p className="mt-4 text-severity-low" role="status">{message}</p> : null}{failure ? <p className="mt-4 text-severity-critical" role="alert">{failure}</p> : null}</>;
}

function HealthFeedback({ notice, error }: { notice?: string; error?: string }) {
  const { t } = useTranslation("devices");
  const success = error ? null : notice === "deleted" ? t("feedback.healthDeleted") : notice === "saved" ? t("feedback.healthSaved") : null;
  const failure = ({
    "invalid-request": t("feedback.healthInvalid"),
    "unknown-target": t("feedback.healthUnknown"),
    "delete-failed": t("feedback.healthDeleteFailed"),
  } as Record<string, string>)[error ?? ""] ?? (error ? t("feedback.healthSaveFailed") : null);
  return <>{success ? <p className="mt-4 text-severity-low" role="status">{success}</p> : null}{failure ? <p className="mt-4 text-severity-critical" role="alert">{failure}</p> : null}</>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="grid min-w-0 gap-2 text-meta text-text-secondary">{label}{children}</label>; }
function NumberField({ label, name, value, min, max }: { label: string; name: string; value: number; min: number; max: number }) { return <Field label={label}><input className={control} defaultValue={value} max={max} min={min} name={name} required step="1" type="number" /></Field>; }
function confirmationLabel(node: Pick<NetworkNode, "name" | "ip_address">) { return `${node.name} (${node.ip_address})`; }
function relation(value: DeviceHealthTarget["network_health_latest"]) { return Array.isArray(value) ? value[0] ?? null : value ?? null; }
const control = "min-w-0 w-full truncate rounded-control border border-border bg-bg-base px-3 py-2 text-body text-text-primary outline-none focus:border-accent";
