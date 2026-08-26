import { spawn } from "node:child_process";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { safeError } from "./config.mjs";
import { pingProcessWallTimeout, pingTarget } from "./network-health.mjs";

const RUNNER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = path.join(RUNNER_ROOT, "scripts", "get-discovery-context.ps1");
const MAX_OUTPUT_BYTES = 64 * 1024;
const DISCOVERY_CONCURRENCY = 4;
const PING_TIMEOUT_MS = 400;
const PROGRESS_BATCH = 32;

export function discoveryWorstCaseWallMs(hostCount, concurrency = DISCOVERY_CONCURRENCY, timeoutMs = PING_TIMEOUT_MS) {
  return Math.ceil(hostCount / concurrency) * pingProcessWallTimeout(timeoutMs);
}

export function buildDiscoveryContextInvocation(scriptPath = SCRIPT_PATH) {
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath];
}

export function collectDiscoveryContext(spawnProcess = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess("powershell.exe", buildDiscoveryContextInvocation(), {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let bytes = 0;
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(safeError("DISCOVERY_CONTEXT_UNAVAILABLE")));
    }, 15_000);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(() => reject(safeError("DISCOVERY_CONTEXT_INVALID")));
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", () => {});
    child.once("error", () => finish(() => reject(safeError("DISCOVERY_CONTEXT_UNAVAILABLE"))));
    child.once("close", (code) => finish(() => {
      if (code !== 0) return reject(safeError("DISCOVERY_CONTEXT_UNAVAILABLE"));
      try {
        const parsed = JSON.parse(stdout.replaceAll("\u0000", "").trim());
        resolve(validateDiscoveryContext(parsed));
      } catch (error) {
        reject(error?.code ? error : safeError("DISCOVERY_CONTEXT_INVALID"));
      }
    }));
  });
}

export function validateDiscoveryContext(value) {
  const context = value?.ok === true ? value.context : null;
  if (!context || !["wifi", "ethernet", "unknown"].includes(context.connection_type) ||
      typeof context.interface_alias !== "string" || !context.interface_alias.trim() || context.interface_alias.length > 256 ||
      isIP(context.local_ipv4) !== 4 || typeof context.subnet_cidr !== "string") {
    throw safeError("DISCOVERY_CONTEXT_INVALID");
  }
  const [network, rawPrefix, extra] = context.subnet_cidr.split("/");
  const prefix = Number(rawPrefix);
  if (extra !== undefined || isIP(network) !== 4 || !Number.isInteger(prefix) || prefix < 24) {
    throw safeError(prefix < 24 ? "DISCOVERY_SCOPE_TOO_LARGE" : "DISCOVERY_CONTEXT_INVALID");
  }
  if (prefix > 30 || Number(context.prefix_length) !== prefix || !sameSubnet(context.local_ipv4, network, prefix)) {
    throw safeError("DISCOVERY_CONTEXT_INVALID");
  }
  const usable = new Set(usableAddresses(`${network}/${prefix}`));
  const rawNeighbors = Array.isArray(context.neighbors) ? context.neighbors : [];
  const filtered = rawNeighbors
    .filter((n) => {
      if (typeof n === "string") return isIP(n) === 4 && usable.has(n);
      return n && typeof n.ip === "string" && isIP(n.ip) === 4 && usable.has(n.ip);
    })
    .map((n) => typeof n === "string" ? { ip: n, state: "Stale" } : { ip: n.ip, state: typeof n.state === "string" ? n.state : "Stale" });
  const neighbors = [...new Map(filtered.map((n) => [n.ip, n])).values()].slice(0, 254);
  const neighborIps = neighbors.map((n) => n.ip);
  const defaultGateway = context.default_gateway === null || context.default_gateway === undefined
    ? null
    : isIP(context.default_gateway) === 4 && sameSubnet(context.default_gateway, network, prefix)
      ? context.default_gateway
      : null;
  return {
    connection_type: context.connection_type,
    interface_alias: context.interface_alias,
    local_ipv4: context.local_ipv4,
    subnet_cidr: `${network}/${prefix}`,
    prefix_length: prefix,
    default_gateway: defaultGateway,
    neighbors,
    total_hosts: 2 ** (32 - prefix) - 2,
  };
}

export function publicDiscoveryContext(context) {
  return {
    connection_type: context.connection_type,
    interface_alias: context.interface_alias,
    local_ipv4: context.local_ipv4,
    subnet_cidr: context.subnet_cidr,
  };
}

export async function runNetworkDiscovery(context, onProgress, options = {}) {
  const ping = options.ping ?? pingTarget;
  const concurrency = options.concurrency ?? DISCOVERY_CONCURRENCY;
  const timeoutMs = options.timeoutMs ?? PING_TIMEOUT_MS;
  const addresses = usableAddresses(context.subnet_cidr);
  const results = new Map();
  const add = (ipAddress, evidence, latency = null, neighborState = null) => {
    const current = results.get(ipAddress);
    const mergedEvidence = [...new Set([...(current?.evidence ?? []), ...evidence])].sort();
    const newNeighborState = current?.neighbor_state ?? neighborState;
    // strongest: Reachable > Stale/Delay/Probe/Permanent
    if (neighborState && newNeighborState) {
      const order = { Reachable: 3, Stale: 2, Delay: 2, Probe: 2, Permanent: 1 };
      if ((order[neighborState] ?? 0) > (order[newNeighborState] ?? 0)) {
        results.set(ipAddress, { ...current, neighbor_state: neighborState });
      }
    } else if (neighborState && !newNeighborState) {
      results.set(ipAddress, { ...current, neighbor_state: neighborState });
    }
    results.set(ipAddress, {
      ip_address: ipAddress,
      evidence: mergedEvidence,
      latency_ms: latency ?? current?.latency_ms ?? null,
      is_this_device: ipAddress === context.local_ipv4,
      is_gateway: ipAddress === context.default_gateway,
      neighbor_state: newNeighborState,
    });
  };
  const reachability = (hasIcmp, neighborState) => {
    if (hasIcmp) return "icmp_verified";
    if (neighborState === "Reachable") return "l2_observed";
    return "cached_only";
  };
  // seed local device
  add(context.local_ipv4, ["neighbor"], null, "Reachable");
  // seed neighbors from context
  for (const n of context.neighbors) add(n.ip, ["neighbor"], null, n.state);

  let scanned = 0;
  let nextIndex = 0;
  let lastPublished = 0;
  const publish = async (force = false) => {
    if (!force && scanned - lastPublished < PROGRESS_BATCH) return;
    lastPublished = scanned;
    await onProgress({ scanned_hosts: scanned, results: sortedResults(results) });
  };
  async function worker() {
    while (nextIndex < addresses.length) {
      const index = nextIndex++;
      const address = addresses[index];
      if (address !== context.local_ipv4) {
        try {
          const observation = await ping(address, timeoutMs);
          if (observation.success) {
            const current = results.get(address);
            const hasIcmp = true;
            const neighborState = current?.neighbor_state ?? null;
            add(address, ["icmp"], observation.latency_ms, neighborState);
            // update reachability after ICMP success overrides
            const updated = results.get(address);
            updated.reachability_evidence = "icmp_verified";
          }
        } catch {}
      }
      scanned += 1;
      await publish(false);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, addresses.length) }, () => worker()));
  // finalize reachability for all results
  for (const [, value] of results) {
    if (!value.reachability_evidence) {
      value.reachability_evidence = reachability(value.evidence.includes("icmp"), value.neighbor_state);
    }
  }
  await publish(true);
  return { scanned_hosts: scanned, results: sortedResults(results) };
}

export function usableAddresses(cidr) {
  const [network, rawPrefix] = cidr.split("/");
  const prefix = Number(rawPrefix);
  if (isIP(network) !== 4 || !Number.isInteger(prefix) || prefix < 24 || prefix > 30) throw safeError("DISCOVERY_CONTEXT_INVALID");
  const base = ipNumber(network);
  const count = 2 ** (32 - prefix);
  return Array.from({ length: count - 2 }, (_, index) => numberIp(base + index + 1));
}

function sortedResults(results) {
  return [...results.values()].sort((left, right) => ipNumber(left.ip_address) - ipNumber(right.ip_address));
}
function ipNumber(value) { return value.split(".").reduce((total, part) => total * 256 + Number(part), 0) >>> 0; }
function numberIp(value) { return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join("."); }
function sameSubnet(ip, network, prefix) { const mask = (0xffffffff << (32 - prefix)) >>> 0; return (ipNumber(ip) & mask) === (ipNumber(network) & mask); }
