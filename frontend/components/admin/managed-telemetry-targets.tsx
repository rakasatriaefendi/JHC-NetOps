"use client";

import { useState } from "react";

import { saveManagedTelemetryTargetAction } from "@/app/actions/admin";
import { Button } from "@/components/ui/button";
import { credentialProfileStatus } from "@/lib/managed-telemetry";
import type { RunnerCapabilities } from "@/lib/diagnostic-jobs";

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
};

type Props = { nodes: Node[]; runners: Runner[]; targets: Target[]; notice?: string; error?: string };

export function ManagedTelemetryTargets({ nodes, runners, targets, notice, error }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const editingTarget = targets.find((target) => target.id === editingId);
  const ready = nodes.length > 0 && runners.length > 0;

  return (
    <section className="mt-12 border-t border-border pt-8" id="managed-telemetry">
      <p className="text-meta font-medium uppercase tracking-wide text-accent">Managed Infrastructure Telemetry</p>
      <h2 className="mt-2 text-heading font-semibold">SNMP read-only telemetry targets</h2>
      <p className="mt-2 max-w-3xl text-text-secondary">
        Aktifkan SNMP telemetry read-only untuk node inventory yang sudah dikenal. V1 memakai OID tetap, polling 30/60 detik, dan hanya menyimpan state terbaru per perangkat dan per antarmuka.
      </p>
      {notice ? <p className="mt-4 text-severity-low" role="status">Konfigurasi telemetry tersimpan.</p> : null}
      {error ? <p className="mt-4 text-severity-critical" role="alert">Konfigurasi telemetry gagal disimpan. Periksa nilai dan policy RLS.</p> : null}
      <div className="mt-4 rounded-control border border-border bg-bg-base p-4 text-meta text-text-secondary">
        Kredensial SNMP (community string, password auth/priv SNMPv3) dikonfigurasi <strong>lokal di runner</strong> lewat file config runner. Browser hanya menyimpan dan menampilkan referensi profile non-rahasia — kredensial tidak pernah diminta, ditampilkan, atau dikirim dari sini.
      </div>

      {ready ? (
        <div className="mt-6 rounded-panel border border-border bg-bg-surface p-4 md:p-6">
          <h3 className="text-section font-semibold">Tambah target telemetry</h3>
          <p className="mt-1 text-meta text-text-muted">Pilih node inventory dan runner, lalu pilih referensi profile kredensial lokal dan interval polling.</p>
          <TargetForm key={`create-${targets.length}`} nodes={nodes} runners={runners} />
        </div>
      ) : (
        <div className="mt-6 rounded-panel border border-severity-medium bg-bg-surface p-4 text-text-secondary">
          Butuh minimal satu network node dan satu diagnostic runner untuk konfigurasi telemetry.
        </div>
      )}

      <div className="mt-8">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div><h3 className="text-section font-semibold">Daftar target telemetry</h3><p className="mt-1 text-meta text-text-muted">{targets.length} target dikonfigurasi</p></div>
        </div>
        {targets.length === 0 ? (
          <div className="mt-4 rounded-control border border-border bg-bg-surface p-4 text-text-secondary">Belum ada target telemetry yang dikonfigurasi.</div>
        ) : (
          <>
            <div className="mt-4 hidden overflow-hidden rounded-control border border-border md:block">
              <table className="w-full text-left">
                <thead className="bg-bg-surface text-meta text-text-secondary"><tr><th className="p-3">Node</th><th className="p-3">Runner</th><th className="p-3">Telemetry</th><th className="p-3">SNMP</th><th className="p-3">Profile</th><th className="p-3">Threshold</th><th className="p-3 text-right">Action</th></tr></thead>
                <tbody>{targets.map((target) => <TargetRow key={target.id} target={target} node={nodes.find((node) => node.id === target.node_id)} runner={runners.find((runner) => runner.id === target.runner_id)} onEdit={() => setEditingId(target.id)} />)}</tbody>
              </table>
            </div>
            <div className="mt-4 grid gap-3 md:hidden">{targets.map((target) => <TargetCard key={target.id} target={target} node={nodes.find((node) => node.id === target.node_id)} runner={runners.find((runner) => runner.id === target.runner_id)} onEdit={() => setEditingId(target.id)} />)}</div>
          </>
        )}
      </div>

      {editingTarget ? (
        <div className="mt-6 rounded-panel border border-accent bg-bg-surface p-4 md:p-6">
          <div className="flex items-start justify-between gap-4"><div><p className="text-meta font-medium uppercase tracking-wide text-accent">Edit target telemetry</p><h3 className="mt-2 text-section font-semibold">{nodes.find((node) => node.id === editingTarget.node_id)?.name ?? "Unknown node"}</h3></div><Button variant="secondary" onClick={() => setEditingId(null)}>Batal</Button></div>
          <TargetForm nodes={nodes} runners={runners} target={editingTarget} />
        </div>
      ) : null}
    </section>
  );
}

function TargetRow({ target, node, runner, onEdit }: { target: Target; node?: Node; runner?: Runner; onEdit: () => void }) {
  const profile = credentialProfileStatus(runner?.capabilities?.snmp_telemetry?.credential_profiles, target.credential_profile_ref);
  return <tr className="border-t border-border bg-bg-base"><td className="p-3"><p className="font-medium">{node?.name ?? "Unknown node"}</p><p className="mt-1 font-data text-meta text-text-muted">{node?.ip_address ?? "—"}{node?.location ? ` · ${node.location}` : ""}</p></td><td className="p-3 text-text-secondary">{runner?.display_name ?? target.runner_id}</td><td className="p-3"><TelemetryState target={target} /></td><td className="p-3 font-data text-meta">SNMPv{target.snmp_version} · {target.snmp_port} · {target.poll_interval_seconds}s</td><td className="p-3 text-meta"><p className="font-data">{target.credential_profile_ref}</p><ProfileState profile={profile} /></td><td className="p-3 text-meta text-text-secondary">Errors {target.oper_error_threshold} · discards {target.discard_threshold}<br />util {target.util_warning_percent}%/{target.util_critical_percent}% · {target.util_sustained_seconds}s</td><td className="p-3 text-right"><Button variant="secondary" onClick={onEdit}>Edit</Button></td></tr>;
}

function TargetCard({ target, node, runner, onEdit }: { target: Target; node?: Node; runner?: Runner; onEdit: () => void }) {
  const profile = credentialProfileStatus(runner?.capabilities?.snmp_telemetry?.credential_profiles, target.credential_profile_ref);
  return <article className="rounded-control border border-border bg-bg-surface p-4"><div className="flex items-start justify-between gap-3"><div><h4 className="font-medium">{node?.name ?? "Unknown node"}</h4><p className="mt-1 font-data text-meta text-text-secondary">{node?.ip_address ?? "—"}</p></div><TelemetryState target={target} /></div><dl className="mt-4 grid grid-cols-2 gap-3 text-meta"><div><dt className="text-text-muted">Runner</dt><dd className="mt-1 text-text-secondary">{runner?.display_name ?? target.runner_id}</dd></div><div><dt className="text-text-muted">SNMP</dt><dd className="mt-1 font-data">v{target.snmp_version} · {target.poll_interval_seconds}s</dd></div><div className="col-span-2"><dt className="text-text-muted">Credential profile</dt><dd className="mt-1 flex flex-wrap items-center gap-2 font-data">{target.credential_profile_ref} <ProfileState profile={profile} /></dd></div></dl><Button className="mt-4 w-full" variant="secondary" onClick={onEdit}>Edit target</Button></article>;
}

function TelemetryState({ target }: { target: Target }) {
  return <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-meta font-medium ${target.enabled ? "bg-severity-low/10 text-severity-low" : "bg-text-muted/10 text-text-muted"}`}>● {target.enabled ? "Enabled" : "Disabled"}</span>;
}

function ProfileState({ profile }: { profile: "available" | "unavailable" | "unknown" }) {
  if (profile === "available") return <span className="text-severity-low">Profile tersedia di runner</span>;
  if (profile === "unavailable") return <span className="text-severity-medium">Credential profile unavailable</span>;
  return <span className="text-text-muted">Availability unknown</span>;
}

function TargetForm({ nodes, runners, target }: { nodes: Node[]; runners: Runner[]; target?: Target }) {
  const [runnerId, setRunnerId] = useState(target?.runner_id ?? "");
  const [profileRef, setProfileRef] = useState(target?.credential_profile_ref ?? "");
  const selectedRunner = runners.find((runner) => runner.id === runnerId);
  const profile = credentialProfileStatus(selectedRunner?.capabilities?.snmp_telemetry?.credential_profiles, profileRef.trim());

  return <form action={saveManagedTelemetryTargetAction} className="mt-5 grid gap-4 md:grid-cols-4">
    <Field label="Inventory node"><select className={control} defaultValue={target?.node_id ?? ""} disabled={Boolean(target)} name="node_id" required><option disabled value="">Pilih inventory node</option>{nodes.map((node) => <option key={node.id} value={node.id}>{node.name} — {node.ip_address}</option>)}</select>{target ? <input name="node_id" type="hidden" value={target.node_id} /> : null}</Field>
    <Field label="Runner"><select className={control} value={runnerId} onChange={(event) => setRunnerId(event.target.value)} disabled={Boolean(target)} name="runner_id" required><option disabled value="">Pilih runner</option>{runners.map((runner) => <option key={runner.id} value={runner.id}>{runner.display_name}</option>)}</select>{target ? <input name="runner_id" type="hidden" value={target.runner_id} /> : null}</Field>
    <Field label="SNMP version"><select className={control} defaultValue={target?.snmp_version ?? "3"} name="snmp_version"><option value="3">SNMPv3</option><option value="2c">SNMPv2c</option></select></Field>
    <Field label="SNMP port"><input className={control} defaultValue={target?.snmp_port ?? 161} max={65535} min={1} name="snmp_port" required step="1" type="number" /></Field>
    <Field label="Polling interval"><select className={control} defaultValue={target?.poll_interval_seconds ?? 60} name="poll_interval_seconds"><option value="30">30 detik</option><option value="60">60 detik</option></select></Field>
    <div className="md:col-span-3"><Field label="Credential profile reference (nama profile lokal di runner)"><input className={control} value={profileRef} onChange={(event) => setProfileRef(event.target.value)} maxLength={64} name="credential_profile_ref" pattern="[a-z0-9][a-z0-9_-]{0,63}" placeholder="mis. monitoring-readonly-v3" required /></Field>
      <p className="mt-1 text-meta">{profile === "available" ? <span className="text-severity-low">Profile tersedia di runner terpilih.</span> : profile === "unavailable" ? <span className="text-severity-medium">Credential profile unavailable — pastikan profile tersebut ada di config lokal runner.</span> : <span className="text-text-muted">Status ketersediaan profile muncul setelah runner dipilih.</span>}</p>
    </div>
    <NumberField label="Error threshold (delta/poll)" name="oper_error_threshold" value={target?.oper_error_threshold ?? 5} min={1} max={100} />
    <NumberField label="Discard threshold (delta/poll)" name="discard_threshold" value={target?.discard_threshold ?? 10} min={1} max={100} />
    <NumberField label="Util warning (%)" name="util_warning_percent" value={Number(target?.util_warning_percent ?? 80)} min={1} max={100} />
    <NumberField label="Util critical (%)" name="util_critical_percent" value={Number(target?.util_critical_percent ?? 95)} min={1} max={100} />
    <NumberField label="Sustained util (seconds)" name="util_sustained_seconds" value={target?.util_sustained_seconds ?? 300} min={60} max={3600} />
    <label className="flex items-center gap-2"><input defaultChecked={target?.enabled ?? true} name="enabled" type="checkbox" /> Enabled</label>
    <div className="md:col-span-3 md:text-right"><button className="rounded-control border border-accent bg-accent px-4 py-2 font-medium text-bg-base" type="submit">{target ? "Simpan perubahan" : "Tambahkan target"}</button></div>
  </form>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="grid gap-2 text-meta text-text-secondary">{label}{children}</label>; }
function NumberField({ label, name, value, min, max }: { label: string; name: string; value: number; min: number; max: number }) { return <Field label={label}><input className={control} defaultValue={value} max={max} min={min} name={name} required step="1" type="number" /></Field>; }
const control = "rounded-control border border-border bg-bg-base px-3 py-2 text-body text-text-primary outline-none focus:border-accent";