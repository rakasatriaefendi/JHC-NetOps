"use client";

import Link from "next/link";
import { useState } from "react";

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
  const [editingId, setEditingId] = useState<string | null>(null);
  const editingTarget = targets.find((target) => target.id === editingId);

  return (
    <section className="mt-12 border-t border-border pt-8" id="managed-telemetry">
      <p className="text-meta font-medium uppercase tracking-wide text-accent">Managed Infrastructure Telemetry</p>
      <h2 className="mt-2 text-heading font-semibold">SNMP read-only telemetry targets</h2>
      <p className="mt-2 max-w-3xl text-text-secondary">SYSTEM-MIB dan IF-MIB terbatas untuk inventory yang dikenal. Browser hanya menyimpan referensi profile non-rahasia.</p>
      {notice ? <p className="mt-4 text-severity-low" role="status">{notice === "deleted" ? "Target Managed SNMP dihapus; inventory dan Health Watch tetap ada." : "Konfigurasi telemetry tersimpan."}</p> : null}
      {error ? <p className="mt-4 text-severity-critical" role="alert">Konfigurasi telemetry gagal: {telemetryError(error)}</p> : null}
      <div className="mt-4 rounded-control border border-border bg-bg-base p-4 text-meta text-text-secondary">
        Community string dan password SNMP tetap hanya di konfigurasi lokal runner; halaman ini tidak menerima atau menampilkannya.
      </div>

      {canManage ? (
        nodes.length > 0 && runners.length > 0 ? (
          <div className="mt-6 rounded-panel border border-border bg-bg-surface p-4 md:p-6">
            <h3 className="text-section font-semibold">Tambah target telemetry</h3>
            <p className="mt-1 text-meta text-text-muted">Pilih node inventory. Untuk IP baru, <Link className="text-accent hover:underline" href="/devices#add-device">tambahkan device terlebih dahulu</Link>.</p>
            <TargetForm key={`create-${targets.length}`} nodes={nodes} runners={runners} />
          </div>
        ) : (
          <div className="mt-6 rounded-panel border border-severity-medium bg-bg-surface p-4 text-text-secondary">Butuh minimal satu network node dan satu diagnostic runner.</div>
        )
      ) : null}

      <div className="mt-8">
        <h3 className="text-section font-semibold">Managed devices</h3>
        <p className="mt-1 text-meta text-text-muted">{targets.length} target dikonfigurasi</p>
        {targets.length === 0 ? (
          <div className="mt-4 rounded-control border border-border bg-bg-surface p-4 text-text-secondary">Belum ada target telemetry yang dikonfigurasi.</div>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-control border border-border">
            <table className="w-full min-w-[920px] text-left">
              <thead className="bg-bg-surface text-meta text-text-secondary"><tr><th className="p-3">Node</th><th className="p-3">Runner</th><th className="p-3">Status</th><th className="p-3">SNMP</th><th className="p-3">Profile reference</th><th className="p-3">Latest poll</th>{canManage ? <th className="p-3 text-right">Action</th> : null}</tr></thead>
              <tbody>{targets.map((target) => {
                const node = nodes.find((item) => item.id === target.node_id);
                const runner = runners.find((item) => item.id === target.runner_id);
                const profile = credentialProfileStatus(runner?.capabilities?.snmp_telemetry?.credential_profiles, target.credential_profile_ref);
                return <tr className="border-t border-border bg-bg-base" key={target.id}>
                  <td className="p-3"><p className="font-medium">{node?.name ?? "Unknown node"}</p><p className="mt-1 font-data text-meta text-text-muted">{node?.ip_address ?? "-"}{node?.location ? ` · ${node.location}` : ""}</p></td>
                  <td className="p-3 text-text-secondary">{runner?.display_name ?? target.runner_id}</td>
                  <td className="p-3"><State enabled={target.enabled} />{target.latest ? <p className="mt-1 text-meta text-text-secondary">{target.latest.status}</p> : null}</td>
                  <td className="p-3 font-data text-meta">v{target.snmp_version} · TCP/UDP {target.snmp_port}<br />{target.poll_interval_seconds}s cadence</td>
                  <td className="p-3 text-meta"><p className="font-data">{target.credential_profile_ref}</p><ProfileState profile={profile} /></td>
                  <td className="p-3 font-data text-meta">{formatDateTime(target.latest?.last_polled_at ?? null)}</td>
                  {canManage ? <td className="p-3"><div className="flex flex-wrap justify-end gap-2"><Button variant="secondary" onClick={() => setEditingId(target.id)}>Edit</Button><form action={deleteManagedTelemetryTargetAction} onSubmit={(event) => {
                    const label = `${node?.name ?? "Unknown node"} (${node?.ip_address ?? "unknown IP"})`;
                    if (!window.confirm(`Delete Managed SNMP target ${label}? The inventory device, Health Watch configuration, and unrelated history will remain.`)) event.preventDefault();
                  }}><input name="target_id" type="hidden" value={target.id} /><input name="confirmation" type="hidden" value={`${node?.name ?? ""} (${node?.ip_address ?? ""})`} /><Button type="submit" variant="destructive">Delete</Button></form></div></td> : null}
                </tr>;
              })}</tbody>
            </table>
          </div>
        )}
      </div>

      {canManage && editingTarget ? <div className="mt-6 rounded-panel border border-accent bg-bg-surface p-4 md:p-6">
        <div className="flex items-start justify-between gap-4"><div><p className="text-meta font-medium uppercase tracking-wide text-accent">Edit telemetry target</p><h3 className="mt-2 text-section font-semibold">{nodes.find((node) => node.id === editingTarget.node_id)?.name ?? "Unknown node"}</h3></div><Button variant="secondary" onClick={() => setEditingId(null)}>Batal</Button></div>
        <TargetForm nodes={nodes} runners={runners} target={editingTarget} />
      </div> : null}
    </section>
  );
}

function State({ enabled }: { enabled: boolean }) { return <span className={`inline-flex rounded-full px-3 py-1 text-meta font-medium ${enabled ? "bg-severity-low/10 text-severity-low" : "bg-text-muted/10 text-text-muted"}`}>{enabled ? "Enabled" : "Disabled"}</span>; }
function ProfileState({ profile }: { profile: "available" | "unavailable" | "unknown" }) {
  if (profile === "available") return <span className="text-severity-low">Available on runner</span>;
  if (profile === "unavailable") return <span className="text-severity-medium">Unavailable on runner</span>;
  return <span className="text-text-muted">Availability unknown</span>;
}

function TargetForm({ nodes, runners, target }: { nodes: Node[]; runners: Runner[]; target?: Target }) {
  const [runnerId, setRunnerId] = useState(target?.runner_id ?? "");
  const [profileRef, setProfileRef] = useState(target?.credential_profile_ref ?? "");
  const selectedRunner = runners.find((runner) => runner.id === runnerId);
  const profile = credentialProfileStatus(selectedRunner?.capabilities?.snmp_telemetry?.credential_profiles, profileRef.trim());
  return <form action={saveManagedTelemetryTargetAction} className="mt-5 grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-[repeat(4,minmax(0,1fr))]">
    <Field label="Inventory node"><select className={control} defaultValue={target?.node_id ?? ""} disabled={Boolean(target)} name="node_id" required title="Pilih inventory node"><option disabled value="">Pilih inventory node</option>{nodes.map((node) => <option key={node.id} value={node.id}>{node.name} — {node.ip_address}</option>)}</select>{target ? <input name="node_id" type="hidden" value={target.node_id} /> : null}</Field>
    <Field label="Runner"><select className={control} value={runnerId} onChange={(event) => setRunnerId(event.target.value)} disabled={Boolean(target)} name="runner_id" required><option disabled value="">Pilih runner</option>{runners.map((runner) => <option key={runner.id} value={runner.id}>{runner.display_name}</option>)}</select>{target ? <input name="runner_id" type="hidden" value={target.runner_id} /> : null}</Field>
    <Field label="SNMP version"><select className={control} defaultValue={target?.snmp_version ?? "3"} name="snmp_version"><option value="3">SNMPv3</option><option value="2c">SNMPv2c</option></select></Field>
    <Field label="SNMP port"><input className={control} defaultValue={target?.snmp_port ?? 161} max={65535} min={1} name="snmp_port" required step="1" type="number" /></Field>
    <Field label="Polling interval"><select className={control} defaultValue={target?.poll_interval_seconds ?? 60} name="poll_interval_seconds"><option value="30">30 detik</option><option value="60">60 detik</option></select></Field>
    <div className="md:col-span-3"><Field label="Credential profile reference"><input className={control} value={profileRef} onChange={(event) => setProfileRef(event.target.value)} maxLength={64} name="credential_profile_ref" pattern="[a-z0-9][a-z0-9_-]{0,63}" required /></Field><p className="mt-1 text-meta">{profile === "available" ? <span className="text-severity-low">Profile tersedia di runner terpilih.</span> : profile === "unavailable" ? <span className="text-severity-medium">Profile tidak tersedia di runner terpilih.</span> : <span className="text-text-muted">Pilih runner dan isi nama profile untuk memeriksa availability.</span>}</p></div>
    <NumberField label="Error threshold" name="oper_error_threshold" value={target?.oper_error_threshold ?? 5} min={1} max={100} />
    <NumberField label="Discard threshold" name="discard_threshold" value={target?.discard_threshold ?? 10} min={1} max={100} />
    <NumberField label="Util warning (%)" name="util_warning_percent" value={target?.util_warning_percent ?? 80} min={1} max={100} />
    <NumberField label="Util critical (%)" name="util_critical_percent" value={target?.util_critical_percent ?? 95} min={1} max={100} />
    <NumberField label="Sustained util (seconds)" name="util_sustained_seconds" value={target?.util_sustained_seconds ?? 300} min={60} max={3600} />
    <label className="flex items-center gap-2"><input defaultChecked={target?.enabled ?? true} name="enabled" type="checkbox" /> Enabled</label>
    <div className="md:col-span-3 md:text-right"><button className="rounded-control border border-accent bg-accent px-4 py-2 font-medium text-bg-base" type="submit">{target ? "Simpan perubahan" : "Tambahkan target"}</button></div>
  </form>;
}

function telemetryError(value: string) {
  if (value === "portable-read-only") return "Portable Development Mode bersifat read-only.";
  if (value === "profile-unavailable") return "credential profile tidak tersedia di runner terpilih.";
  if (value === "unknown-target") return "target tidak ditemukan atau konfirmasi tidak cocok.";
  if (value === "delete-failed") return "target gagal dihapus.";
  if (value === "invalid-fields" || value === "invalid-form") return "payload atau nilai form tidak valid.";
  return "periksa nilai dan policy akses.";
}
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="grid min-w-0 gap-2 text-meta text-text-secondary">{label}{children}</label>; }
function NumberField({ label, name, value, min, max }: { label: string; name: string; value: number; min: number; max: number }) { return <Field label={label}><input className={control} defaultValue={value} max={max} min={min} name={name} required step="1" type="number" /></Field>; }
const control = "min-w-0 w-full truncate rounded-control border border-border bg-bg-base px-3 py-2 text-body text-text-primary outline-none focus:border-accent";
