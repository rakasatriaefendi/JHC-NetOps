"use client";

import Link from "next/link";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import { deleteManagedTelemetryTargetAction, saveManagedTelemetryTargetAction } from "@/app/actions/snmp";
import { Button } from "@/components/ui/button";
import type { RunnerCapabilities } from "@/lib/diagnostic-jobs";
import { credentialProfileStatus, formatDateTime } from "@/lib/managed-telemetry";

type Node = { id: string; name: string; ip_address: string; location: string | null };
type Runner = { id: string; display_name: string; capabilities: RunnerCapabilities };
type Target = {
  id: string;
  node_id: string;
  runner_id: string;
  enabled: boolean;
  credential_profile_ref: string;
  snmp_version: "3" | "2c";
  snmp_port: number;
  poll_interval_seconds: number;
  oper_error_threshold: number;
  discard_threshold: number;
  util_warning_percent: number;
  util_critical_percent: number;
  util_sustained_seconds: number;
  latest?: { status: string; last_polled_at: string | null } | null;
};

type Props = { nodes: Node[]; runners: Runner[]; targets: Target[]; canManage: boolean; notice?: string; error?: string };

export function ManagedTelemetryTargets({ nodes, runners, targets, canManage, notice, error }: Props) {
  const { t, i18n } = useTranslation("admin");
  const [editingId, setEditingId] = useState<string | null>(null);
  const editingTarget = targets.find((target) => target.id === editingId);

  return (
    <section className="mt-12 border-t border-border pt-8" id="managed-telemetry">
      <p className="text-meta font-medium uppercase tracking-wide text-accent">{t("telemetry.eyebrow")}</p>
      <h2 className="mt-2 text-heading font-semibold">{t("telemetry.title")}</h2>
      <p className="mt-2 max-w-3xl text-text-secondary">{t("telemetry.description")}</p>
      {notice ? <p className="mt-4 text-severity-low" role="status">{notice === "deleted" ? t("telemetry.deleted") : t("telemetry.saved")}</p> : null}
      {error ? <p className="mt-4 text-severity-critical" role="alert">{t("telemetry.failed", { reason: telemetryError(error, t) })}</p> : null}
      <div className="mt-4 rounded-control border border-border bg-bg-base p-4 text-meta text-text-secondary">
        {t("telemetry.secretNotice")}
      </div>

      {canManage ? (
        nodes.length > 0 && runners.length > 0 ? (
          <div className="mt-6 rounded-panel border border-border bg-bg-surface p-4 md:p-6">
            <h3 className="text-section font-semibold">{t("telemetry.addTitle")}</h3>
            <p className="mt-1 text-meta text-text-muted">{t("telemetry.addDescription")} <Link className="text-accent hover:underline" href="/devices#add-device">{t("telemetry.addLink")}</Link>.</p>
            <TargetForm key={`create-${targets.length}`} nodes={nodes} runners={runners} />
          </div>
        ) : (
          <div className="mt-6 rounded-panel border border-severity-medium bg-bg-surface p-4 text-text-secondary">{t("telemetry.requirements")}</div>
        )
      ) : null}

      <div className="mt-8">
        <h3 className="text-section font-semibold">{t("telemetry.devices")}</h3>
        <p className="mt-1 text-meta text-text-muted">{t("telemetry.targetCount", { count: targets.length })}</p>
        {targets.length === 0 ? (
          <div className="mt-4 rounded-control border border-border bg-bg-surface p-4 text-text-secondary">{t("telemetry.empty")}</div>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-control border border-border">
            <table className="w-full min-w-[920px] text-left">
              <thead className="bg-bg-surface text-meta text-text-secondary"><tr><th className="p-3">{t("telemetry.columns.node")}</th><th className="p-3">{t("telemetry.columns.runner")}</th><th className="p-3">{t("telemetry.columns.status")}</th><th className="p-3">{t("telemetry.columns.snmp")}</th><th className="p-3">{t("telemetry.columns.profile")}</th><th className="p-3">{t("telemetry.columns.latest")}</th>{canManage ? <th className="p-3 text-right">{t("telemetry.columns.action")}</th> : null}</tr></thead>
              <tbody>{targets.map((target) => {
                const node = nodes.find((item) => item.id === target.node_id);
                const runner = runners.find((item) => item.id === target.runner_id);
                const profile = credentialProfileStatus(runner?.capabilities?.snmp_telemetry?.credential_profiles, target.credential_profile_ref);
                return <tr className="border-t border-border bg-bg-base" key={target.id}>
                  <td className="p-3"><p className="font-medium">{node?.name ?? t("telemetry.unknownNode")}</p><p className="mt-1 font-data text-meta text-text-muted">{node?.ip_address ?? "-"}{node?.location ? ` · ${node.location}` : ""}</p></td>
                  <td className="p-3 text-text-secondary">{runner?.display_name ?? target.runner_id}</td>
                  <td className="p-3"><State enabled={target.enabled} />{target.latest ? <p className="mt-1 text-meta text-text-secondary">{target.latest.status}</p> : null}</td>
                  <td className="p-3 font-data text-meta">v{target.snmp_version} · TCP/UDP {target.snmp_port}<br />{t("telemetry.seconds", { count: target.poll_interval_seconds })}</td>
                  <td className="p-3 text-meta"><p className="font-data">{target.credential_profile_ref}</p><ProfileState profile={profile} /></td>
                  <td className="p-3 font-data text-meta">{formatDateTime(target.latest?.last_polled_at ?? null, i18n.language)}</td>
                  {canManage ? <td className="p-3"><div className="flex flex-wrap justify-end gap-2"><Button variant="secondary" onClick={() => setEditingId(target.id)}>{t("telemetry.edit")}</Button><form action={deleteManagedTelemetryTargetAction} onSubmit={(event) => {
                    const label = `${node?.name ?? t("telemetry.unknownNode")} (${node?.ip_address ?? "-"})`;
                    if (!window.confirm(t("telemetry.deleteConfirm", { target: label }))) event.preventDefault();
                  }}><input name="target_id" type="hidden" value={target.id} /><input name="confirmation" type="hidden" value={`${node?.name ?? ""} (${node?.ip_address ?? ""})`} /><Button type="submit" variant="destructive">{t("telemetry.delete")}</Button></form></div></td> : null}
                </tr>;
              })}</tbody>
            </table>
          </div>
        )}
      </div>

      {canManage && editingTarget ? <div className="mt-6 rounded-panel border border-accent bg-bg-surface p-4 md:p-6">
        <div className="flex items-start justify-between gap-4"><div><p className="text-meta font-medium uppercase tracking-wide text-accent">{t("telemetry.editTitle")}</p><h3 className="mt-2 text-section font-semibold">{nodes.find((node) => node.id === editingTarget.node_id)?.name ?? t("telemetry.unknownNode")}</h3></div><Button variant="secondary" onClick={() => setEditingId(null)}>{t("common:actions.cancel")}</Button></div>
        <TargetForm nodes={nodes} runners={runners} target={editingTarget} />
      </div> : null}
    </section>
  );
}

function State({ enabled }: { enabled: boolean }) { const { t } = useTranslation("admin"); return <span className={`inline-flex rounded-full px-3 py-1 text-meta font-medium ${enabled ? "bg-severity-low/10 text-severity-low" : "bg-text-muted/10 text-text-muted"}`}>{t(enabled ? "telemetry.enabled" : "telemetry.disabled")}</span>; }
function ProfileState({ profile }: { profile: "available" | "unavailable" | "unknown" }) {
  const { t } = useTranslation("admin");
  if (profile === "available") return <span className="text-severity-low">{t("telemetry.profileAvailable")}</span>;
  if (profile === "unavailable") return <span className="text-severity-medium">{t("telemetry.profileUnavailable")}</span>;
  return <span className="text-text-muted">{t("telemetry.profileUnknown")}</span>;
}

function TargetForm({ nodes, runners, target }: { nodes: Node[]; runners: Runner[]; target?: Target }) {
  const { t } = useTranslation("admin");
  const [runnerId, setRunnerId] = useState(target?.runner_id ?? "");
  const [profileRef, setProfileRef] = useState(target?.credential_profile_ref ?? "");
  const selectedRunner = runners.find((runner) => runner.id === runnerId);
  const profile = credentialProfileStatus(selectedRunner?.capabilities?.snmp_telemetry?.credential_profiles, profileRef.trim());
  return <form action={saveManagedTelemetryTargetAction} className="mt-5 grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-[repeat(4,minmax(0,1fr))]">
    <Field label={t("telemetry.inventoryNode")}><select className={control} defaultValue={target?.node_id ?? ""} disabled={Boolean(target)} name="node_id" required title={t("telemetry.selectNode")}><option disabled value="">{t("telemetry.selectNode")}</option>{nodes.map((node) => <option key={node.id} value={node.id}>{node.name} - {node.ip_address}</option>)}</select>{target ? <input name="node_id" type="hidden" value={target.node_id} /> : null}</Field>
    <Field label={t("telemetry.columns.runner")}><select className={control} value={runnerId} onChange={(event) => setRunnerId(event.target.value)} disabled={Boolean(target)} name="runner_id" required><option disabled value="">{t("telemetry.selectRunner")}</option>{runners.map((runner) => <option key={runner.id} value={runner.id}>{runner.display_name}</option>)}</select>{target ? <input name="runner_id" type="hidden" value={target.runner_id} /> : null}</Field>
    <Field label={t("telemetry.version")}><select className={control} defaultValue={target?.snmp_version ?? "3"} name="snmp_version"><option value="3">SNMPv3</option><option value="2c">SNMPv2c</option></select></Field>
    <Field label={t("telemetry.port")}><input className={control} defaultValue={target?.snmp_port ?? 161} max={65535} min={1} name="snmp_port" required step="1" type="number" /></Field>
    <Field label={t("telemetry.interval")}><select className={control} defaultValue={target?.poll_interval_seconds ?? 60} name="poll_interval_seconds"><option value="30">{t("telemetry.seconds", { count: 30 })}</option><option value="60">{t("telemetry.seconds", { count: 60 })}</option></select></Field>
    <div className="md:col-span-3"><Field label={t("telemetry.profileRef")}><input className={control} value={profileRef} onChange={(event) => setProfileRef(event.target.value)} maxLength={64} name="credential_profile_ref" pattern="[a-z0-9][a-z0-9_-]{0,63}" required /></Field><p className="mt-1 text-meta">{profile === "available" ? <span className="text-severity-low">{t("telemetry.profileAvailableHelp")}</span> : profile === "unavailable" ? <span className="text-severity-medium">{t("telemetry.profileUnavailableHelp")}</span> : <span className="text-text-muted">{t("telemetry.profileHelp")}</span>}</p></div>
    <NumberField label={t("telemetry.errorThreshold")} name="oper_error_threshold" value={target?.oper_error_threshold ?? 5} min={1} max={100} />
    <NumberField label={t("telemetry.discardThreshold")} name="discard_threshold" value={target?.discard_threshold ?? 10} min={1} max={100} />
    <NumberField label={t("telemetry.utilWarning")} name="util_warning_percent" value={target?.util_warning_percent ?? 80} min={1} max={100} />
    <NumberField label={t("telemetry.utilCritical")} name="util_critical_percent" value={target?.util_critical_percent ?? 95} min={1} max={100} />
    <NumberField label={t("telemetry.sustained")} name="util_sustained_seconds" value={target?.util_sustained_seconds ?? 300} min={60} max={3600} />
    <label className="flex items-center gap-2"><input defaultChecked={target?.enabled ?? true} name="enabled" type="checkbox" /> {t("telemetry.enabled")}</label>
    <div className="md:col-span-3 md:text-right"><button className="rounded-control border border-accent bg-accent px-4 py-2 font-medium text-bg-base" type="submit">{t(target ? "telemetry.save" : "telemetry.add")}</button></div>
  </form>;
}

function telemetryError(value: string, t: TFunction) {
  if (value === "portable-read-only") return t("telemetry.errors.portable");
  if (value === "profile-unavailable") return t("telemetry.errors.profile");
  if (value === "unknown-target") return t("telemetry.errors.unknown");
  if (value === "delete-failed") return t("telemetry.errors.delete");
  if (value === "invalid-fields" || value === "invalid-form") return t("telemetry.errors.invalid");
  return t("telemetry.errors.fallback");
}
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="grid min-w-0 gap-2 text-meta text-text-secondary">{label}{children}</label>; }
function NumberField({ label, name, value, min, max }: { label: string; name: string; value: number; min: number; max: number }) { return <Field label={label}><input className={control} defaultValue={value} max={max} min={min} name={name} required step="1" type="number" /></Field>; }
const control = "min-w-0 w-full truncate rounded-control border border-border bg-bg-base px-3 py-2 text-body text-text-primary outline-none focus:border-accent";
