import { isIP } from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { safeError } from "./config.mjs";

const RUNNER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = path.join(RUNNER_ROOT, "scripts", "get-network-context.ps1"); 
const MAX_OUTPUT_BYTES = 64 * 1024;

export function buildNetworkContextInvocation(target, scriptPath = SCRIPT_PATH) {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-TargetHost",
    target.host,
    "-TargetPort",
    String(target.iperf_port),
  ];
}

export function collectNetworkContext(target, spawnProcess = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess("powershell.exe", buildNetworkContextInvocation(target), {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let outputBytes = 0;
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(safeError("NETWORK_CONTEXT_UNAVAILABLE")));
    }, 20_000);
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(() => reject(safeError("NETWORK_CONTEXT_INVALID")));
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", () => {});
    child.once("error", () => finish(() => reject(safeError("NETWORK_CONTEXT_UNAVAILABLE"))));
    child.once("close", (code) => finish(() => {
      if (code !== 0) return reject(safeError("NETWORK_CONTEXT_UNAVAILABLE"));
      let value;
      try { value = JSON.parse(stdout.replaceAll("\u0000", "").trim()); }
      catch { return reject(safeError("NETWORK_CONTEXT_INVALID")); }
      try { resolve(validateNetworkProbe(value, target)); }
      catch (error) { reject(error); }
    }));
  });
}

export function validateNetworkProbe(value, target) {
  if (!record(value) || value.ok !== true || !record(value.network_context) || !record(value.route_context) || !record(value.preflight)) {
    throw safeError("NETWORK_CONTEXT_INVALID");
  }
  const network = value.network_context;
  const route = value.route_context;
  const preflight = value.preflight;
  requireText(network.host_name, 128);
  requireText(network.interface_alias, 256);
  requireText(network.interface_description, 512);
  if (!["wifi", "ethernet", "unknown"].includes(network.connection_type)) throw safeError("NETWORK_CONTEXT_INVALID");
  if (network.operational_status !== "up") throw safeError("NETWORK_INTERFACE_DOWN");
  requireIp(network.local_ipv4);
  requireInteger(network.prefix_length, 0, 32);
  requireIp(network.subnet_mask);
  requireCidr(network.subnet_cidr);
  optionalIp(network.default_gateway);
  if (!Array.isArray(network.dns_servers) || network.dns_servers.length > 6 || !network.dns_servers.every((item) => typeof item === "string" && item.length <= 64)) throw safeError("NETWORK_CONTEXT_INVALID");
  optionalNumber(network.link_speed_mbps, 0, 1_000_000);
  optionalText(network.ssid, 128);
  optionalNumber(network.wifi_signal_percent, 0, 100);
  optionalNumber(network.wifi_receive_rate_mbps, 0, 1_000_000);
  optionalNumber(network.wifi_transmit_rate_mbps, 0, 1_000_000);

  if (route.target_host !== target.host || !isIP(route.resolved_target_ip) || !isIP(route.source_ip)) throw safeError("NETWORK_CONTEXT_INVALID");
  if (!["on_link", "routed"].includes(route.route_type)) throw safeError("NETWORK_CONTEXT_INVALID");
  requireText(route.interface_alias, 256);
  requireInteger(route.interface_index, 1, 1_000_000);
  optionalIp(route.next_hop);
  requireInteger(route.route_metric, 0, 1_000_000);
  if ((route.route_type === "on_link") !== (route.next_hop === null)) throw safeError("NETWORK_CONTEXT_INVALID");

  if (preflight.interface_detected !== true || preflight.route_resolved !== true || !timestamp(preflight.checked_at)) throw safeError("NETWORK_CONTEXT_INVALID");
  validatePing(preflight.gateway, true);
  validatePing(preflight.target, false);
  if (!record(preflight.iperf) || typeof preflight.iperf.ready !== "boolean" || preflight.iperf.port !== target.iperf_port) throw safeError("NETWORK_CONTEXT_INVALID");

  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > 24_000) throw safeError("NETWORK_CONTEXT_INVALID");
  return {
    network_context: { ...network },
    route_context: { ...route, target_id: target.id },
    preflight: { ...preflight },
  };
}

function validatePing(value, nullable) {
  if (nullable && value === null) return;
  if (!record(value) || !["responded", "no_response"].includes(value.status)) throw safeError("NETWORK_CONTEXT_INVALID");
  optionalNumber(value.latency_ms, 0, 60_000);
}
function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function requireText(value, max) { if (typeof value !== "string" || !value.trim() || value.length > max || /[\r\n]/.test(value)) throw safeError("NETWORK_CONTEXT_INVALID"); }
function optionalText(value, max) { if (value !== undefined && value !== null) requireText(value, max); }
function requireInteger(value, min, max) { if (!Number.isSafeInteger(value) || value < min || value > max) throw safeError("NETWORK_CONTEXT_INVALID"); }
function optionalNumber(value, min, max) { if (value !== undefined && value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)) throw safeError("NETWORK_CONTEXT_INVALID"); }
function requireIp(value) { if (typeof value !== "string" || !isIP(value)) throw safeError("NETWORK_CONTEXT_INVALID"); }
function optionalIp(value) { if (value !== null && value !== undefined) requireIp(value); }
function requireCidr(value) { const [ip, prefix, extra] = typeof value === "string" ? value.split("/") : []; if (extra !== undefined || !isIP(ip) || !/^\d{1,2}$/.test(prefix ?? "") || Number(prefix) > 32) throw safeError("NETWORK_CONTEXT_INVALID"); }
function timestamp(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
