export const MAX_OBSERVED_HOSTS = 256;

export type ObservedHostInput = {
  target_id: string;
  ip_address: string;
  mac_address: string | null;
  netbios_name: string | null;
  observation_source: "ip_net_to_physical" | "ip_net_to_media";
  enrichment_status: "resolved" | "unavailable" | "not_attempted";
};

type ExistingHost = {
  ip_address: string;
  first_seen_at: string;
  netbios_name: string | null;
  enrichment_status: "resolved" | "unavailable" | "not_attempted";
};

type InventoryNode = {
  id: string;
  ip_address: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAC = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
const ALLOWED_KEYS = new Set(["target_id", "ip_address", "mac_address", "netbios_name", "observation_source", "enrichment_status"]);

export function normalizeObservedHosts(value: unknown, targetId: string): ObservedHostInput[] | null {
  if (!Array.isArray(value) || value.length > MAX_OBSERVED_HOSTS || !UUID.test(targetId)) return null;
  const byIp = new Map<string, ObservedHostInput>();
  for (const item of value) {
    if (!record(item) || Object.keys(item).some((key) => !ALLOWED_KEYS.has(key))) return null;
    if (item.target_id !== targetId || !privateIpv4(item.ip_address)) return null;
    if (item.mac_address !== null && item.mac_address !== undefined &&
      (typeof item.mac_address !== "string" || !MAC.test(item.mac_address) || item.mac_address.toLowerCase() === "00:00:00:00:00:00")) return null;
    if (item.netbios_name !== null && item.netbios_name !== undefined &&
      (typeof item.netbios_name !== "string" || item.netbios_name.length < 1 || item.netbios_name.length > 15 || /[\x00-\x1f\x7f]/.test(item.netbios_name))) return null;
    if (item.observation_source !== "ip_net_to_physical" && item.observation_source !== "ip_net_to_media") return null;
    if (!new Set(["resolved", "unavailable", "not_attempted"]).has(String(item.enrichment_status))) return null;
    const candidate: ObservedHostInput = {
      target_id: targetId,
      ip_address: item.ip_address,
      mac_address: typeof item.mac_address === "string" ? item.mac_address.toLowerCase() : null,
      netbios_name: typeof item.netbios_name === "string" ? item.netbios_name : null,
      observation_source: item.observation_source,
      enrichment_status: item.enrichment_status as ObservedHostInput["enrichment_status"],
    };
    const previous = byIp.get(candidate.ip_address);
    if (!previous) byIp.set(candidate.ip_address, candidate);
    else byIp.set(candidate.ip_address, {
      ...previous,
      mac_address: previous.mac_address ?? candidate.mac_address,
      netbios_name: previous.netbios_name ?? candidate.netbios_name,
      enrichment_status: previous.enrichment_status === "resolved" ? "resolved" : candidate.enrichment_status,
    });
  }
  return [...byIp.values()].sort((left, right) => left.ip_address.localeCompare(right.ip_address, undefined, { numeric: true }));
}

export function prepareObservedHostRows(
  hosts: ObservedHostInput[],
  targetId: string,
  observedAt: string,
  existing: ExistingHost[],
  inventory: InventoryNode[],
) {
  const firstSeen = new Map(existing.map((row) => [row.ip_address, row.first_seen_at]));
  const existingByIp = new Map(existing.map((row) => [row.ip_address, row]));
  const nodes = new Map(inventory.map((row) => [row.ip_address, row.id]));
  const currentIps = new Set(hosts.map((host) => host.ip_address));
  const current = hosts.map((host) => {
    const previous = existingByIp.get(host.ip_address);
    const preserveResolvedName = host.enrichment_status !== "resolved" &&
      previous?.enrichment_status === "resolved" && Boolean(previous.netbios_name);
    return {
      target_id: targetId,
      node_id: nodes.get(host.ip_address) ?? null,
      ip_address: host.ip_address,
      mac_address: host.mac_address,
      netbios_name: preserveResolvedName ? previous?.netbios_name ?? null : host.netbios_name,
      observation_source: host.observation_source,
      enrichment_status: preserveResolvedName ? "resolved" : host.enrichment_status,
      first_seen_at: firstSeen.get(host.ip_address) ?? observedAt,
      last_seen_at: observedAt,
      status: "current",
      updated_at: observedAt,
    };
  });
  const stale = existing.filter((row) => !currentIps.has(row.ip_address)).map((row) => ({
    target_id: targetId,
    ip_address: row.ip_address,
    status: "stale",
    updated_at: observedAt,
  }));
  return { current, stale };
}

export type PreparedObservedHostRows = ReturnType<typeof prepareObservedHostRows>;

type PersistenceResult = { error: unknown | null };
type ObservedHostPersistenceOperations = {
  markStale: (targetId: string, observedAt: string, currentIpFilter: string | null) => PromiseLike<PersistenceResult>;
  upsertCurrent: (rows: PreparedObservedHostRows["current"]) => PromiseLike<PersistenceResult>;
};

export async function persistObservedHostRows(
  operations: ObservedHostPersistenceOperations,
  rows: PreparedObservedHostRows,
  targetId: string,
  observedAt: string,
): Promise<"stale" | "current" | null> {
  if (rows.stale.length) {
    const currentIpFilter = observedHostNotInFilter(rows.current.map((row) => row.ip_address));
    const { error } = await operations.markStale(targetId, observedAt, currentIpFilter);
    if (error) return "stale";
  }
  if (rows.current.length) {
    const { error } = await operations.upsertCurrent(rows.current);
    if (error) return "current";
  }
  return null;
}

export function observedHostNotInFilter(ipAddresses: string[]) {
  if (!ipAddresses.length) return null;
  if (ipAddresses.length > MAX_OBSERVED_HOSTS || new Set(ipAddresses).size !== ipAddresses.length || !ipAddresses.every(privateIpv4)) {
    throw new Error("Invalid normalized observed host set");
  }
  return `(${ipAddresses.map((ipAddress) => `"${ipAddress}"`).join(",")})`;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function privateIpv4(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = value.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return false;
  const [a, b, c, d] = parts.map(Number);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return a === 192 && b === 168 && !(c === 0 && d === 0) && !(c === 255 && d === 255);
}
