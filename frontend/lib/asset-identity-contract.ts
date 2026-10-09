export type AssetIdentityData = Readonly<{
  asset_id: string; identity_state: "resolved" | "provisional" | "conflict";
  evidence: readonly Readonly<{ evidence_type: string; normalized_value: string;
    strength: "strong" | "corroborating" | "weak"; source: string; first_seen_at: string; last_seen_at: string }>[];
  endpoints: readonly Readonly<{ id: string; asset_id: string; ip_address: string;
    state: "current" | "historical" | "unresolved"; confidence: "authoritative" | "high" | "medium" | "low";
    source: string; first_seen_at: string; last_seen_at: string; ended_at: string | null;
    network_node_ref: string | null; identity_key: string | null }>[];
  evidence_truncated: boolean; endpoints_truncated: boolean;
}>;

const TYPES = ["network_node_binding", "global_mac", "local_mac", "snmp_serial", "sys_object_id",
  "manufacturer", "model", "hostname", "sys_name", "netbios_name"];
const uuid = (value: unknown) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const timestamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const ipv4 = (value: unknown) => typeof value === "string" && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)
  && value.split(".").every((octet) => Number(octet) <= 255);
const text = (value: unknown, max: number) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function validAssetIdentity(value: unknown, assetId: string): value is { data: AssetIdentityData } {
  if (!record(value) || !record(value.data)) return false;
  const data = value.data;
  return uuid(data.asset_id) && data.asset_id === assetId && ["resolved", "provisional", "conflict"].includes(String(data.identity_state))
    && typeof data.evidence_truncated === "boolean" && typeof data.endpoints_truncated === "boolean"
    && Array.isArray(data.evidence) && data.evidence.length <= 128 && data.evidence.every((row) => record(row)
      && TYPES.includes(String(row.evidence_type)) && text(row.normalized_value, 256)
      && ["strong", "corroborating", "weak"].includes(String(row.strength)) && text(row.source, 64)
      && timestamp(row.first_seen_at) && timestamp(row.last_seen_at) && Date.parse(row.first_seen_at) <= Date.parse(row.last_seen_at))
    && Array.isArray(data.endpoints) && data.endpoints.length <= 200 && data.endpoints.every((row) => record(row)
      && uuid(row.id) && row.asset_id === assetId && ipv4(row.ip_address)
      && ["current", "historical", "unresolved"].includes(String(row.state))
      && ["authoritative", "high", "medium", "low"].includes(String(row.confidence)) && text(row.source, 64)
      && timestamp(row.first_seen_at) && timestamp(row.last_seen_at) && (row.ended_at === null || timestamp(row.ended_at))
      && Date.parse(row.first_seen_at) <= Date.parse(row.last_seen_at)
      && (row.state === "historical" ? timestamp(row.ended_at) && Date.parse(row.ended_at) >= Date.parse(row.last_seen_at) : row.ended_at === null)
      && (row.network_node_ref === null || uuid(row.network_node_ref)) && (row.identity_key === null || text(row.identity_key, 300)));
}
