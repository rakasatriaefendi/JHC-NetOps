export type ValidDiscoveryContext = {
  ok: true;
  value: Record<string, unknown> & { subnet_cidr: string; total_hosts: number };
  scanRange: { start_ipv4: string; end_ipv4: string };
};

export function validateDiscoveryContext(value: unknown): ValidDiscoveryContext | { ok: false; error: string } {
  if (!record(value) || !["wifi", "ethernet", "unknown"].includes(String(value.connection_type)) ||
      typeof value.interface_alias !== "string" || value.interface_alias.length > 256 || !ipv4(value.local_ipv4) || typeof value.subnet_cidr !== "string") {
    return { ok: false, error: "Discovery network context is invalid" };
  }
  const [network, rawPrefix, extra] = value.subnet_cidr.split("/");
  const prefix = Number(rawPrefix);
  if (extra !== undefined || !ipv4(network) || !Number.isInteger(prefix) || prefix < 8 || prefix > 30 ||
      canonicalNetwork(network, prefix) !== network || !privateCidr(network, prefix)) {
    return { ok: false, error: "Detected network scope is not an eligible private IPv4 network" };
  }
  if (!sameSubnet(value.local_ipv4, network, prefix)) return { ok: false, error: "Discovery subnet does not contain the runner address" };
  const expectedRange = boundedRange(network, prefix, value.local_ipv4);
  if (!expectedRange) return { ok: false, error: "Discovery scan unit exceeds the safe host bound" };
  let scanRange = expectedRange;
  if (value.scan_start_ipv4 !== undefined || value.scan_end_ipv4 !== undefined) {
    if (!ipv4(value.scan_start_ipv4) || !ipv4(value.scan_end_ipv4) ||
        value.scan_start_ipv4 !== expectedRange.start_ipv4 || value.scan_end_ipv4 !== expectedRange.end_ipv4) {
      return { ok: false, error: "Discovery scan unit exceeds the safe host bound" };
    }
  } else {
    const legacy = legacyScanRange(typeof value.scan_cidr === "string" ? value.scan_cidr : value.subnet_cidr, value.local_ipv4, network, prefix);
    if (!legacy) return { ok: false, error: "Discovery scan unit exceeds the safe host bound" };
    scanRange = legacy;
  }
  const totalHosts = ipNumber(scanRange.end_ipv4) - ipNumber(scanRange.start_ipv4) + 1;
  if (totalHosts < 1 || totalHosts > 254) {
    return { ok: false, error: "Discovery scan unit exceeds the safe host bound" };
  }
  return { ok: true, value: { connection_type: value.connection_type, interface_alias: value.interface_alias,
    local_ipv4: value.local_ipv4, subnet_cidr: `${network}/${prefix}`, total_hosts: totalHosts }, scanRange };
}

export function validDiscoveryResults(value: unknown, scanRange: { start_ipv4: string; end_ipv4: string }) {
  if (!Array.isArray(value) || value.length > 254) return false;
  const start = ipNumber(scanRange.start_ipv4), end = ipNumber(scanRange.end_ipv4);
  return value.every((item) => record(item) && ipv4(item.ip_address) && ipNumber(item.ip_address) >= start && ipNumber(item.ip_address) <= end &&
    Array.isArray(item.evidence) && item.evidence.length >= 1 && item.evidence.length <= 2 && item.evidence.every((entry) => ["icmp", "neighbor"].includes(String(entry))) &&
    (item.latency_ms === null || number(item.latency_ms, 0, 60_000)) && typeof item.is_this_device === "boolean" && typeof item.is_gateway === "boolean" &&
    (item.reachability_evidence === undefined || ["icmp_verified", "l2_observed", "cached_only"].includes(String(item.reachability_evidence))) &&
    (item.neighbor_state === undefined || ["Reachable", "Stale", "Delay", "Probe", "Permanent"].includes(String(item.neighbor_state))));
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function number(value: unknown, min: number, max: number) { return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max; }
function ipv4(value: unknown): value is string { return typeof value === "string" && value.split(".").length === 4 && value.split(".").every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255); }
function ipNumber(value: string) { return value.split(".").reduce((total, part) => total * 256 + Number(part), 0) >>> 0; }
function canonicalNetwork(value: string, prefix: number) { const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0; return numberIp(ipNumber(value) & mask); }
function numberIp(value: number) { return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join("."); }
function privateCidr(network: string, prefix: number) {
  return (prefix >= 8 && sameSubnet(network, "10.0.0.0", 8)) ||
    (prefix >= 12 && sameSubnet(network, "172.16.0.0", 12)) ||
    (prefix >= 16 && sameSubnet(network, "192.168.0.0", 16));
}
function sameSubnet(ip: string, network: string, prefix: number) { const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0; return (ipNumber(ip) & mask) === (ipNumber(network) & mask); }
function boundedRange(network: string, prefix: number, sourceIp: string) {
  const base = ipNumber(network), first = base + 1, last = base + 2 ** (32 - prefix) - 2, source = ipNumber(sourceIp);
  if (source < first || source > last) return null;
  const start = first + Math.floor((source - first) / 254) * 254;
  const end = Math.min(start + 253, last);
  return { start_ipv4: numberIp(start), end_ipv4: numberIp(end) };
}
function legacyScanRange(cidr: string, sourceIp: string, scopeNetwork: string, scopePrefix: number) {
  const [network, rawPrefix, extra] = cidr.split("/"), prefix = Number(rawPrefix);
  if (extra !== undefined || !ipv4(network) || !Number.isInteger(prefix) || prefix < 24 || prefix > 30 ||
      canonicalNetwork(network, prefix) !== network || prefix < scopePrefix || !sameSubnet(network, scopeNetwork, scopePrefix) ||
      !sameSubnet(sourceIp, network, prefix)) return null;
  const base = ipNumber(network);
  return { start_ipv4: numberIp(base + 1), end_ipv4: numberIp(base + 2 ** (32 - prefix) - 2) };
}
