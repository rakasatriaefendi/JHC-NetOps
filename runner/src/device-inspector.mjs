import { spawn } from "node:child_process";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { safeError } from "./config.mjs";
import { collectLinuxInspectionContext } from "./linux-network-context.mjs";
import { pingTarget } from "./network-health.mjs";
import { resolvePlatform } from "./platform.mjs";

const RUNNER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = path.join(RUNNER_ROOT, "scripts", "get-device-inspection-context.ps1");
const MAX_OUTPUT_BYTES = 16 * 1024;

export function buildInspectionContextInvocation(target, scriptPath = SCRIPT_PATH) {
  if (!privateIpv4(target)) throw safeError("INVALID_INSPECTION_TARGET");
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-TargetIp", target];
}

export function collectInspectionContext(target, spawnProcess = spawn, options = {}) {
  const platform = resolvePlatform(options.platform);
  if (platform === "linux") {
    return (options.collectLinuxContext ?? collectLinuxInspectionContext)(target, {
      ...options,
      spawnProcess,
      ping: options.ping ?? ((ipAddress, timeoutMs, signal) => pingTarget(ipAddress, timeoutMs, signal, spawnProcess, platform)),
    }).then((value) => validateInspectionContext(value, target)).catch((error) => {
      if (error?.code === "LINUX_CONTEXT_INVALID" || error?.code === "INSPECTION_CONTEXT_INVALID") throw safeError("INSPECTION_CONTEXT_INVALID");
      if (error?.code === "INVALID_INSPECTION_TARGET") throw error;
      throw safeError("INSPECTION_NETWORK_CONTEXT_UNAVAILABLE");
    });
  }
  const args = buildInspectionContextInvocation(target);
  return new Promise((resolve, reject) => {
    const child = spawnProcess("powershell.exe", args, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", bytes = 0, settled = false;
    const finish = (callback) => { if (settled) return; settled = true; clearTimeout(timer); callback(); };
    const timer = setTimeout(() => { child.kill(); finish(() => reject(safeError("INSPECTION_NETWORK_CONTEXT_UNAVAILABLE"))); }, 15_000);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) { child.kill(); finish(() => reject(safeError("INSPECTION_CONTEXT_INVALID"))); return; }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", () => {});
    child.once("error", () => finish(() => reject(safeError("INSPECTION_NETWORK_CONTEXT_UNAVAILABLE"))));
    child.once("close", (code) => finish(() => {
      if (code !== 0) return reject(safeError(inspectionContextFailureCode(stdout)));
      try { resolve(validateInspectionContext(JSON.parse(stdout.replaceAll("\u0000", "").trim()), target)); }
      catch (error) { reject(error?.code ? error : safeError("INSPECTION_CONTEXT_INVALID")); }
    }));
  });
}

export function inspectionContextFailureCode(stdout) {
  try {
    const payload = JSON.parse(String(stdout ?? "").replaceAll("\u0000", "").trim());
    if (payload?.error_code === "INSPECTION_NETWORK_CONTEXT_UNAVAILABLE") return payload.error_code;
  } catch {}
  return "INSPECTION_NETWORK_CONTEXT_UNAVAILABLE";
}

export function validateInspectionContext(value, target) {
  const context = value?.ok === true ? value.context : null;
  if (!context || context.target_ip !== target || !privateIpv4(target) || isIP(context.local_ip) !== 4 ||
      !Number.isInteger(context.prefix_length) || context.prefix_length < 8 || context.prefix_length > 32 ||
      !["default_gateway", "on_link", "routed"].includes(context.route_role) || typeof context.same_subnet !== "boolean" ||
      typeof context.reachable !== "boolean" || typeof context.is_this_device !== "boolean" ||
      !Number.isInteger(context.interface_index) || context.interface_index < 1 || context.interface_index > 1_000_000 ||
      typeof context.interface_alias !== "string" || !context.interface_alias.trim() || context.interface_alias.length > 256 ||
      typeof context.interface_description !== "string" || context.interface_description.length > 512 ||
      !["physical", "virtual", "unknown"].includes(context.interface_type)) throw safeError("INSPECTION_CONTEXT_INVALID");
  if (context.route_role === "default_gateway" && context.default_gateway !== target) throw safeError("INSPECTION_CONTEXT_INVALID");
  if (context.route_role === "routed" && context.same_subnet) throw safeError("INSPECTION_CONTEXT_INVALID");
  if (context.is_this_device && context.local_ip !== target) throw safeError("INSPECTION_CONTEXT_INVALID");
  const mac = context.same_subnet && validMac(context.mac) ? normalizeMac(context.mac) : null;
  return { target_ip: target, local_ip: context.local_ip, prefix_length: context.prefix_length,
    default_gateway: isIP(context.default_gateway) === 4 ? context.default_gateway : null,
    same_subnet: context.same_subnet, route_role: context.route_role, mac, reachable: context.reachable,
    is_this_device: context.is_this_device, interface_index: context.interface_index,
    interface_alias: context.interface_alias.trim(), interface_description: context.interface_description.trim(),
    interface_type: context.interface_type };
}

export function validateInspectionScope(session, context) {
  if (session.authorization_source === "discovery" && !context.same_subnet) throw safeError("INVALID_INSPECTION_TARGET");
  if (session.authorization_source === "inventory" && !privateIpv4(session.target_ip)) throw safeError("INVALID_INSPECTION_TARGET");
  if (!context.same_subnet && context.mac !== null) throw safeError("INSPECTION_CONTEXT_INVALID");
  return context;
}

function privateIpv4(value) { if (isIP(value) !== 4) return false; const [a, b] = value.split(".").map(Number); return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168); }
function validMac(value) { return typeof value === "string" && /^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/i.test(value); }
function normalizeMac(value) { return value.replaceAll("-", ":").toUpperCase(); }
