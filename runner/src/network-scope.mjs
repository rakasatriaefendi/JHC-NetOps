import { isIP } from "node:net";

import { safeError } from "./config.mjs";

const MAX_INTERFACES = 64;
const MAX_ADDRESSES_PER_INTERFACE = 16;
const MAX_ROUTES = 256;
const MAX_CANDIDATES = 256;
const MAX_EXCLUSIONS = 256;
const MAX_ACTIVE_DISCOVERY_HOSTS = 254;
const PRIVATE_RANGES = [
  { network: "10.0.0.0", prefix: 8 },
  { network: "172.16.0.0", prefix: 12 },
  { network: "192.168.0.0", prefix: 16 },
];

export function resolveNetworkScopes(networkState) {
  const interfaces = Array.isArray(networkState?.interfaces)
    ? networkState.interfaces.slice(0, MAX_INTERFACES)
    : [];
  const routes = Array.isArray(networkState?.routes)
    ? networkState.routes.slice(0, MAX_ROUTES)
    : [];
  const defaultInterfaceIndex = validInterfaceIndex(networkState?.default_interface_index)
    ? networkState.default_interface_index
    : null;
  const eligibleInterfaces = new Map();
  const candidates = new Map();
  const exclusions = [];
  const exclude = (value) => {
    if (exclusions.length < MAX_EXCLUSIONS) exclusions.push(value);
  };

  for (const rawInterface of interfaces) {
    const parsed = normalizeInterface(rawInterface);
    if (!parsed) {
      exclude({ source_kind: "directly_connected", reason: "invalid_interface" });
      continue;
    }
    if (parsed.operational_status !== "up") {
      exclude(interfaceExclusion(parsed, "inactive_interface"));
      continue;
    }
    if (parsed.interface_kind === "virtual_internal") {
      exclude(interfaceExclusion(parsed, "virtual_internal_interface"));
      continue;
    }
    eligibleInterfaces.set(parsed.interface_index, parsed);
    for (const address of parsed.addresses.slice(0, MAX_ADDRESSES_PER_INTERFACE)) {
      const normalized = normalizeConnectedAddress(address);
      if (!normalized.ok) {
        exclude(interfaceExclusion(parsed, normalized.reason));
        continue;
      }
      const candidate = {
        cidr: normalized.cidr,
        source_interface: parsed.interface_alias,
        source_interface_index: parsed.interface_index,
        source_kind: "directly_connected",
        address_family: "ipv4",
        prefix_length: normalized.prefix,
        source_ipv4: normalized.address,
        connection_type: parsed.connection_type,
        interface_kind: parsed.interface_kind,
        is_default_route_interface: parsed.interface_index === defaultInterfaceIndex,
      };
      addCandidate(candidates, candidate);
    }
  }

  for (const rawRoute of routes) {
    const parsed = normalizeRoute(rawRoute);
    if (!parsed) {
      exclude({ source_kind: "explicit_route", reason: "invalid_route" });
      continue;
    }
    if (parsed.prefix_length === 0) {
      exclude(routeExclusion(parsed, "default_route"));
      continue;
    }
    const sourceInterface = eligibleInterfaces.get(parsed.interface_index);
    if (!sourceInterface) {
      exclude(routeExclusion(parsed, "ineligible_interface"));
      continue;
    }
    if (!isPrivateCidr(parsed.cidr)) {
      exclude(routeExclusion(parsed, "non_private_route"));
      continue;
    }
    if (parsed.prefix_length > 30) {
      exclude(routeExclusion(parsed, "no_usable_host_range"));
      continue;
    }
    const candidate = {
      cidr: parsed.cidr,
      source_interface: sourceInterface.interface_alias,
      source_interface_index: sourceInterface.interface_index,
      source_kind: "explicit_route",
      address_family: "ipv4",
      prefix_length: parsed.prefix_length,
      source_ipv4: null,
      connection_type: sourceInterface.connection_type,
      interface_kind: sourceInterface.interface_kind,
      is_default_route_interface: sourceInterface.interface_index === defaultInterfaceIndex,
    };
    addCandidate(candidates, candidate);
  }

  return {
    candidates: [...candidates.values()].sort(compareCandidates).slice(0, MAX_CANDIDATES),
    exclusions,
  };
}

export function selectPrimaryDiscoveryScope(resolution, preferred = {}) {
  const candidates = Array.isArray(resolution?.candidates) ? resolution.candidates : [];
  const exact = candidates.find((candidate) =>
    candidate.source_kind === "directly_connected" && candidate.is_default_route_interface === true &&
    (preferred.sourceIpv4 === undefined || candidate.source_ipv4 === preferred.sourceIpv4) &&
    (preferred.interfaceAlias === undefined || candidate.source_interface === preferred.interfaceAlias));
  if (exact) return exact;
  return candidates.find((candidate) =>
    candidate.source_kind === "directly_connected" && candidate.is_default_route_interface === true)
    ?? candidates.find((candidate) => candidate.source_kind === "directly_connected")
    ?? null;
}

export function boundedDiscoveryRange(candidate) {
  if (!candidate || candidate.source_kind !== "directly_connected" ||
      isIP(candidate.source_ipv4) !== 4 || !Number.isInteger(candidate.prefix_length) ||
      candidate.prefix_length < 8 || candidate.prefix_length > 30) {
    throw safeError("DISCOVERY_CONTEXT_INVALID");
  }
  const parsed = parseCidr(candidate.cidr);
  if (!parsed || !sameSubnet(candidate.source_ipv4, parsed.network, parsed.prefix)) {
    throw safeError("DISCOVERY_CONTEXT_INVALID");
  }
  const network = ipNumber(parsed.network);
  const firstUsable = network + 1;
  const lastUsable = network + 2 ** (32 - parsed.prefix) - 2;
  const source = ipNumber(candidate.source_ipv4);
  if (source < firstUsable || source > lastUsable) throw safeError("DISCOVERY_CONTEXT_INVALID");
  const chunk = Math.floor((source - firstUsable) / MAX_ACTIVE_DISCOVERY_HOSTS);
  const start = firstUsable + chunk * MAX_ACTIVE_DISCOVERY_HOSTS;
  const end = Math.min(start + MAX_ACTIVE_DISCOVERY_HOSTS - 1, lastUsable);
  return {
    start_ipv4: numberIp(start),
    end_ipv4: numberIp(end),
    total_hosts: end - start + 1,
  };
}

export function discoveryRangeAddresses(range) {
  if (!record(range) || isIP(range.start_ipv4) !== 4 || isIP(range.end_ipv4) !== 4) {
    throw safeError("DISCOVERY_CONTEXT_INVALID");
  }
  const start = ipNumber(range.start_ipv4), end = ipNumber(range.end_ipv4);
  const count = end - start + 1;
  if (count < 1 || count > MAX_ACTIVE_DISCOVERY_HOSTS) throw safeError("DISCOVERY_CONTEXT_INVALID");
  return Array.from({ length: count }, (_, index) => numberIp(start + index));
}

export function canonicalCidr(address, prefix) {
  if (isIP(address) !== 4 || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw safeError("DISCOVERY_CONTEXT_INVALID");
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return `${numberIp(ipNumber(address) & mask)}/${prefix}`;
}

export function isPrivateCidr(cidr) {
  const parsed = parseCidr(cidr);
  if (!parsed) return false;
  return PRIVATE_RANGES.some((range) =>
    parsed.prefix >= range.prefix && sameSubnet(parsed.network, range.network, range.prefix));
}

function normalizeInterface(value) {
  if (!record(value) || !validInterfaceIndex(value.interface_index) ||
      typeof value.interface_alias !== "string" || !value.interface_alias.trim() || value.interface_alias.length > 256 ||
      !["up", "down", "unknown"].includes(value.operational_status) ||
      !["physical", "virtual", "virtual_internal", "tunnel", "unknown"].includes(value.interface_kind) ||
      !["wifi", "ethernet", "unknown"].includes(value.connection_type) || !Array.isArray(value.addresses)) {
    return null;
  }
  return {
    interface_index: value.interface_index,
    interface_alias: value.interface_alias.trim(),
    operational_status: value.operational_status,
    interface_kind: value.interface_kind,
    connection_type: value.connection_type,
    addresses: value.addresses,
  };
}

function normalizeConnectedAddress(value) {
  if (!record(value) || isIP(value.ip_address) !== 4 || !Number.isInteger(value.prefix_length) ||
      value.prefix_length < 0 || value.prefix_length > 32) {
    return { ok: false, reason: "invalid_address" };
  }
  if (value.ip_address === "0.0.0.0" || value.ip_address.startsWith("127.")) {
    return { ok: false, reason: "loopback_or_unspecified" };
  }
  if (value.ip_address.startsWith("169.254.")) {
    return { ok: false, reason: "link_local" };
  }
  const cidr = canonicalCidr(value.ip_address, value.prefix_length);
  if (!isPrivateCidr(cidr)) return { ok: false, reason: "non_private_address" };
  if (value.prefix_length > 30) return { ok: false, reason: "no_usable_host_range" };
  return { ok: true, address: value.ip_address, prefix: value.prefix_length, cidr };
}

function normalizeRoute(value) {
  if (!record(value) || typeof value.destination_cidr !== "string" || !validInterfaceIndex(value.interface_index)) return null;
  const parsed = parseCidr(value.destination_cidr);
  if (!parsed) return null;
  return {
    cidr: `${parsed.network}/${parsed.prefix}`,
    prefix_length: parsed.prefix,
    interface_index: value.interface_index,
  };
}

function parseCidr(value) {
  const [address, rawPrefix, extra] = typeof value === "string" ? value.split("/") : [];
  const prefix = Number(rawPrefix);
  if (extra !== undefined || isIP(address) !== 4 || !/^\d{1,2}$/.test(rawPrefix ?? "") || prefix < 0 || prefix > 32) return null;
  const canonical = canonicalCidr(address, prefix);
  const [network] = canonical.split("/");
  return { network, prefix };
}

function addCandidate(candidates, candidate) {
  const current = candidates.get(candidate.cidr);
  if (!current || (current.source_kind === "explicit_route" && candidate.source_kind === "directly_connected") ||
      (!current.is_default_route_interface && candidate.is_default_route_interface)) {
    candidates.set(candidate.cidr, candidate);
  }
}

function compareCandidates(left, right) {
  if (left.is_default_route_interface !== right.is_default_route_interface) return left.is_default_route_interface ? -1 : 1;
  if (left.source_kind !== right.source_kind) return left.source_kind === "directly_connected" ? -1 : 1;
  const addressOrder = ipNumber(left.cidr.split("/")[0]) - ipNumber(right.cidr.split("/")[0]);
  return addressOrder || left.prefix_length - right.prefix_length || left.source_interface_index - right.source_interface_index;
}

function interfaceExclusion(value, reason) {
  return { source_kind: "directly_connected", source_interface: value.interface_alias, reason };
}

function routeExclusion(value, reason) {
  return { source_kind: "explicit_route", cidr: value.cidr, reason };
}

function validInterfaceIndex(value) { return Number.isSafeInteger(value) && value >= 1 && value <= 1_000_000; }
function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function ipNumber(value) { return value.split(".").reduce((total, part) => total * 256 + Number(part), 0) >>> 0; }
function numberIp(value) { return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join("."); }
function sameSubnet(ip, network, prefix) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipNumber(ip) & mask) === (ipNumber(network) & mask);
}
