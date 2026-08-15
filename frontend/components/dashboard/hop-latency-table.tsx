"use client";

import { useState } from "react";

import { useNetworkNodes } from "@/components/diagnostics/network-nodes-provider";
import { Button } from "@/components/ui/button";
import {
  groupHopMeasurementSessions,
  type DiagnosticSortOrder,
  type HopMeasurement,
} from "@/lib/diagnostics";
import {
  NETWORK_NODE_TYPES,
  findNetworkNode,
  networkNodeDisplayName,
  networkNodeTypeLabel,
  normalizeNetworkNodeIp,
  type NetworkNode,
  type NetworkNodeInput,
  type NetworkNodeType,
} from "@/lib/network-nodes";

const MAX_SESSIONS = 3;

type HopLatencyTableProps = {
  measurements: HopMeasurement[];
  sortOrder?: DiagnosticSortOrder;
  sourceIp?: string | null;
  collapsible?: boolean;
};

export function HopLatencyTable({
  measurements,
  sortOrder = "newest",
  sourceIp,
  collapsible = false,
}: HopLatencyTableProps) {
  const { loadError } = useNetworkNodes();
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);
  const sessions = groupHopMeasurementSessions(measurements, sortOrder).slice(0, MAX_SESSIONS);

  if (sessions.length === 0) {
    return (
      <div className="rounded-control border border-border bg-bg-base p-4">
        <p className="font-medium">Belum ada pengukuran path</p>
        <p className="mt-2 text-text-secondary">
          Jalankan command <span className="font-data">path-test</span> secara on-demand.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      {loadError ? (
        <div className="rounded-control border border-severity-medium bg-bg-base p-4 text-body text-text-secondary">
          Label network node gagal dimuat; hop faktual tetap ditampilkan berdasarkan hasil MTR.
        </div>
      ) : null}
      {sessions.map((session) => (
        <article
          className="overflow-hidden rounded-control border border-border bg-bg-base"
          key={session.sessionId}
        >
          <header className={`${!collapsible || expandedSessionId === session.sessionId ? "border-b border-border" : ""} p-4`}>
            <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
              <div>
                <h3 className="text-body font-medium">
                  {session.sourceLabel ?? "Source legacy"} → {session.targetLabel ?? "Target legacy"}
                </h3>
                <p className="mt-1 text-meta text-text-secondary">
                  {formatConnection(session.connectionType)} ·{" "}
                  <span className="font-data">
                    {session.targetHost ?? "target asli tidak tercatat"}
                  </span>
                  {session.environment === "localhost_demo" ? " · TEST ENVIRONMENT" : ""}
                </p>
                <p className="mt-1 font-data text-meta text-text-muted">
                  sesi {session.sessionId.slice(0, 8)}
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-start gap-3 md:items-end"><time className="font-data text-meta text-text-muted">{formatTimestamp(session.measuredAt)}</time>{collapsible ? <Button variant="secondary" onClick={() => setExpandedSessionId((current) => current === session.sessionId ? null : session.sessionId)}>{expandedSessionId === session.sessionId ? "Tutup detail" : "Lihat path"}</Button> : null}</div>
            </div>
          </header>

          {!collapsible || expandedSessionId === session.sessionId ? <div className="grid p-4 md:p-6">
            <EndpointCard
              eyebrow="Source"
              name={session.sourceLabel ?? "Source legacy"}
              address={sourceIp ?? null}
            />
            <PathArrow />
            {session.hops.map((hop) => {
              const isTarget = sameIp(hop.hop_ip, session.targetHost);
              return (
                <div key={hop.id}>
                  <ObservedHop
                    hop={hop}
                    isTarget={isTarget}
                    targetLabel={session.targetLabel}
                  />
                  <PathArrow />
                </div>
              );
            })}
            {!session.hops.some((hop) => sameIp(hop.hop_ip, session.targetHost)) ? (
              <EndpointCard
                eyebrow="Target"
                name={session.targetLabel ?? "Target legacy"}
                address={session.targetHost}
                note="Configured target; tidak tampil sebagai responding Layer-3 hop pada sesi ini."
              />
            ) : (
              <p className="text-meta text-text-muted">
                Target cocok dengan responding hop di atas; tidak ada hop tambahan yang dibuat oleh UI.
              </p>
            )}
          </div> : null}
        </article>
      ))}
    </div>
  );
}

function ObservedHop({
  hop,
  isTarget,
  targetLabel,
}: {
  hop: HopMeasurement;
  isTarget: boolean;
  targetLabel: string | null;
}) {
  const { nodes, canManage } = useNetworkNodes();
  const [editing, setEditing] = useState(false);
  const node = findNetworkNode(nodes, hop.hop_ip);
  const primaryName = networkNodeDisplayName(
    node,
    isTarget ? targetLabel ?? "Target" : null,
  );

  return (
    <div className="rounded-control border border-border bg-bg-surface p-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-meta font-medium uppercase tracking-wide text-accent">
            {isTarget ? `Target · Hop ${hop.hop_number}` : `Hop ${hop.hop_number}`}
          </p>
          <h4 className="mt-2 text-body font-medium">{primaryName}</h4>
          <p className="mt-1 font-data text-body text-text-secondary">{hop.hop_ip ?? "No responding IP"}</p>
          {isTarget && node && node.name !== primaryName ? (
            <p className="mt-2 text-meta text-text-muted">Inventory label: {node.name}</p>
          ) : null}
          {node ? <NodeMetadata node={node} /> : null}
        </div>
        <dl className="grid shrink-0 grid-cols-2 gap-4 text-meta sm:min-w-56">
          <Metric label="Avg latency" value={formatLatency(hop.avg_latency_ms)} />
          <Metric label="Loss" value={`${hop.loss_percent.toFixed(1)}%`} />
        </dl>
      </div>

      {canManage && hop.hop_ip ? (
        <button
          className="mt-4 text-meta font-medium text-accent hover:underline"
          onClick={() => setEditing((value) => !value)}
          type="button"
        >
          {editing ? "Tutup editor" : node ? "Edit node" : "+ Beri nama"}
        </button>
      ) : null}

      {editing && hop.hop_ip ? (
        <NodeEditor
          key={`${node?.id ?? hop.hop_ip}-${node?.updated_at ?? "new"}`}
          ipAddress={hop.hop_ip}
          node={node ?? null}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </div>
  );
}

function NodeEditor({
  ipAddress,
  node,
  onClose,
}: {
  ipAddress: string;
  node: NetworkNode | null;
  onClose: () => void;
}) {
  const { saveNode, deleteNode } = useNetworkNodes();
  const [name, setName] = useState(node?.name ?? "");
  const [deviceType, setDeviceType] = useState<NetworkNodeType | "">(node?.device_type ?? "");
  const [location, setLocation] = useState(node?.location ?? "");
  const [notes, setNotes] = useState(node?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const input: NetworkNodeInput = {
      ip_address: ipAddress,
      name,
      device_type: deviceType || null,
      location,
      notes,
    };
    const failure = await saveNode(node, input);
    setBusy(false);
    if (failure) setError(failure);
    else onClose();
  }

  async function remove() {
    if (!node || !window.confirm(`Hapus label ${node.name} untuk ${node.ip_address}?`)) return;
    setBusy(true);
    setError(null);
    const failure = await deleteNode(node);
    setBusy(false);
    if (failure) setError(failure);
    else onClose();
  }

  return (
    <form className="mt-4 grid gap-4 border-t border-border pt-4" onSubmit={submit}>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="IP">
          <input
            className="w-full rounded-control border border-border bg-bg-base px-3 py-2 font-data text-body text-text-muted"
            readOnly
            value={ipAddress}
          />
        </Field>
        <Field label="Name">
          <input
            className="w-full rounded-control border border-border bg-bg-base px-3 py-2 text-body outline-none focus:border-accent"
            maxLength={200}
            onChange={(event) => setName(event.target.value)}
            required
            value={name}
          />
        </Field>
        <Field label="Device type">
          <select
            className="w-full rounded-control border border-border bg-bg-base px-3 py-2 text-body outline-none focus:border-accent"
            onChange={(event) => setDeviceType(event.target.value as NetworkNodeType | "")}
            value={deviceType}
          >
            <option value="">Tidak dicatat</option>
            {NETWORK_NODE_TYPES.map((value) => (
              <option key={value} value={value}>{networkNodeTypeLabel(value)}</option>
            ))}
          </select>
        </Field>
        <Field label="Location">
          <input
            className="w-full rounded-control border border-border bg-bg-base px-3 py-2 text-body outline-none focus:border-accent"
            maxLength={200}
            onChange={(event) => setLocation(event.target.value)}
            value={location}
          />
        </Field>
      </div>
      <Field label="Notes">
        <textarea
          className="min-h-24 w-full rounded-control border border-border bg-bg-base px-3 py-2 text-body outline-none focus:border-accent"
          maxLength={2000}
          onChange={(event) => setNotes(event.target.value)}
          value={notes}
        />
      </Field>
      <p className="text-meta text-text-muted">Inventory metadata only—jangan simpan credential, secret, atau SNMP community string.</p>
      {error ? <p className="text-meta text-severity-critical">{error}</p> : null}
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button disabled={busy} type="submit">{busy ? "Menyimpan..." : "Simpan label"}</Button>
        <Button disabled={busy} onClick={onClose} type="button" variant="secondary">Batal</Button>
        {node ? (
          <Button className="sm:ml-auto" disabled={busy} onClick={remove} type="button" variant="destructive">
            Hapus label
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function EndpointCard({
  eyebrow,
  name,
  address,
  note,
}: {
  eyebrow: "Source" | "Target";
  name: string;
  address: string | null;
  note?: string;
}) {
  const { nodes } = useNetworkNodes();
  const node = findNetworkNode(nodes, address);
  return (
    <div className="rounded-control border border-accent bg-bg-surface p-4">
      <p className="text-meta font-medium uppercase tracking-wide text-accent">{eyebrow}</p>
      <p className="mt-2 font-medium">{name}</p>
      {address ? <p className="mt-1 font-data text-body text-text-secondary">{address}</p> : null}
      {node && node.name !== name ? <p className="mt-2 text-meta text-text-muted">Inventory label: {node.name}</p> : null}
      {note ? <p className="mt-2 text-meta text-text-muted">{note}</p> : null}
    </div>
  );
}

function NodeMetadata({ node }: { node: NetworkNode }) {
  const values = [
    node.device_type ? networkNodeTypeLabel(node.device_type) : null,
    node.location,
  ].filter((value): value is string => Boolean(value));
  return (
    <div className="mt-2 text-meta text-text-muted">
      {values.length ? <p>{values.join(" · ")}</p> : null}
      {node.notes ? <p className="mt-1 whitespace-pre-wrap">{node.notes}</p> : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-text-muted">{label}</dt><dd className="mt-1 font-data text-text-primary">{value}</dd></div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="grid gap-2 text-meta font-medium text-text-secondary">{label}{children}</label>;
}

function PathArrow() {
  return <div aria-hidden="true" className="py-2 text-center font-data text-accent">↓</div>;
}

function sameIp(left: string | null, right: string | null) {
  if (!left || !right) return false;
  const normalizedLeft = normalizeNetworkNodeIp(left);
  const normalizedRight = normalizeNetworkNodeIp(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function formatConnection(value: HopMeasurement["connection_type"]) {
  if (value === "wifi") return "WiFi";
  if (value === "ethernet") return "Ethernet";
  return "Legacy / belum dicatat";
}

function formatLatency(value: number | null) {
  return value === null ? "—" : `${value.toFixed(2)} ms`;
}

function formatTimestamp(timestamp: string) {
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(timestamp));
}
