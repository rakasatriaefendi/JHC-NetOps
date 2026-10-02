export type DiscoveryContext = Readonly<{
  connection_type: "wifi" | "ethernet" | "unknown";
  interface_alias: string;
  local_ipv4: string;
  subnet_cidr: string;
  total_hosts: number;
}>;

export type DiscoveryHost = Readonly<{
  ip_address: string;
  evidence: readonly ("icmp" | "neighbor")[];
  latency_ms: number | null;
  is_this_device: boolean;
  is_gateway: boolean;
  reachability_evidence?: "icmp_verified" | "l2_observed" | "cached_only";
  neighbor_state?: "Reachable" | "Stale" | "Delay" | "Probe" | "Permanent";
}>;

export type NetworkDiscoveryRequest =
  | Readonly<{ action: "claim_session"; runner_id: string }>
  | Readonly<{ action: "context_ready"; runner_id: string; session_id: string; context: DiscoveryContext }>
  | Readonly<{ action: "update_progress"; runner_id: string; session_id: string; context: DiscoveryContext; scanned_hosts: number; results: readonly DiscoveryHost[] }>
  | Readonly<{ action: "complete_session"; runner_id: string; session_id: string; scanned_hosts: number }>
  | Readonly<{ action: "fail_session"; runner_id: string; session_id: string; error_code: string }>;

type ValidationResult =
  | Readonly<{ ok: true; value: NetworkDiscoveryRequest }>
  | Readonly<{ ok: false; message: string }>;

const RUNNER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ERROR_CODE = /^[A-Z0-9_]{1,64}$/;
const ACTIONS = new Set(["claim_session", "context_ready", "update_progress", "complete_session", "fail_session"]);

export function validateNetworkDiscoveryRequest(value: unknown): ValidationResult {
  if (!record(value) || typeof value.action !== "string" || !ACTIONS.has(value.action)
      || typeof value.runner_id !== "string" || !RUNNER_ID.test(value.runner_id)) {
    return invalid("Network discovery request is invalid");
  }
  if (value.action === "claim_session") {
    return exactKeys(value, ["action", "runner_id"])
      ? { ok: true, value: { action: "claim_session", runner_id: value.runner_id } }
      : invalid("Network discovery request is invalid");
  }
  if (typeof value.session_id !== "string" || !UUID.test(value.session_id)) {
    return invalid("Network discovery session is invalid");
  }
  if (value.action === "context_ready") {
    const context = validateContext(value.context);
    return context && exactKeys(value, ["action", "runner_id", "session_id", "context"])
      ? { ok: true, value: { action: "context_ready", runner_id: value.runner_id, session_id: value.session_id, context } }
      : invalid("Discovery network context is invalid");
  }
  if (value.action === "update_progress") {
    const context = validateContext(value.context);
    const results = context ? validateResults(value.results, context) : null;
    if (!context || !results || !integer(value.scanned_hosts, 0, context.total_hosts)
        || !exactKeys(value, ["action", "runner_id", "session_id", "context", "scanned_hosts", "results"])) {
      return invalid("Discovery progress is invalid");
    }
    return { ok: true, value: { action: "update_progress", runner_id: value.runner_id, session_id: value.session_id,
      context, scanned_hosts: value.scanned_hosts as number, results } };
  }
  if (value.action === "complete_session") {
    return integer(value.scanned_hosts, 0, 254) && exactKeys(value, ["action", "runner_id", "session_id", "scanned_hosts"])
      ? { ok: true, value: { action: "complete_session", runner_id: value.runner_id, session_id: value.session_id,
        scanned_hosts: value.scanned_hosts as number } }
      : invalid("Discovery completion is invalid");
  }
  const errorCode = typeof value.error_code === "string" && ERROR_CODE.test(value.error_code)
    ? value.error_code
    : "DISCOVERY_FAILED";
  return exactKeys(value, ["action", "runner_id", "session_id", "error_code"])
    ? { ok: true, value: { action: "fail_session", runner_id: value.runner_id, session_id: value.session_id, error_code: errorCode } }
    : invalid("Discovery failure is invalid");
}

function validateContext(value: unknown): DiscoveryContext | null {
  if (!record(value) || !exactKeys(value, ["connection_type", "interface_alias", "local_ipv4", "subnet_cidr", "scan_start_ipv4", "scan_end_ipv4"])
      || !["wifi", "ethernet", "unknown"].includes(String(value.connection_type))
      || typeof value.interface_alias !== "string" || value.interface_alias.length < 1 || value.interface_alias.length > 256
      || !ipv4(value.local_ipv4) || typeof value.subnet_cidr !== "string") return null;
  const [network, rawPrefix, extra] = value.subnet_cidr.split("/");
  const prefix = Number(rawPrefix);
  if (extra !== undefined || !ipv4(network) || !Number.isInteger(prefix) || prefix < 8 || prefix > 30
      || canonicalNetwork(network, prefix) !== network || !privateCidr(network, prefix)
      || !sameSubnet(value.local_ipv4, network, prefix)) return null;
  const range = boundedRange(network, prefix, value.local_ipv4);
  if (!range || value.scan_start_ipv4 !== range.start_ipv4 || value.scan_end_ipv4 !== range.end_ipv4) return null;
  const totalHosts = ipNumber(range.end_ipv4) - ipNumber(range.start_ipv4) + 1;
  if (totalHosts < 1 || totalHosts > 254) return null;
  return {
    connection_type: value.connection_type as DiscoveryContext["connection_type"],
    interface_alias: value.interface_alias,
    local_ipv4: value.local_ipv4,
    subnet_cidr: `${network}/${prefix}`,
    total_hosts: totalHosts,
  };
}

function validateResults(value: unknown, context: DiscoveryContext): readonly DiscoveryHost[] | null {
  if (!Array.isArray(value) || value.length > 254) return null;
  const range = boundedRange(...context.subnet_cidr.split("/") as [string, string], context.local_ipv4);
  if (!range) return null;
  const start = ipNumber(range.start_ipv4), end = ipNumber(range.end_ipv4);
  const results: DiscoveryHost[] = [];
  for (const item of value) {
    if (!record(item) || !allowedHostKeys(item) || !ipv4(item.ip_address)
        || ipNumber(item.ip_address) < start || ipNumber(item.ip_address) > end
        || !Array.isArray(item.evidence) || item.evidence.length < 1 || item.evidence.length > 2
        || !item.evidence.every((entry) => entry === "icmp" || entry === "neighbor")
        || !(item.latency_ms === null || finiteNumber(item.latency_ms, 0, 60_000))
        || typeof item.is_this_device !== "boolean" || typeof item.is_gateway !== "boolean"
        || !(item.reachability_evidence === undefined || ["icmp_verified", "l2_observed", "cached_only"].includes(String(item.reachability_evidence)))
        || !(item.neighbor_state === undefined || ["Reachable", "Stale", "Delay", "Probe", "Permanent"].includes(String(item.neighbor_state)))) return null;
    results.push(item as DiscoveryHost);
  }
  const serializedBytes = Buffer.byteLength(JSON.stringify(results), "utf8");
  if (serializedBytes > 64 * 1024) return null;
  return [...new Map(results.map((item) => [item.ip_address, item])).values()]
    .sort((left, right) => ipNumber(left.ip_address) - ipNumber(right.ip_address));
}

function allowedHostKeys(value: Record<string, unknown>) {
  return Object.keys(value).every((key) => ["ip_address", "evidence", "latency_ms", "is_this_device", "is_gateway", "reachability_evidence", "neighbor_state"].includes(key));
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  return Object.keys(value).length === expected.length && Object.keys(value).every((key) => expected.includes(key));
}
function invalid(message: string): ValidationResult { return { ok: false, message }; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function integer(value: unknown, min: number, max: number) { return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max; }
function finiteNumber(value: unknown, min: number, max: number) { return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max; }
function ipv4(value: unknown): value is string { return typeof value === "string" && value.split(".").length === 4 && value.split(".").every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255); }
function ipNumber(value: string) { return value.split(".").reduce((total, part) => total * 256 + Number(part), 0) >>> 0; }
function numberIp(value: number) { return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join("."); }
function canonicalNetwork(value: string, prefix: number) { const mask = (0xffffffff << (32 - prefix)) >>> 0; return numberIp(ipNumber(value) & mask); }
function sameSubnet(ip: string, network: string, prefix: number) { const mask = (0xffffffff << (32 - prefix)) >>> 0; return (ipNumber(ip) & mask) === (ipNumber(network) & mask); }
function privateCidr(network: string, prefix: number) {
  return (prefix >= 8 && sameSubnet(network, "10.0.0.0", 8))
    || (prefix >= 12 && sameSubnet(network, "172.16.0.0", 12))
    || (prefix >= 16 && sameSubnet(network, "192.168.0.0", 16));
}
function boundedRange(network: string, rawPrefix: string | number, sourceIp: string) {
  const prefix = Number(rawPrefix), base = ipNumber(network), first = base + 1, last = base + 2 ** (32 - prefix) - 2, source = ipNumber(sourceIp);
  if (source < first || source > last) return null;
  const start = first + Math.floor((source - first) / 254) * 254;
  return { start_ipv4: numberIp(start), end_ipv4: numberIp(Math.min(start + 253, last)) };
}
