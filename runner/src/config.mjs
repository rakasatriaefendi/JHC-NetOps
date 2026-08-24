import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RUNNER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IDENTIFIER = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export function loadRunnerConfig(configPath = path.join(RUNNER_ROOT, "config.local.json")) {
  const absolutePath = path.resolve(configPath);
  const value = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  validateConfig(value);
  const envPath = path.resolve(path.dirname(absolutePath), value.environment_file);
  loadEnvFile(envPath);
  return {
    ...value,
    config_path: absolutePath,
    environment_path: envPath,
    agent_path: joinWslPath(value.wsl_project_root, value.agent_executable),
    python_path: joinWslPath(value.wsl_project_root, "agent/.venv/bin/python"),
  };
}

export function loadEnvFile(filename) {
  if (!fs.existsSync(filename)) return;
  for (const rawLine of fs.readFileSync(filename, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function validateJob(job, config) {
  if (!job || typeof job !== "object") throw safeError("INVALID_JOB");
  if (!isUuid(job.id) || job.runner_id !== config.runner_id || job.type !== "bandwidth_and_path") {
    throw safeError("INVALID_JOB");
  }
  if (!isLabel(job.source_label)) throw safeError("INVALID_JOB");
  if (!publicCapabilities(config).durations.includes(job.duration_seconds)) throw safeError("INVALID_JOB");
  if (job.connection_type !== "wifi" && job.connection_type !== "ethernet") {
    throw safeError("INVALID_CONNECTION_TYPE");
  }
  const target = availableTargets(config).find((item) => item.id === job.target_id);
  if (!target) throw safeError("INVALID_TARGET");
  if (job.environment !== target.environment) throw safeError("INVALID_TARGET");
  return {
    id: job.id,
    source_label: job.source_label,
    connection_type: job.connection_type,
    duration_seconds: job.duration_seconds,
    target,
  };
}

export function validateTrafficSession(session, config) {
  if (!session || typeof session !== "object" || !isUuid(session.id) || session.runner_id !== config.runner_id) throw safeError("INVALID_TRAFFIC_SESSION");
  if (!config.traffic_durations_seconds.includes(session.duration_seconds)) throw safeError("INVALID_TRAFFIC_SESSION");
  return { id: session.id, duration_seconds: session.duration_seconds };
}

export function validateDiscoverySession(session, config) {
  if (!session || typeof session !== "object" || !isUuid(session.session_id) || session.runner_id !== config.runner_id ||
      (session.phase !== "prepare" && session.phase !== "scan")) throw safeError("INVALID_DISCOVERY_SESSION");
  return { session_id: session.session_id, phase: session.phase };
}

export function validateInspectionSession(session, config) {
  if (!session || typeof session !== "object" || !isUuid(session.inspection_id) || session.runner_id !== config.runner_id ||
      !privateIpv4(session.target_ip) || !["discovery", "inventory"].includes(session.authorization_source)) {
    throw safeError("INVALID_INSPECTION_SESSION");
  }
  return { inspection_id: session.inspection_id, target_ip: session.target_ip, authorization_source: session.authorization_source };
}

export function validatePreflightRequest(request, config) {
  if (!request || typeof request !== "object" || !isUuid(request.request_id) || request.runner_id !== config.runner_id) {
    throw safeError("INVALID_JOB");
  }
  const target = availableTargets(config).find((item) => item.id === request.target_id);
  if (!target) throw safeError("INVALID_TARGET");
  return { request_id: request.request_id, target };
}

export function publicCapabilities(config, runtimeCapabilities = {}) {
  const demoEnabled = diagnosticDemoEnabled(config);
  const snmpEnabled = config.enable_snmp_telemetry === true;
  return {
    source_locations: config.source_locations.filter((label) => demoEnabled || label !== "Local Development"),
    targets: availableTargets(config).map(({ id, label, host, iperf_port, environment }) => ({
      id, label, host, iperf_port, environment,
    })),
    durations: config.durations.filter((duration) => duration === 5 || duration === 10),
    traffic_durations_seconds: config.traffic_durations_seconds,
    operations: ["bandwidth_and_path", "traffic_live", "network_discovery", "device_inspect"],
    ...(runtimeCapabilities.device_inspector ? { device_inspector: runtimeCapabilities.device_inspector } : {}),
    snmp_telemetry: snmpEnabled ? {
      enabled: true,
      max_concurrent: config.snmp_max_concurrent,
      poll_intervals_seconds: config.snmp_poll_intervals_seconds,
      versions: ["3", "2c"],
      credential_profiles: Object.keys(config.snmp_credential_profiles ?? {}),
    } : { enabled: false },
  };
}

export function safeError(code, message = safeMessage(code)) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function safeMessage(code) {
  return ({
    AGENT_PROTOCOL_ERROR: "Agent returned an invalid progress event",
    AGENT_PYTHON_UNSUPPORTED: "Project agent Python must be version 3.11 or newer",
    AGENT_VENV_MISSING: "Project agent virtual environment is unavailable",
    BACKEND_UPLOAD_FAILED: "Diagnostic results could not be saved",
    DOWNLOAD_FAILED: "Download measurement failed",
    INVALID_CONNECTION_TYPE: "Connection type is not authorized",
    INVALID_JOB: "Diagnostic job is invalid",
    INVALID_TARGET: "Diagnostic target is not authorized locally",
    INVALID_TRAFFIC_SESSION: "Traffic capture session is invalid",
    INVALID_DISCOVERY_SESSION: "Network discovery session is invalid",
    INVALID_INSPECTION_SESSION: "Device inspection session is invalid",
    INVALID_INSPECTION_TARGET: "Device inspection target is not authorized locally",
    INSPECTION_CONTEXT_UNAVAILABLE: "Windows inspection context could not be collected",
    INSPECTION_NETWORK_CONTEXT_UNAVAILABLE: "Windows network context for the inspection target could not be resolved",
    INSPECTION_CONTEXT_INVALID: "Windows inspection context was invalid",
    INSPECTION_WSL_UNAVAILABLE: "The configured WSL environment could not be started for Device Inspector",
    INSPECTION_AGENT_UNAVAILABLE: "The Device Inspector agent is unavailable in the configured WSL environment",
    INSPECTION_TIMEOUT: "Device inspection exceeded its safe execution time",
    INSPECTION_FAILED: "Device inspection could not be completed",
    DISCOVERY_CONTEXT_UNAVAILABLE: "Windows discovery context could not be collected",
    DISCOVERY_CONTEXT_INVALID: "Windows discovery context was invalid",
    DISCOVERY_SCOPE_TOO_LARGE: "Detected subnet is larger than the authorized discovery limit",
    DISCOVERY_FAILED: "Network discovery could not be completed",
    TRAFFIC_CAPTURE_FAILED: "Traffic capture could not be completed",
    IPERF3_MISSING: "Compatible iperf3 is unavailable in WSL",
    IPERF3_SERVER_UNAVAILABLE: "The iperf3 target server is unavailable",
    JOB_TIMEOUT: "Diagnostic job exceeded its safe time limit",
    MTR_FAILED: "Path diagnostic failed",
    MTR_MISSING: "mtr is unavailable in WSL",
    RUNNER_INTERNAL_ERROR: "Local diagnostic runner encountered an error",
    TARGET_UNREACHABLE: "Diagnostic target is unreachable",
    UPLOAD_FAILED: "Upload measurement failed",
    WSL_DISTRO_NOT_FOUND: "Configured WSL distribution was not found",
    WSL_INVOCATION_TIMEOUT: "WSL did not become ready before the preflight timeout",
    WSL_READINESS_TIMEOUT: "WSL did not become ready for Device Inspector in time",
    WSL_RUNTIME_FAILED: "WSL could not run the required Linux command",
    WSL_START_FAILED: "WSL diagnostic agent could not be started",
    NETWORK_CONTEXT_UNAVAILABLE: "Windows network context could not be collected",
    NETWORK_CONTEXT_INVALID: "Windows network context was invalid",
    NETWORK_INTERFACE_DOWN: "The selected Windows network interface is not up",
    NO_ROUTE_TO_TARGET: "Windows has no route to the authorized target",
    SNMP_TARGET_INVALID: "Managed telemetry target is not authorized locally",
    SNMP_PROFILE_MISSING: "Managed telemetry credential profile is missing locally",
    SNMP_CREDENTIALS_UNAVAILABLE: "Managed telemetry credentials are unavailable locally",
    SNMP_AGENT_UNAVAILABLE: "The SNMP collector agent is unavailable in the configured WSL environment",
    SNMP_TIMEOUT: "Managed telemetry poll exceeded its safe time limit",
    SNMP_POLL_FAILED: "Managed telemetry poll could not be completed",
    SNMP_BACKEND_FAILED: "Managed telemetry state could not be published",
  })[code] ?? "Local diagnostic runner encountered an error";
}

function validateConfig(value) {
  if (!value || typeof value !== "object") throw new Error("Runner config must be an object");
  if (!IDENTIFIER.test(value.runner_id ?? "") || typeof value.display_name !== "string") throw new Error("Runner identity is invalid");
  for (const field of ["wsl_distro", "wsl_project_root", "agent_executable", "environment_file"]) {
    if (typeof value[field] !== "string" || !value[field].trim() || /[\r\n]/.test(value[field])) throw new Error(`${field} is invalid`);
  }
  if (!value.wsl_project_root.startsWith("/") || path.posix.isAbsolute(value.agent_executable) || value.agent_executable.includes("..")) {
    throw new Error("WSL paths are invalid");
  }
  if (value.enable_diagnostic_demo !== undefined && typeof value.enable_diagnostic_demo !== "boolean") throw new Error("enable_diagnostic_demo is invalid");
  if (!uniqueLabels(value.source_locations) || !Array.isArray(value.durations) || !value.durations.every((item) => [5, 10, 15, 30].includes(item))) {
    throw new Error("Runner source/duration allow-list is invalid");
  }
  if (!IDENTIFIER.test(value.traffic_interface ?? "") || !Array.isArray(value.traffic_durations_seconds) ||
      value.traffic_durations_seconds.length < 1 || !value.traffic_durations_seconds.every((item) => [300, 600, 900, 1800].includes(item))) {
    throw new Error("Traffic interface/duration allow-list is invalid");
  }
  if (!Array.isArray(value.targets) || value.targets.length < 1 || value.targets.length > 50) throw new Error("Runner target allow-list is invalid");
  const ids = new Set();
  for (const target of value.targets) {
    if (!target || !IDENTIFIER.test(target.id ?? "") || ids.has(target.id)) throw new Error("Runner target ID is invalid");
    ids.add(target.id);
    if (typeof target.label !== "string" || !target.label.trim() || typeof target.host !== "string" || !target.host.trim() || /[\r\n]/.test(target.host)) throw new Error("Runner target is invalid");
    if (!Number.isSafeInteger(target.iperf_port) || target.iperf_port < 1 || target.iperf_port > 65535) throw new Error("Runner target port is invalid");
    if (target.enabled !== undefined && typeof target.enabled !== "boolean") throw new Error("Runner target enabled flag is invalid");
    if (target.environment !== "lan" && target.environment !== "localhost_demo") throw new Error("Runner target environment is invalid");
    if (target.environment === "localhost_demo" && !["127.0.0.1", "localhost"].includes(target.host.toLowerCase())) throw new Error("Localhost demo target must be loopback");
  }
  for (const field of ["poll_interval_ms", "heartbeat_interval_ms"]) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 1000 || value[field] > 60000) throw new Error(`${field} is invalid`);
  }
  if (value.enable_snmp_telemetry !== undefined && typeof value.enable_snmp_telemetry !== "boolean") throw new Error("enable_snmp_telemetry is invalid");
  if (value.snmp_max_concurrent !== undefined && (!Number.isSafeInteger(value.snmp_max_concurrent) || value.snmp_max_concurrent < 1 || value.snmp_max_concurrent > 5)) throw new Error("snmp_max_concurrent is invalid");
  if (value.snmp_timeout_ms !== undefined && (!Number.isSafeInteger(value.snmp_timeout_ms) || value.snmp_timeout_ms < 5000 || value.snmp_timeout_ms > 60000)) throw new Error("snmp_timeout_ms is invalid");
  if (value.snmp_poll_intervals_seconds !== undefined && (!Array.isArray(value.snmp_poll_intervals_seconds) || value.snmp_poll_intervals_seconds.length < 1 ||
      !value.snmp_poll_intervals_seconds.every((item) => item === 30 || item === 60))) throw new Error("snmp_poll_intervals_seconds is invalid");
  if (value.snmp_credential_profiles !== undefined && !validSnmpProfiles(value.snmp_credential_profiles)) throw new Error("snmp_credential_profiles is invalid");
}

function joinWslPath(root, relative) {
  const normalizedRoot = path.posix.normalize(root);
  const result = path.posix.resolve(normalizedRoot, relative);
  if (result !== normalizedRoot && !result.startsWith(`${normalizedRoot}/`)) throw new Error("Agent path escapes WSL project root");
  return result;
}

function uniqueLabels(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= 50 && value.every((item) => typeof item === "string" && item.trim() && item.length <= 200) && new Set(value).size === value.length;
}

export function diagnosticDemoEnabled(config) {
  const override = process.env.ENABLE_DIAGNOSTIC_DEMO?.trim().toLowerCase();
  if (override === "true") return true;
  if (override === "false") return false;
  return config.enable_diagnostic_demo === true;
}

export function availableTargets(config) {
  const demoEnabled = diagnosticDemoEnabled(config);
  return config.targets.filter((target) => target.enabled !== false && (target.environment === "lan" || demoEnabled));
}

function isLabel(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200 && !/[\r\n]/.test(value);
}

function isUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function privateIpv4(value) {
  if (typeof value !== "string" || value.split(".").length !== 4 || !value.split(".").every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return false;
  const [a, b] = value.split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function resolveSnmpProfile(config, ref) {
  if (typeof ref !== "string" || !IDENTIFIER.test(ref)) return null;
  const profile = config.snmp_credential_profiles?.[ref];
  if (!profile || typeof profile !== "object") return null;
  const resolved = {
    version: profile.version,
    username: profile.username ?? null,
    auth_protocol: profile.auth_protocol ?? null,
    auth_password: profile.auth_password ?? null,
    priv_protocol: profile.priv_protocol ?? null,
    priv_password: profile.priv_password ?? null,
    community: profile.community ?? null,
  };
  if (resolved.version === "3" && (!resolved.username || !resolved.auth_password)) return null;
  if (resolved.version === "2c" && (!resolved.community || typeof resolved.community !== "string")) return null;
  return resolved;
}

function validSnmpProfiles(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([ref, profile]) => {
    if (!IDENTIFIER.test(ref) || !profile || typeof profile !== "object" || Array.isArray(profile)) return false;
    if (profile.version !== "3" && profile.version !== "2c") return false;
    const clean = Object.fromEntries(Object.entries(profile).map(([key, val]) => [key, typeof val === "string" ? val.replace(/[\r\n]/g, "") : val]));
    if (profile.version === "3") {
      if (!clean.username || typeof clean.username !== "string") return false;
      if (!clean.auth_password || typeof clean.auth_password !== "string") return false;
      if (clean.auth_protocol !== undefined && !["SHA256", "SHA", "MD5"].includes(clean.auth_protocol)) return false;
      if (clean.priv_protocol !== undefined && !["AES128", "AES256", "DES"].includes(clean.priv_protocol)) return false;
      if (clean.community !== undefined) return false;
    } else {
      if (typeof clean.community !== "string" || !clean.community) return false;
      for (const key of ["username", "auth_protocol", "auth_password", "priv_protocol", "priv_password"]) {
        if (clean[key] !== undefined) return false;
      }
    }
    return true;
  });
}
