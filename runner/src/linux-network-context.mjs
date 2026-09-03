import { spawn } from "node:child_process";
import dns from "node:dns";
import fs from "node:fs";
import net, { isIP } from "node:net";
import os from "node:os";

import { safeError } from "./config.mjs";
import { canonicalCidr, resolveNetworkScopes, selectPrimaryDiscoveryScope } from "./network-scope.mjs";

const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 5_000;
const MAX_INTERFACES = 64;
const MAX_ROUTES = 256;
const MAX_NEIGHBORS = 512;
const INTERNAL_LINK_KINDS = new Set(["bridge", "veth", "dummy", "ifb", "vrf"]);
const TUNNEL_LINK_KINDS = new Set(["tun", "tap", "wireguard", "gre", "gretap", "ipip", "sit", "vxlan"]);
const USABLE_NEIGHBOR_STATES = new Map([
  ["REACHABLE", "Reachable"], ["STALE", "Stale"], ["DELAY", "Delay"],
  ["PROBE", "Probe"], ["PERMANENT", "Permanent"], ["NOARP", "Permanent"],
]);

export async function collectLinuxNetworkState(options = {}) {
  const spawnProcess = options.spawnProcess ?? spawn;
  const command = options.ipExecutable ?? "ip";
  const commandOptions = { spawnProcess, timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS };
  const [addresses, routes, neighbors] = await Promise.all([
    runBoundedJsonCommand(command, ["-j", "-4", "address", "show"], commandOptions),
    runBoundedJsonCommand(command, ["-j", "-4", "route", "show", "table", "main"], commandOptions),
    runBoundedJsonCommand(command, ["-j", "-4", "neighbor", "show"], commandOptions),
  ]);
  return normalizeLinuxNetworkState({ addresses, routes, neighbors }, options);
}

export function normalizeLinuxNetworkState(raw, options = {}) {
  if (!Array.isArray(raw?.addresses) || !Array.isArray(raw?.routes) || !Array.isArray(raw?.neighbors)) {
    throw safeError("LINUX_CONTEXT_INVALID");
  }
  const wirelessInterface = options.isWirelessInterface ?? ((name) =>
    safeInterfaceName(name) && fs.existsSync(`/sys/class/net/${name}/wireless`));
  const interfaces = raw.addresses.slice(0, MAX_INTERFACES).map((item) => {
    if (!item || !Number.isSafeInteger(item.ifindex) || !safeInterfaceName(item.ifname)) return null;
    const linkKind = item.linkinfo?.info_kind ?? null;
    const interfaceKind = classifyInterface(item.link_type, linkKind);
    const operationalStatus = normalizeOperationalStatus(item.operstate, item.flags);
    const addresses = Array.isArray(item.addr_info) ? item.addr_info
      .filter((address) => address?.family === "inet" && typeof address.local === "string" && Number.isSafeInteger(address.prefixlen))
      .slice(0, 16)
      .map((address) => ({ ip_address: address.local, prefix_length: address.prefixlen })) : [];
    return {
      interface_index: item.ifindex,
      interface_alias: item.ifname,
      interface_description: `Linux ${item.link_type || linkKind || "network"} interface`,
      operational_status: operationalStatus,
      interface_kind: interfaceKind,
      connection_type: interfaceKind === "physical" ? (wirelessInterface(item.ifname) ? "wifi" : "ethernet") : "unknown",
      addresses,
      link_type: typeof item.link_type === "string" ? item.link_type : null,
      link_kind: typeof linkKind === "string" ? linkKind : null,
    };
  }).filter(Boolean);
  const interfaceByName = new Map(interfaces.map((item) => [item.interface_alias, item]));
  const routes = raw.routes.slice(0, MAX_ROUTES).map((item) => {
    const iface = interfaceByName.get(item?.dev);
    const destination = item?.dst === "default" || item?.dst === undefined ? "0.0.0.0/0" : item.dst;
    if (!iface || !validCidr(destination)) return null;
    return {
      destination_cidr: destination,
      interface_index: iface.interface_index,
      interface_alias: iface.interface_alias,
      gateway: isIP(item.gateway) === 4 ? item.gateway : null,
      preferred_source: isIP(item.prefsrc) === 4 ? item.prefsrc : null,
      metric: Number.isSafeInteger(item.metric) && item.metric >= 0 ? item.metric : 0,
    };
  }).filter(Boolean);
  const defaultRoute = routes.filter((route) => route.destination_cidr === "0.0.0.0/0")
    .sort((left, right) => left.metric - right.metric)[0] ?? null;
  const neighbors = raw.neighbors.slice(0, MAX_NEIGHBORS).map((item) => {
    const iface = interfaceByName.get(item?.dev);
    const state = normalizedNeighborState(item?.state);
    if (!iface || isIP(item?.dst) !== 4 || !state) return null;
    const mac = validMac(item.lladdr) && !zeroMac(item.lladdr) ? normalizeMac(item.lladdr) : null;
    return { ip: item.dst, state, mac, interface_index: iface.interface_index, interface_alias: iface.interface_alias };
  }).filter(Boolean);
  return {
    default_interface_index: defaultRoute?.interface_index ?? null,
    interfaces,
    routes,
    neighbors,
  };
}

export function buildLinuxDiscoveryPayload(state) {
  const scopeInputs = {
    default_interface_index: state?.default_interface_index ?? null,
    interfaces: (state?.interfaces ?? []).map(({ interface_index, interface_alias, operational_status, interface_kind, connection_type, addresses }) => ({
      interface_index, interface_alias, operational_status, interface_kind, connection_type, addresses,
    })),
    routes: (state?.routes ?? []).map(({ destination_cidr, interface_index }) => ({ destination_cidr, interface_index })),
  };
  const resolution = resolveNetworkScopes(scopeInputs);
  const primary = selectPrimaryDiscoveryScope(resolution);
  if (!primary) throw safeError("DISCOVERY_CONTEXT_UNAVAILABLE");
  const defaultRoute = (state.routes ?? []).find((route) =>
    route.destination_cidr === "0.0.0.0/0" && route.interface_index === primary.source_interface_index);
  const neighbors = (state.neighbors ?? []).filter((item) => item.interface_index === primary.source_interface_index)
    .map(({ ip, state: neighborState }) => ({ ip, state: neighborState }));
  return { ok: true, context: {
    connection_type: primary.connection_type,
    interface_alias: primary.source_interface,
    local_ipv4: primary.source_ipv4,
    subnet_cidr: primary.cidr,
    prefix_length: primary.prefix_length,
    default_gateway: defaultRoute?.gateway ?? null,
    neighbors,
    scope_inputs: scopeInputs,
  } };
}

export async function collectLinuxInspectionContext(target, options = {}) {
  if (!privateIpv4(target)) throw safeError("INVALID_INSPECTION_TARGET");
  const state = await (options.collectState ?? collectLinuxNetworkState)(options);
  const route = resolveLinuxTargetRoute(state, target);
  if (!route) throw safeError("INSPECTION_NETWORK_CONTEXT_UNAVAILABLE");
  const ping = options.ping;
  const observation = ping ? await ping(target, options.pingTimeoutMs ?? 1_000) : { success: false };
  const neighbor = route.same_subnet
    ? state.neighbors.find((item) => item.interface_index === route.interface.interface_index && item.ip === target)
    : null;
  return { ok: true, context: {
    target_ip: target,
    local_ip: route.source_ip,
    prefix_length: route.prefix_length,
    default_gateway: route.default_gateway,
    same_subnet: route.same_subnet,
    route_role: route.route_role,
    mac: neighbor?.mac ?? null,
    reachable: observation.success === true,
    is_this_device: route.is_this_device,
    interface_index: route.interface.interface_index,
    interface_alias: route.interface.interface_alias,
    interface_description: route.interface.interface_description,
    interface_type: route.interface.interface_kind === "physical" ? "physical"
      : route.interface.interface_kind === "unknown" ? "unknown" : "virtual",
  } };
}

export async function collectLinuxDiagnosticContext(target, options = {}) {
  const lookup = options.lookup ?? dns.promises.lookup;
  let resolved;
  try { resolved = await lookup(target.host, { family: 4 }); }
  catch { throw safeError("NETWORK_CONTEXT_UNAVAILABLE"); }
  const targetIp = typeof resolved === "string" ? resolved : resolved?.address;
  if (isIP(targetIp) !== 4) throw safeError("NETWORK_CONTEXT_UNAVAILABLE");
  const state = await (options.collectState ?? collectLinuxNetworkState)(options);
  const route = resolveLinuxTargetRoute(state, targetIp, { allowLoopback: true });
  if (!route) throw safeError("NO_ROUTE_TO_TARGET");
  const ping = options.ping;
  const observe = async (address) => {
    if (!address || !ping) return null;
    try {
      const result = await ping(address, options.pingTimeoutMs ?? 1_000);
      return { status: result.success ? "responded" : "no_response", latency_ms: result.success ? result.latency_ms : null };
    } catch { return { status: "no_response", latency_ms: null }; }
  };
  const tcpReady = options.tcpReady ?? checkTcpReadiness;
  const iface = route.network_interface;
  const prefix = route.network_prefix_length;
  const network = {
    host_name: os.hostname(),
    interface_alias: iface.interface_alias,
    interface_description: iface.interface_description,
    connection_type: iface.connection_type,
    operational_status: iface.operational_status,
    local_ipv4: route.network_source_ip,
    prefix_length: prefix,
    subnet_mask: prefixToMask(prefix),
    subnet_cidr: canonicalCidr(route.network_source_ip, prefix),
    default_gateway: route.default_gateway,
    dns_servers: (options.dnsServers ?? dns.getServers()).filter((item) => typeof item === "string" && item.length <= 64).slice(0, 6),
    link_speed_mbps: null,
  };
  return { ok: true, network_context: network, route_context: {
    target_host: target.host,
    resolved_target_ip: targetIp,
    route_type: route.next_hop ? "routed" : "on_link",
    source_ip: route.source_ip,
    interface_alias: route.interface.interface_alias,
    interface_index: route.interface.interface_index,
    next_hop: route.next_hop,
    route_metric: route.metric,
  }, preflight: {
    checked_at: new Date().toISOString(),
    interface_detected: true,
    route_resolved: true,
    gateway: await observe(route.next_hop),
    target: await observe(targetIp),
    iperf: { ready: await tcpReady(targetIp, target.iperf_port, 2_500), port: target.iperf_port },
  } };
}

export function resolveLinuxTargetRoute(state, target, options = {}) {
  if (isIP(target) !== 4) return null;
  const interfaces = Array.isArray(state?.interfaces) ? state.interfaces : [];
  const routes = Array.isArray(state?.routes) ? state.routes : [];
  const localMatch = interfaces.flatMap((iface) => iface.addresses.map((address) => ({ iface, address })))
    .find(({ address }) => address.ip_address === target);
  const loopback = target.startsWith("127.") && options.allowLoopback
    ? interfaces.find((iface) => iface.link_type === "loopback" || iface.interface_alias === "lo") : null;
  const bestRoute = routes.filter((route) => cidrContains(route.destination_cidr, target))
    .sort((left, right) => cidrPrefix(right.destination_cidr) - cidrPrefix(left.destination_cidr) || left.metric - right.metric)[0] ?? null;
  const iface = localMatch?.iface ?? loopback ?? interfaces.find((item) => item.interface_index === bestRoute?.interface_index);
  if (!iface) return null;
  const address = localMatch?.address ?? selectSourceAddress(iface, bestRoute?.preferred_source, target);
  if (!address) return null;
  const defaultRoute = routes.filter((item) => item.destination_cidr === "0.0.0.0/0" && item.interface_index === iface.interface_index)
    .sort((left, right) => left.metric - right.metric)[0] ?? null;
  const sameSubnet = cidrContains(canonicalCidr(address.ip_address, address.prefix_length), target);
  const isThisDevice = Boolean(localMatch);
  const routeRole = defaultRoute?.gateway === target ? "default_gateway" : sameSubnet ? "on_link" : "routed";
  const defaultPhysical = interfaces.find((item) => item.interface_index === state.default_interface_index && item.interface_kind === "physical") ?? iface;
  const defaultAddress = selectSourceAddress(defaultPhysical);
  return {
    interface: iface,
    source_ip: address.ip_address,
    prefix_length: address.prefix_length,
    same_subnet: sameSubnet,
    is_this_device: isThisDevice,
    route_role: routeRole,
    next_hop: sameSubnet || isThisDevice ? null : bestRoute?.gateway ?? null,
    default_gateway: defaultRoute?.gateway ?? routes.find((item) => item.destination_cidr === "0.0.0.0/0")?.gateway ?? null,
    metric: bestRoute?.metric ?? 0,
    network_interface: target.startsWith("127.") && defaultPhysical ? defaultPhysical : iface,
    network_source_ip: target.startsWith("127.") && defaultAddress ? defaultAddress.ip_address : address.ip_address,
    network_prefix_length: target.startsWith("127.") && defaultAddress ? defaultAddress.prefix_length : address.prefix_length,
  };
}

export function runBoundedJsonCommand(executable, args, options = {}) {
  const spawnProcess = options.spawnProcess ?? spawn;
  const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(executable, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch { reject(safeError("LINUX_CONTEXT_UNAVAILABLE")); return; }
    let output = "", bytes = 0, settled = false;
    const finish = (callback) => { if (settled) return; settled = true; clearTimeout(timer); callback(); };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(() => reject(safeError("LINUX_CONTEXT_UNAVAILABLE")));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_COMMAND_OUTPUT_BYTES) {
        try { child.kill(); } catch {}
        finish(() => reject(safeError("LINUX_CONTEXT_INVALID")));
      } else output += chunk.toString("utf8");
    });
    child.stderr.on("data", () => {});
    child.once("error", () => finish(() => reject(safeError("LINUX_CONTEXT_UNAVAILABLE"))));
    child.once("close", (code) => finish(() => {
      if (code !== 0) return reject(safeError("LINUX_CONTEXT_UNAVAILABLE"));
      try {
        const parsed = JSON.parse(output.trim());
        if (!Array.isArray(parsed)) throw new Error("not an array");
        resolve(parsed);
      } catch { reject(safeError("LINUX_CONTEXT_INVALID")); }
    }));
  });
}

export function checkTcpReadiness(address, port, timeoutMs = 2_500, createConnection = net.createConnection) {
  if (isIP(address) !== 4 || !Number.isSafeInteger(port) || port < 1 || port > 65535) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    let socket;
    let timer;
    const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); socket?.destroy(); resolve(value); };
    try { socket = createConnection({ host: address, port }); }
    catch { finish(false); return; }
    timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function classifyInterface(linkType, linkKind) {
  if (linkType === "loopback") return "virtual_internal";
  if (TUNNEL_LINK_KINDS.has(linkKind)) return "tunnel";
  if (INTERNAL_LINK_KINDS.has(linkKind)) return "virtual_internal";
  if (linkKind) return "virtual";
  return linkType === "ether" ? "physical" : "unknown";
}
function normalizeOperationalStatus(state, flags) {
  if (String(state).toUpperCase() === "UP" || (Array.isArray(flags) && flags.includes("UP"))) return "up";
  if (["DOWN", "DORMANT", "LOWERLAYERDOWN", "NOTPRESENT"].includes(String(state).toUpperCase())) return "down";
  return "unknown";
}
function normalizedNeighborState(value) {
  const values = Array.isArray(value) ? value : [value];
  for (const state of values) {
    const normalized = USABLE_NEIGHBOR_STATES.get(String(state).toUpperCase());
    if (normalized) return normalized;
  }
  return null;
}
function selectSourceAddress(iface, preferred, target) {
  if (isIP(preferred) === 4) {
    const match = iface.addresses.find((item) => item.ip_address === preferred);
    if (match) return match;
  }
  if (target) {
    const onLink = iface.addresses.find((item) => cidrContains(canonicalCidr(item.ip_address, item.prefix_length), target));
    if (onLink) return onLink;
  }
  return iface.addresses.find((item) => isIP(item.ip_address) === 4 && !item.ip_address.startsWith("169.254.")) ?? null;
}
function validCidr(value) { const [ip, raw, extra] = String(value).split("/"); const prefix = Number(raw); return extra === undefined && isIP(ip) === 4 && /^\d{1,2}$/.test(raw ?? "") && prefix >= 0 && prefix <= 32; }
function cidrPrefix(value) { return Number(String(value).split("/")[1]); }
function cidrContains(cidr, ip) {
  if (!validCidr(cidr) || isIP(ip) !== 4) return false;
  const [network, rawPrefix] = cidr.split("/");
  const prefix = Number(rawPrefix), mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipNumber(network) & mask) === (ipNumber(ip) & mask);
}
function ipNumber(value) { return value.split(".").reduce((total, part) => total * 256 + Number(part), 0) >>> 0; }
function prefixToMask(prefix) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return [24, 16, 8, 0].map((shift) => (mask >>> shift) & 255).join(".");
}
function safeInterfaceName(value) { return typeof value === "string" && value.length >= 1 && value.length <= 64 && /^[a-zA-Z0-9_.:@-]+$/.test(value); }
function validMac(value) { return typeof value === "string" && /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(value); }
function zeroMac(value) { return /^00:00:00:00:00:00$/i.test(value); }
function normalizeMac(value) { return value.toUpperCase(); }
function privateIpv4(value) { if (isIP(value) !== 4) return false; const [a, b] = value.split(".").map(Number); return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168); }
