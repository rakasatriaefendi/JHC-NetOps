"use client";

import { useState } from "react";

import { saveNetworkTargetAction } from "@/app/actions/devices";
import { Button } from "@/components/ui/button";

type Node = { id: string; name: string; ip_address: string; location: string | null };
type Runner = { id: string; display_name: string };
type Target = {
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
};

type Props = {
  nodes: Node[];
  runners: Runner[];
  targets: Target[];
  canManage: boolean;
  notice?: string;
  error?: string;
};

export function NetworkHealthTargets({ nodes, runners, targets, canManage, notice, error }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const editingTarget = targets.find((target) => target.id === editingId);
  const ready = nodes.length > 0 && runners.length > 0;

  return (
    <section className="mt-12 border-t border-border pt-8" id="network-health-targets">
      <p className="text-meta font-medium uppercase tracking-wide text-accent">Network Health Watch</p>
      <h2 className="mt-2 text-heading font-semibold">Known monitoring targets</h2>
      <p className="mt-2 max-w-3xl text-text-secondary">
        Scheduled ICMP hanya berjalan untuk node inventory yang sudah diotorisasi. Tidak ada subnet scan dari halaman ini.
      </p>
      {notice ? <p className="mt-4 text-severity-low" role="status">Konfigurasi target tersimpan.</p> : null}
      {error ? <p className="mt-4 text-severity-critical" role="alert">Konfigurasi target gagal disimpan. Periksa nilai dan policy RLS.</p> : null}

      {canManage ? (
        ready ? (
          <div className="mt-6 rounded-panel border border-border bg-bg-surface p-4 md:p-6">
            <h3 className="text-section font-semibold">Tambah target monitoring</h3>
            <p className="mt-1 text-meta text-text-muted">Pilih node inventory dan runner, lalu sesuaikan threshold bila diperlukan.</p>
            <TargetForm key={`create-${targets.length}`} nodes={nodes} runners={runners} />
          </div>
        ) : (
          <div className="mt-6 rounded-panel border border-severity-medium bg-bg-surface p-4 text-text-secondary">
            Butuh minimal satu network node dan satu diagnostic runner.
          </div>
        )
      ) : null}

      <div className="mt-8">
        <h3 className="text-section font-semibold">Daftar target</h3>
        <p className="mt-1 text-meta text-text-muted">{targets.length} target dikonfigurasi</p>
        {targets.length === 0 ? (
          <div className="mt-4 rounded-control border border-border bg-bg-surface p-4 text-text-secondary">Belum ada target yang dikonfigurasi.</div>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-control border border-border">
            <table className="w-full min-w-[760px] text-left">
              <thead className="bg-bg-surface text-meta text-text-secondary">
                <tr><th className="p-3">Target</th><th className="p-3">Runner</th><th className="p-3">Monitoring</th><th className="p-3">Cadence</th><th className="p-3">Threshold</th>{canManage ? <th className="p-3 text-right">Action</th> : null}</tr>
              </thead>
              <tbody>
                {targets.map((target) => {
                  const node = nodes.find((item) => item.id === target.node_id);
                  const runner = runners.find((item) => item.id === target.runner_id);
                  return (
                    <tr className="border-t border-border bg-bg-base" key={target.id}>
                      <td className="p-3"><p className="font-medium">{node?.name ?? "Unknown node"}</p><p className="mt-1 font-data text-meta text-text-muted">{node?.ip_address ?? "—"}{node?.location ? ` · ${node.location}` : ""}</p></td>
                      <td className="p-3 text-text-secondary">{runner?.display_name ?? target.runner_id}</td>
                      <td className="p-3"><MonitoringState target={target} /></td>
                      <td className="p-3 font-data text-meta">{target.probe_interval_seconds}s · {target.timeout_ms}ms timeout</td>
                      <td className="p-3 text-meta text-text-secondary">Offline {target.failure_threshold}x · recovery {target.recovery_threshold}x<br />Latency {target.latency_warning_ms}ms · loss {target.loss_warning_percent}%</td>
                      {canManage ? <td className="p-3 text-right"><Button variant="secondary" onClick={() => setEditingId(target.id)}>Edit</Button></td> : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {canManage && editingTarget ? (
        <div className="mt-6 rounded-panel border border-accent bg-bg-surface p-4 md:p-6">
          <div className="flex items-start justify-between gap-4">
            <div><p className="text-meta font-medium uppercase tracking-wide text-accent">Edit target</p><h3 className="mt-2 text-section font-semibold">{nodes.find((node) => node.id === editingTarget.node_id)?.name ?? "Unknown node"}</h3></div>
            <Button variant="secondary" onClick={() => setEditingId(null)}>Batal</Button>
          </div>
          <TargetForm nodes={nodes} runners={runners} target={editingTarget} />
        </div>
      ) : null}
    </section>
  );
}

function MonitoringState({ target }: { target: Target }) {
  return <span className={`inline-flex rounded-full px-3 py-1 text-meta font-medium ${target.enabled ? "bg-severity-low/10 text-severity-low" : "bg-text-muted/10 text-text-muted"}`}>{target.enabled ? "Enabled" : "Disabled"}{target.critical ? " · Critical" : ""}</span>;
}

function TargetForm({ nodes, runners, target }: { nodes: Node[]; runners: Runner[]; target?: Target }) {
  return <form action={saveNetworkTargetAction} className="mt-5 grid gap-4 md:grid-cols-4">
    <Field label="Inventory node"><select className={control} defaultValue={target?.node_id ?? ""} disabled={Boolean(target)} name="node_id" required><option disabled value="">Pilih inventory node</option>{nodes.map((node) => <option key={node.id} value={node.id}>{node.name} — {node.ip_address}</option>)}</select>{target ? <input name="node_id" type="hidden" value={target.node_id} /> : null}</Field>
    <Field label="Runner"><select className={control} defaultValue={target?.runner_id ?? ""} disabled={Boolean(target)} name="runner_id" required><option disabled value="">Pilih runner</option>{runners.map((runner) => <option key={runner.id} value={runner.id}>{runner.display_name}</option>)}</select>{target ? <input name="runner_id" type="hidden" value={target.runner_id} /> : null}</Field>
    <NumberField label="Interval (seconds)" name="probe_interval_seconds" value={target?.probe_interval_seconds ?? 30} min={15} max={3600} />
    <NumberField label="Timeout (ms)" name="timeout_ms" value={target?.timeout_ms ?? 1000} min={250} max={5000} />
    <NumberField label="Failures → offline" name="failure_threshold" value={target?.failure_threshold ?? 3} min={2} max={10} />
    <NumberField label="Successes → recovery" name="recovery_threshold" value={target?.recovery_threshold ?? 2} min={1} max={5} />
    <NumberField label="Latency warning (ms)" name="latency_warning_ms" value={target?.latency_warning_ms ?? 100} min={1} max={60000} />
    <NumberField label="Loss warning (%)" name="loss_warning_percent" value={target?.loss_warning_percent ?? 40} min={0} max={100} />
    <label className="flex items-center gap-2"><input defaultChecked={target?.enabled ?? true} name="enabled" type="checkbox" /> Enabled</label>
    <label className="flex items-center gap-2"><input defaultChecked={target?.critical ?? false} name="critical" type="checkbox" /> Critical target</label>
    <div className="md:col-span-2 md:text-right"><button className="rounded-control border border-accent bg-accent px-4 py-2 font-medium text-bg-base" type="submit">{target ? "Simpan perubahan" : "Tambahkan target"}</button></div>
  </form>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="grid gap-2 text-meta text-text-secondary">{label}{children}</label>; }
function NumberField({ label, name, value, min, max }: { label: string; name: string; value: number; min: number; max: number }) { return <Field label={label}><input className={control} defaultValue={value} max={max} min={min} name={name} required step="1" type="number" /></Field>; }
const control = "rounded-control border border-border bg-bg-base px-3 py-2 text-body text-text-primary outline-none focus:border-accent";
