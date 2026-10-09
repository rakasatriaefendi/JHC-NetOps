import { createHash } from "node:crypto";

export type IdentityState = "resolved" | "provisional" | "conflict";
export type EvidenceType = "network_node_binding" | "global_mac" | "local_mac" | "snmp_serial"
  | "sys_object_id" | "manufacturer" | "model" | "hostname" | "sys_name" | "netbios_name";
export type IdentityEvidence = Readonly<{
  evidence_type: EvidenceType; normalized_value: string; strength: "strong" | "corroborating" | "weak";
}>;
export type IdentityCandidate = Readonly<{
  id: string; network_node_ref: string | null; evidence: readonly IdentityEvidence[];
}>;
export type IdentityResolution = Readonly<{
  state: IdentityState; assetId: string | null; conflictIds: readonly string[]; anchor: string | null;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TYPES = new Set<string>(["network_node_binding", "global_mac", "local_mac", "snmp_serial",
  "sys_object_id", "manufacturer", "model", "hostname", "sys_name", "netbios_name"]);
const SECRET_ASSIGNMENT = /(?:^|[\s;,])(?:password|community|authorization|session_token|access_token|refresh_token|api_key|client_secret|private_key|database_url|service_role|secret)\s*[:=]|\bbearer\s+\S+/i;

export function normalizeIdentityEvidence(type: EvidenceType, value: unknown): IdentityEvidence | null {
  if (!TYPES.has(type) || typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const text = value.trim().replace(/\s+/g, " ");
  if (!text || text.length > 256 || SECRET_ASSIGNMENT.test(text)
      || /^(?:-|unknown|n\/?a|none|null|not available|not specified|unspecified|to be filled by o\.e\.m\.|0+|0x[0-9a-f]*|[-?]+)$/i.test(text)) return null;
  if (type === "network_node_binding") return UUID.test(text)
    ? { evidence_type: type, normalized_value: text.toLowerCase(), strength: "strong" } : null;
  if (type === "global_mac" || type === "local_mac") {
    const mac = text.replaceAll("-", ":").toUpperCase();
    if (!/^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/.test(mac) || mac === "00:00:00:00:00:00") return null;
    const first = Number.parseInt(mac.slice(0, 2), 16);
    if ((first & 1) !== 0) return null; // Multicast/broadcast is not device identity.
    const local = (first & 2) !== 0;
    return { evidence_type: local ? "local_mac" : "global_mac", normalized_value: mac, strength: local ? "weak" : "strong" };
  }
  if (!/[a-z0-9]/i.test(text)) return null;
  if (type === "sys_object_id" && !/^\.?\d+(?:\.\d+)+$/.test(text)) return null;
  return { evidence_type: type,
    normalized_value: type === "snmp_serial" ? text.toUpperCase() : type === "sys_object_id" ? text.replace(/^\./, "") : text.toLowerCase(),
    strength: type === "snmp_serial" ? "strong" : ["sys_object_id", "manufacturer", "model"].includes(type) ? "corroborating" : "weak" };
}

export function resolveDeviceIdentity(evidence: readonly IdentityEvidence[], candidates: readonly IdentityCandidate[]): IdentityResolution {
  // Values and strength are always normalized here; callers cannot promote weak evidence.
  const normalized = evidence.map((item) => normalizeIdentityEvidence(item.evidence_type, item.normalized_value))
    .filter((item): item is IdentityEvidence => item !== null);
  for (const type of ["network_node_binding", "snmp_serial", "global_mac"] as const) {
    const values = normalized.filter((item) => item.evidence_type === type);
    if (!values.length) continue;
    const matches = candidates.filter((candidate) => values.some((item) => type === "network_node_binding"
      ? candidate.network_node_ref?.toLowerCase() === item.normalized_value
      : candidate.evidence.some((other) => other.evidence_type === type && other.normalized_value === item.normalized_value)));
    const ids = [...new Set(matches.map((candidate) => candidate.id))].sort();
    if (ids.length > 1) return { state: "conflict", assetId: null, conflictIds: ids, anchor: null };
    if (ids.length === 1) {
      const matched = matches[0]!;
      const binding = normalized.find((item) => item.evidence_type === "network_node_binding");
      if (type !== "network_node_binding" && binding && matched.network_node_ref
          && matched.network_node_ref.toLowerCase() !== binding.normalized_value) {
        // A new control-plane node must not overwrite a different existing
        // explicit binding just because its serial/MAC is shared.
        return { state: "conflict", assetId: null, conflictIds: ids, anchor: null };
      }
      const anchor = values.find((item) => type === "network_node_binding"
        ? matched.network_node_ref?.toLowerCase() === item.normalized_value
        : matched.evidence.some((other) => other.evidence_type === type && other.normalized_value === item.normalized_value))!;
      return { state: "resolved", assetId: ids[0]!, conflictIds: [], anchor: `${type}:${anchor.normalized_value}` };
    }
    // Only an EXISTING explicit binding wins. Otherwise continue to unique
    // serial/MAC evidence before creating a new canonical asset.
  }
  const strong = normalized.find((item) => item.strength === "strong");
  return { state: strong ? "resolved" : "provisional", assetId: null, conflictIds: [],
    anchor: strong ? `${strong.evidence_type}:${strong.normalized_value}` : null };
}

// Device serial identifies the device, not an individual interface. Keep this
// choice independent of the evidence that selected the canonical asset.
export function endpointContinuityAnchor(evidence: readonly IdentityEvidence[]): string | null {
  const normalized = evidence.map((item) => normalizeIdentityEvidence(item.evidence_type, item.normalized_value))
    .filter((item): item is IdentityEvidence => item !== null);
  for (const type of ["network_node_binding", "global_mac", "snmp_serial"] as const) {
    const values = [...new Set(normalized.filter((item) => item.evidence_type === type).map((item) => item.normalized_value))];
    if (values.length > 1) return null; // No arbitrary interface anchor.
    if (values.length === 1) return `${type}:${values[0]!}`;
  }
  return null;
}

// Exact immutable source observation identity only; never used to join legacy
// IP keys or to assert that two snapshots represent the same physical device.
export function provisionalObservationKey(input: Readonly<{
  sourceKey: string; ip: string | null; mac: string | null; observedAt: string; scanRunId: string | null;
}>): string {
  return `provisional:${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`;
}

export type EndpointAssignment = {
  id: string; asset_id: string; ip_address: string; state: "current" | "historical" | "unresolved";
  confidence: "authoritative" | "high" | "medium" | "low"; source: string;
  first_seen_at: string; last_seen_at: string; ended_at: string | null;
  network_node_ref: string | null; identity_key: string | null;
};

export function applyEndpointObservation(
  timeline: readonly EndpointAssignment[], incoming: EndpointAssignment, relatedAnchors: readonly string[] = [],
): EndpointAssignment[] {
  const result = timeline.map((row) => ({ ...row }));
  if (result.some((row) => row.id === incoming.id && row.state === "historical")) return result;
  const time = Date.parse(incoming.last_seen_at);
  const affected = result.filter((row) => row.state === "current" && (row.ip_address === incoming.ip_address
    || row.asset_id === incoming.asset_id && (row.identity_key === incoming.identity_key
      || row.identity_key !== null && relatedAnchors.includes(row.identity_key))));
  if (incoming.state !== "current" || affected.some((row) => Date.parse(row.last_seen_at) > time)) {
    // Weak/conflicting or delayed evidence cannot displace a current owner.
    if (!result.some((row) => row.id === incoming.id)) result.push({ ...incoming, state: "unresolved", confidence: "low", ended_at: null });
    return result;
  }
  const same = affected.find((row) => row.asset_id === incoming.asset_id && row.ip_address === incoming.ip_address);
  for (const row of affected) {
    if (row === same) continue;
    row.state = "historical";
    row.ended_at = incoming.last_seen_at;
  }
  if (same) {
    same.last_seen_at = incoming.last_seen_at;
    same.confidence = incoming.confidence;
    same.ended_at = incoming.ended_at;
    same.network_node_ref = incoming.network_node_ref ?? same.network_node_ref;
    same.identity_key = incoming.identity_key;
  }
  else {
    const index = result.findIndex((row) => row.id === incoming.id);
    if (index >= 0) result[index] = { ...incoming, first_seen_at: result[index]!.first_seen_at };
    else result.push({ ...incoming });
  }
  return result;
}
