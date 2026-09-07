"use client";

import Link from "next/link";
import { useState } from "react";

import {
  deleteNetworkNodeAction,
  deleteNetworkTargetAction,
  saveManualNetworkNodeAction,
  saveNetworkTargetAction,
  updateNetworkNodeAction,
} from "@/app/actions/devices";
import { Button } from "@/components/ui/button";
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
          <p className="text-meta font-medium uppercase tracking-wide text-accent">Device inventory</p>
          <h1 className="mt-2 text-heading font-semibold">Devices</h1>
          <p className="mt-2 max-w-3xl text-text-secondary">Inventory adalah sumber otorisasi untuk Health Watch, SNMP, dan inspeksi perangkat. Discovery bersifat opsional.</p>
        </div>
        <div className="font-data text-meta text-text-muted">{nodes.length} known devices</div>
      </div>

      <DeviceFeedback notice={deviceNotice} error={deviceError} />
      <HealthFeedback notice={healthNotice} error={healthError} />

      {canManage ? <div className="mt-6 rounded-panel border border-border bg-bg-surface p-4 md:p-6" id="add-device">
        <h2 className="text-section font-semibold">Add device manually</h2>
        <p className="mt-1 text-meta text-text-muted">Menyimpan satu IP sebagai inventory node tidak menjalankan Discovery, ping, atau SNMP.</p>
        <form action={saveManualNetworkNodeAction} className="mt-5 grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-[repeat(4,minmax(0,1fr))]">
          <Field label="IPv4 address"><input className={control} inputMode="decimal" maxLength={15} name="ip_address" placeholder="192.168.1.20" required /></Field>
          <Field label="Name"><input className={control} maxLength={200} name="name" placeholder="Core switch" required /></Field>
          <Field label="Device type (optional)"><select className={control} defaultValue="" name="device_type"><option value="">Not specified</option>{NETWORK_NODE_TYPES.map((value) => <option key={value} value={value}>{networkNodeTypeLabel(value)}</option>)}</select></Field>
          <Field label="Location (optional)"><input className={control} maxLength={200} name="location" placeholder="Server room" /></Field>
          <div className="min-w-0 md:col-span-2 xl:col-span-3"><Field label="Notes (optional)"><textarea className={control} maxLength={2000} name="notes" rows={2} /></Field></div>
          <div className="flex items-end xl:justify-end"><Button className="w-full xl:w-auto" type="submit">Add device</Button></div>
        </form>
      </div> : null}

      <div className="mt-6 rounded-control border border-border bg-bg-surface p-4 text-text-secondary">
        <p className="font-medium text-text-primary">Import from Discovery</p>
        <p className="mt-1 text-meta">Discovery tetap manual dan on-demand. Perangkat yang ditemukan dapat disimpan lewat alur Save Identity yang sudah ada.</p>
        <Link className="mt-3 inline-flex text-meta font-medium text-accent hover:underline" href="/dashboard">Open on-demand Discovery</Link>
      </div>

      <div className="mt-8">
        <h2 className="text-section font-semibold">Devices</h2>
        <p className="mt-1 text-meta text-text-muted">Satu inventory untuk identitas perangkat dan konfigurasi Health Watch.</p>
        {nodes.length === 0 ? <div className="mt-4 rounded-control border border-border bg-bg-surface p-6 text-text-secondary">Belum ada device di inventory.</div> : (
          <div className="mt-4 overflow-x-auto rounded-control border border-border">
            <table className="w-full min-w-[980px] text-left">
              <thead className="bg-bg-surface text-meta text-text-secondary"><tr><th className="p-3">Device</th><th className="p-3">Type / location</th><th className="p-3">Observed identity</th><th className="p-3">Health Watch</th>{canManage ? <th className="p-3 text-right">Actions</th> : null}</tr></thead>
              <tbody>{nodes.map((node) => {
                const nodeTargets = targets.filter((target) => target.node_id === node.id);
                return <tr className="border-t border-border bg-bg-base align-top" key={node.id}>
                  <td className="p-3"><p className="font-medium">{node.name}</p><p className="mt-1 font-data text-meta text-text-muted">{node.ip_address}</p></td>
                  <td className="p-3 text-text-secondary"><p>{node.device_type ? networkNodeTypeLabel(node.device_type) : "-"}</p><p className="mt-1 text-meta text-text-muted">{node.location ?? "-"}</p></td>
                  <td className="p-3 text-text-secondary">{node.detected_fingerprint?.detected_identity.likely_label ?? "Not observed"}</td>
                  <td className="p-3"><HealthSummary targets={nodeTargets} runners={runners} /></td>
                  {canManage ? <td className="p-3"><div className="flex flex-wrap justify-end gap-2">
                    <Button variant="secondary" onClick={() => { setEditingNodeId(node.id); setHealthNodeId(null); }}>Edit device</Button>
                    <Button variant="secondary" onClick={() => openHealth(node.id)}>{nodeTargets.length ? "Manage Health Watch" : "Configure Health Watch"}</Button>
                    <form action={deleteNetworkNodeAction} onSubmit={(event) => {
                      if (!window.confirm(`Delete inventory device ${confirmationLabel(node)}? Remove Health Watch and SNMP configuration first. No unrelated history will be erased automatically.`)) event.preventDefault();
                    }}>
                      <input name="node_id" type="hidden" value={node.id} />
                      <input name="confirmation" type="hidden" value={confirmationLabel(node)} />
                      <Button type="submit" variant="destructive">Delete device</Button>
                    </form>
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
  return <div className="mt-6 rounded-panel border border-accent bg-bg-surface p-4 md:p-6">
    <div className="flex items-start justify-between gap-4"><div><p className="text-meta font-medium uppercase tracking-wide text-accent">Edit device</p><h3 className="mt-2 text-section font-semibold">{node.name}</h3><p className="mt-1 font-data text-meta text-text-muted">{node.ip_address}</p></div><Button variant="secondary" onClick={onClose}>Batal</Button></div>
    <form action={updateNetworkNodeAction} className="mt-5 grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-[repeat(4,minmax(0,1fr))]">
      <input name="node_id" type="hidden" value={node.id} />
      <Field label="Name"><input className={control} defaultValue={node.name} maxLength={200} name="name" required /></Field>
      <Field label="Device type"><select className={control} defaultValue={node.device_type ?? ""} name="device_type"><option value="">Not specified</option>{NETWORK_NODE_TYPES.map((value) => <option key={value} value={value}>{networkNodeTypeLabel(value)}</option>)}</select></Field>
      <Field label="Location"><input className={control} defaultValue={node.location ?? ""} maxLength={200} name="location" /></Field>
      <Field label="Notes"><textarea className={control} defaultValue={node.notes ?? ""} maxLength={2000} name="notes" rows={2} /></Field>
      <div className="md:col-span-2 xl:col-span-4 xl:text-right"><Button type="submit">Simpan perubahan</Button></div>
    </form>
  </div>;
}

function HealthWatchPanel({ node, runners, targets, editingTarget, onEdit, onClose }: { node: NetworkNode; runners: Runner[]; targets: DeviceHealthTarget[]; editingTarget?: DeviceHealthTarget; onEdit: (id: string | null) => void; onClose: () => void }) {
  return <section className="mt-6 rounded-panel border border-accent bg-bg-surface p-4 md:p-6" id="network-health-targets">
    <div className="flex items-start justify-between gap-4"><div><p className="text-meta font-medium uppercase tracking-wide text-accent">Network Health Watch</p><h3 className="mt-2 text-section font-semibold">{node.name}</h3><p className="mt-1 font-data text-meta text-text-muted">{node.ip_address}</p></div><Button variant="secondary" onClick={onClose}>Tutup</Button></div>
    <p className="mt-3 max-w-3xl text-text-secondary">Scheduled ICMP hanya berjalan melalui runner yang dipilih. Menghapus konfigurasi ini tidak menghapus device inventory, konfigurasi SNMP, telemetry, atau riwayat diagnostik.</p>
    {targets.length ? <div className="mt-5 grid gap-3">{targets.map((target) => <div className="flex flex-col gap-3 rounded-control border border-border bg-bg-base p-4 lg:flex-row lg:items-center lg:justify-between" key={target.id}>
      <HealthSummary targets={[target]} runners={runners} />
      <div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={() => onEdit(target.id)}>Edit</Button><form action={deleteNetworkTargetAction} onSubmit={(event) => {
        if (!window.confirm(`Remove Health Watch configuration for ${confirmationLabel(node)}? The inventory device and SNMP configuration will remain.`)) event.preventDefault();
      }}><input name="target_id" type="hidden" value={target.id} /><input name="confirmation" type="hidden" value={confirmationLabel(node)} /><Button type="submit" variant="destructive">Remove Health Watch</Button></form></div>
    </div>)}</div> : <p className="mt-5 rounded-control border border-border bg-bg-base p-4 text-text-muted">Not monitored</p>}
    {runners.length ? <div className="mt-6 border-t border-border pt-5"><h4 className="font-medium">{editingTarget ? "Edit Health Watch" : targets.length ? "Add another runner" : "Configure Health Watch"}</h4><TargetForm key={editingTarget?.id ?? `create-${targets.length}`} node={node} runners={runners} target={editingTarget} />{editingTarget ? <Button className="mt-3" variant="secondary" onClick={() => onEdit(null)}>Batal edit</Button> : null}</div> : <p className="mt-5 text-severity-medium">Diagnostic runner belum tersedia.</p>}
  </section>;
}

function HealthSummary({ targets, runners }: { targets: DeviceHealthTarget[]; runners: Runner[] }) {
  if (!targets.length) return <span className="text-text-muted">Not monitored</span>;
  return <div className="grid gap-2">{targets.map((target) => {
    const latest = relation(target.network_health_latest);
    const runner = runners.find((item) => item.id === target.runner_id);
    return <div key={target.id}><div className="flex flex-wrap items-center gap-2"><MonitoringState target={target} />{latest ? <span className="text-meta capitalize text-text-secondary">Latest: {latest.status}</span> : null}</div><p className="mt-1 text-meta text-text-muted">{runner?.display_name ?? target.runner_id} · {target.probe_interval_seconds}s cadence · {target.timeout_ms}ms timeout</p></div>;
  })}</div>;
}

function MonitoringState({ target }: { target: DeviceHealthTarget }) {
  return <span className={`inline-flex rounded-full px-3 py-1 text-meta font-medium ${target.enabled ? "bg-severity-low/10 text-severity-low" : "bg-text-muted/10 text-text-muted"}`}>{target.enabled ? "Enabled" : "Disabled"}{target.critical ? " · Critical" : ""}</span>;
}

function TargetForm({ node, runners, target }: { node: NetworkNode; runners: Runner[]; target?: DeviceHealthTarget }) {
  return <form action={saveNetworkTargetAction} className="mt-4 grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-[repeat(4,minmax(0,1fr))]">
    <input name="node_id" type="hidden" value={node.id} />
    <Field label="Inventory node"><div className="min-w-0 truncate rounded-control border border-border bg-bg-base px-3 py-2 text-text-primary" title={`${node.name} — ${node.ip_address}`}>{node.name} — {node.ip_address}</div></Field>
    <Field label="Runner"><select className={control} defaultValue={target?.runner_id ?? ""} disabled={Boolean(target)} name="runner_id" required><option disabled value="">Pilih runner</option>{runners.map((runner) => <option key={runner.id} value={runner.id}>{runner.display_name}</option>)}</select>{target ? <input name="runner_id" type="hidden" value={target.runner_id} /> : null}</Field>
    <NumberField label="Interval (seconds)" name="probe_interval_seconds" value={target?.probe_interval_seconds ?? 30} min={15} max={3600} />
    <NumberField label="Timeout (ms)" name="timeout_ms" value={target?.timeout_ms ?? 1000} min={250} max={5000} />
    <NumberField label="Failures → offline" name="failure_threshold" value={target?.failure_threshold ?? 3} min={2} max={10} />
    <NumberField label="Successes → recovery" name="recovery_threshold" value={target?.recovery_threshold ?? 2} min={1} max={5} />
    <NumberField label="Latency warning (ms)" name="latency_warning_ms" value={target?.latency_warning_ms ?? 100} min={1} max={60000} />
    <NumberField label="Loss warning (%)" name="loss_warning_percent" value={target?.loss_warning_percent ?? 40} min={0} max={100} />
    <label className="flex items-center gap-2"><input defaultChecked={target?.enabled ?? true} name="enabled" type="checkbox" /> Enabled</label>
    <label className="flex items-center gap-2"><input defaultChecked={target?.critical ?? false} name="critical" type="checkbox" /> Critical target</label>
    <div className="md:col-span-2 md:text-right"><Button type="submit">{target ? "Simpan perubahan" : "Tambahkan target"}</Button></div>
  </form>;
}

function DeviceFeedback({ notice, error }: { notice?: string; error?: string }) {
  const message = notice === "existing" ? "IP sudah ada di inventory. Data tersimpan dipakai kembali tanpa menimpa identitasnya." : notice === "updated" ? "Device berhasil diperbarui." : notice === "deleted" ? "Device berhasil dihapus dari inventory." : notice ? "Device berhasil ditambahkan ke inventory." : null;
  const failure = ({
    "invalid-request": "Permintaan device tidak valid.",
    "unknown-device": "Device tidak ditemukan atau konfirmasi tidak cocok.",
    "blocked-health": "Hapus konfigurasi Health Watch device ini terlebih dahulu.",
    "blocked-snmp": "Hapus konfigurasi Managed SNMP device ini terlebih dahulu.",
    "blocked-health-snmp": "Hapus konfigurasi Health Watch dan Managed SNMP device ini terlebih dahulu.",
    "dependency-check-failed": "Dependensi device tidak dapat diperiksa; device tidak dihapus.",
    "delete-failed": "Device gagal dihapus.",
  } as Record<string, string>)[error ?? ""] ?? (error ? "Device gagal disimpan. Coba lagi atau periksa policy akses." : null);
  return <>{message ? <p className="mt-4 text-severity-low" role="status">{message}</p> : null}{failure ? <p className="mt-4 text-severity-critical" role="alert">{failure}</p> : null}</>;
}

function HealthFeedback({ notice, error }: { notice?: string; error?: string }) {
  const success = notice === "deleted" ? "Konfigurasi Health Watch dihapus; inventory dan konfigurasi lain tetap ada." : notice ? "Konfigurasi Health Watch tersimpan." : null;
  const failure = ({
    "invalid-request": "Permintaan Health Watch tidak valid.",
    "unknown-target": "Target Health Watch tidak ditemukan atau konfirmasi tidak cocok.",
    "delete-failed": "Konfigurasi Health Watch gagal dihapus.",
  } as Record<string, string>)[error ?? ""] ?? (error ? "Konfigurasi Health Watch gagal disimpan. Periksa nilai dan policy akses." : null);
  return <>{success ? <p className="mt-4 text-severity-low" role="status">{success}</p> : null}{failure ? <p className="mt-4 text-severity-critical" role="alert">{failure}</p> : null}</>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="grid min-w-0 gap-2 text-meta text-text-secondary">{label}{children}</label>; }
function NumberField({ label, name, value, min, max }: { label: string; name: string; value: number; min: number; max: number }) { return <Field label={label}><input className={control} defaultValue={value} max={max} min={min} name={name} required step="1" type="number" /></Field>; }
function confirmationLabel(node: Pick<NetworkNode, "name" | "ip_address">) { return `${node.name} (${node.ip_address})`; }
function relation(value: DeviceHealthTarget["network_health_latest"]) { return Array.isArray(value) ? value[0] ?? null : value ?? null; }
const control = "min-w-0 w-full truncate rounded-control border border-border bg-bg-base px-3 py-2 text-body text-text-primary outline-none focus:border-accent";
