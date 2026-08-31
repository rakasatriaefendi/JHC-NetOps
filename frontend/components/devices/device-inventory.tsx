import Link from "next/link";

import { saveManualNetworkNodeAction } from "@/app/actions/devices";
import {
  NETWORK_NODE_TYPES,
  networkNodeTypeLabel,
  type NetworkNode,
} from "@/lib/network-nodes";

type Props = {
  nodes: NetworkNode[];
  canManage: boolean;
  notice?: string;
  error?: string;
};

export function DeviceInventory({ nodes, canManage, notice, error }: Props) {
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

      {notice ? <p className="mt-4 text-severity-low" role="status">{notice === "existing" ? "IP sudah ada di inventory. Data yang tersimpan dipakai kembali tanpa menimpa identitasnya." : "Device berhasil ditambahkan ke inventory."}</p> : null}
      {error ? <p className="mt-4 text-severity-critical" role="alert">{error === "invalid-request" ? "Masukkan satu alamat IPv4 host yang valid; subnet, range, dan CIDR tidak diterima." : "Device gagal disimpan. Coba lagi atau periksa policy akses."}</p> : null}

      {canManage ? <div className="mt-6 rounded-panel border border-border bg-bg-surface p-4 md:p-6" id="add-device">
        <h2 className="text-section font-semibold">Add device manually</h2>
        <p className="mt-1 text-meta text-text-muted">Menyimpan satu IP sebagai inventory node tidak menjalankan Discovery, ping, atau SNMP.</p>
        <form action={saveManualNetworkNodeAction} className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Field label="IPv4 address"><input className={control} inputMode="decimal" maxLength={15} name="ip_address" placeholder="192.168.1.20" required /></Field>
          <Field label="Name"><input className={control} maxLength={200} name="name" placeholder="Core switch" required /></Field>
          <Field label="Device type (optional)"><select className={control} defaultValue="" name="device_type"><option value="">Not specified</option>{NETWORK_NODE_TYPES.map((value) => <option key={value} value={value}>{networkNodeTypeLabel(value)}</option>)}</select></Field>
          <Field label="Location (optional)"><input className={control} maxLength={200} name="location" placeholder="Server room" /></Field>
          <div className="md:col-span-2 xl:col-span-3"><Field label="Notes (optional)"><textarea className={control} maxLength={2000} name="notes" rows={2} /></Field></div>
          <div className="flex items-end xl:justify-end"><button className="w-full rounded-control border border-accent bg-accent px-4 py-2 font-medium text-bg-base xl:w-auto" type="submit">Add device</button></div>
        </form>
      </div> : null}

      <div className="mt-6 rounded-control border border-border bg-bg-surface p-4 text-text-secondary">
        <p className="font-medium text-text-primary">Import from Discovery</p>
        <p className="mt-1 text-meta">Discovery tetap manual dan on-demand. Perangkat yang ditemukan dapat disimpan lewat alur Save Identity yang sudah ada.</p>
        <Link className="mt-3 inline-flex text-meta font-medium text-accent hover:underline" href="/dashboard">Open on-demand Discovery</Link>
      </div>

      <div className="mt-8">
        <h2 className="text-section font-semibold">Known inventory</h2>
        {nodes.length === 0 ? <div className="mt-4 rounded-control border border-border bg-bg-surface p-6 text-text-secondary">Belum ada device di inventory.</div> : <>
          <div className="mt-4 hidden overflow-x-auto rounded-control border border-border md:block">
            <table className="w-full min-w-[760px] text-left">
              <thead className="bg-bg-surface text-meta text-text-secondary"><tr><th className="p-3">Device</th><th className="p-3">IP address</th><th className="p-3">Type</th><th className="p-3">Location</th><th className="p-3">Observed identity</th></tr></thead>
              <tbody>{nodes.map((node) => <tr className="border-t border-border bg-bg-base" key={node.id}><td className="p-3 font-medium">{node.name}</td><td className="p-3 font-data text-meta">{node.ip_address}</td><td className="p-3 text-text-secondary">{node.device_type ? networkNodeTypeLabel(node.device_type) : "—"}</td><td className="p-3 text-text-secondary">{node.location ?? "—"}</td><td className="p-3 text-text-secondary">{node.detected_fingerprint?.detected_identity.likely_label ?? "Not observed"}</td></tr>)}</tbody>
            </table>
          </div>
          <div className="mt-4 grid gap-3 md:hidden">{nodes.map((node) => <article className="rounded-control border border-border bg-bg-surface p-4" key={node.id}><div className="flex items-start justify-between gap-3"><h3 className="font-medium">{node.name}</h3><span className="font-data text-meta text-accent">{node.ip_address}</span></div><dl className="mt-4 grid grid-cols-2 gap-3 text-meta"><Item label="Type">{node.device_type ? networkNodeTypeLabel(node.device_type) : "—"}</Item><Item label="Location">{node.location ?? "—"}</Item><div className="col-span-2"><Item label="Observed identity">{node.detected_fingerprint?.detected_identity.likely_label ?? "Not observed"}</Item></div></dl></article>)}</div>
        </>}
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="grid gap-2 text-meta text-text-secondary">{label}{children}</label>; }
function Item({ label, children }: { label: string; children: React.ReactNode }) { return <div><dt className="text-text-muted">{label}</dt><dd className="mt-1 text-text-secondary">{children}</dd></div>; }
const control = "w-full rounded-control border border-border bg-bg-base px-3 py-2 text-body text-text-primary outline-none focus:border-accent";
