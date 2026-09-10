import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import { normalizePrivateCidr, normalizePrivateIpv4, representativePrivateIpv4 } from "./scan-contract.js";
import { ASSET_SCAN_MAX_NETWORKS, type DetectedScanNetwork, type ScanNetworkDetection, type ScanNetworkRoute } from "./scan-network-contract.js";

const IP_PATH = "/usr/sbin/ip";
const IP_OUTPUT_LIMIT = 128 * 1024;

export interface ScanNetworkAdapter {
  detect(signal: AbortSignal): Promise<ScanNetworkDetection>;
  inspect(cidr: string, signal: AbortSignal): Promise<ScanNetworkRoute>;
}

export type IpCommand = (args: readonly string[], signal: AbortSignal) => Promise<string>;

export class LinuxIpRouteAdapter implements ScanNetworkAdapter {
  constructor(private readonly command: IpCommand = runIpCommand) {}

  async detect(signal: AbortSignal): Promise<ScanNetworkDetection> {
    try {
      const output = await this.command(["-j", "addr", "show"], signal);
      return { available: true, networks: parseIpAddressJson(output), reason_code: null };
    } catch {
      return { available: false, networks: [], reason_code: "DETECTOR_UNAVAILABLE" };
    }
  }

  async inspect(cidr: string, signal: AbortSignal): Promise<ScanNetworkRoute> {
    const normalized = normalizePrivateCidr(cidr);
    const representative = normalized ? representativePrivateIpv4(normalized) : null;
    if (!normalized || !representative) return unknownRoute(cidr);
    try {
      const output = await this.command(["-j", "route", "get", representative], signal);
      return parseIpRouteJson(normalized, output);
    } catch (error) {
      return error instanceof IpRouteCommandError && error.kind === "unreachable"
        ? { cidr: normalized, route_kind: "unreachable", interface_name: null, source_ip: null, gateway: null, reason_code: "ROUTE_UNAVAILABLE" }
        : unknownRoute(normalized);
    }
  }
}

export function parseIpAddressJson(output: string): readonly DetectedScanNetwork[] {
  const value: unknown = JSON.parse(output);
  if (!Array.isArray(value)) throw new Error("IP_ADDRESS_OUTPUT_INVALID");
  const unique = new Map<string, DetectedScanNetwork>();
  for (const item of value) {
    if (!record(item) || typeof item.ifname !== "string" || item.ifname === "lo" ||
        !Array.isArray(item.flags) || !item.flags.includes("UP") || !Array.isArray(item.addr_info)) continue;
    for (const address of item.addr_info) {
      if (!record(address) || address.family !== "inet" || address.scope !== "global" ||
          typeof address.local !== "string" || !Number.isSafeInteger(address.prefixlen)) continue;
      const sourceIp = normalizePrivateIpv4(address.local);
      const cidr = normalizePrivateCidr(`${address.local}/${String(address.prefixlen)}`);
      if (!sourceIp || !cidr || unique.has(cidr)) continue;
      unique.set(cidr, { cidr, interface_name: item.ifname.slice(0, 64), source_ip: sourceIp, route_kind: "direct" });
    }
  }
  return [...unique.values()].sort((left, right) => left.cidr.localeCompare(right.cidr)).slice(0, ASSET_SCAN_MAX_NETWORKS);
}

export function parseIpRouteJson(cidr: string, output: string): ScanNetworkRoute {
  const value: unknown = JSON.parse(output);
  const route = Array.isArray(value) ? value[0] : null;
  if (!record(route)) return unknownRoute(cidr);
  if (["unreachable", "blackhole", "prohibit", "throw"].includes(String(route.type))) {
    return { cidr, route_kind: "unreachable", interface_name: null, source_ip: null, gateway: null, reason_code: "ROUTE_UNAVAILABLE" };
  }
  const interfaceName = typeof route.dev === "string" && /^[A-Za-z0-9_.:@-]{1,64}$/.test(route.dev) ? route.dev : null;
  if (!interfaceName) return unknownRoute(cidr);
  const gateway = normalizePrivateIpv4(route.gateway);
  if (route.gateway !== undefined && route.gateway !== null && !gateway) return unknownRoute(cidr);
  const sourceIp = normalizePrivateIpv4(route.prefsrc) ?? normalizePrivateIpv4(route.src);
  return {
    cidr,
    route_kind: gateway ? "routed" : "direct",
    interface_name: interfaceName,
    source_ip: sourceIp,
    gateway,
    reason_code: "ROUTE_AVAILABLE",
  };
}

function runIpCommand(args: readonly string[], signal: AbortSignal): Promise<string> {
  return runChild(spawn(IP_PATH, [...args], {
    detached: false, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  }), signal);
}

class IpRouteCommandError extends Error {
  constructor(readonly kind: "failed" | "unreachable") { super("IP_ROUTE_COMMAND_FAILED"); }
}

function runChild(child: ChildProcessByStdio<null, Readable, Readable>, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(stdout);
    };
    const abort = () => child.kill("SIGTERM");
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > IP_OUTPUT_LIMIT) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk: string) => { if (stderr.length < 256) stderr += chunk; });
    child.once("error", () => finish(new IpRouteCommandError("failed")));
    child.once("close", (code) => finish(
      signal.aborted ? new IpRouteCommandError("failed")
        : Buffer.byteLength(stdout, "utf8") > IP_OUTPUT_LIMIT ? new IpRouteCommandError("failed")
          : code === 0 ? undefined
            : new IpRouteCommandError(/unreachable|no route/i.test(stderr) ? "unreachable" : "failed"),
    ));
  });
}

function unknownRoute(cidr: string): ScanNetworkRoute {
  return { cidr, route_kind: "unknown", interface_name: null, source_ip: null, gateway: null, reason_code: "ROUTE_UNKNOWN" };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
