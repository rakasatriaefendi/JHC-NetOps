import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline";
import { safeError } from "./config.mjs";

const CREATE_NO_WINDOW = true;

export function runPreflight(config) {
  const distroList = spawnSync("wsl.exe", ["--list", "--quiet"], { windowsHide: CREATE_NO_WINDOW, shell: false, encoding: "utf8" });
  const distros = `${distroList.stdout ?? ""}${distroList.stderr ?? ""}`.replaceAll("\u0000", "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  if (distroList.status !== 0 || !distros.includes(config.wsl_distro)) throw safeError("WSL_DISTRO_NOT_FOUND");

  assertWsl(config, ["/usr/bin/test", "-d", config.wsl_project_root], "AGENT_VENV_MISSING");
  assertWsl(config, ["/usr/bin/test", "-x", config.agent_path], "AGENT_VENV_MISSING");
  const python = captureWsl(config, [config.python_path, "--version"], "AGENT_PYTHON_UNSUPPORTED");
  const pythonVersion = python.match(/Python\s+(\d+)\.(\d+)/);
  if (!pythonVersion || Number(pythonVersion[1]) < 3 || (Number(pythonVersion[1]) === 3 && Number(pythonVersion[2]) < 11)) throw safeError("AGENT_PYTHON_UNSUPPORTED");

  const iperf = captureWsl(config, ["/usr/local/bin/iperf3", "--version"], "IPERF3_MISSING");
  const iperfVersion = iperf.match(/iperf\s+3\.(\d+)/i);
  if (!iperfVersion || Number(iperfVersion[1]) < 7) throw safeError("IPERF3_MISSING");
  captureWsl(config, ["/usr/bin/mtr", "--version"], "MTR_MISSING");
  captureWsl(config, [config.python_path, "-c", "import scapy"], "TRAFFIC_CAPTURE_FAILED");
  captureWsl(config, [config.agent_path, "traffic-interface-check", "--interface", config.traffic_interface], "TRAFFIC_CAPTURE_FAILED");
  let deviceInspectorPayload;
  try {
    deviceInspectorPayload = JSON.parse(captureWslStdout(
      config, [config.agent_path, "capabilities"], "INSPECTION_AGENT_UNAVAILABLE",
    ).trim());
  } catch (error) {
    if (error?.code) throw error;
    throw safeError("INSPECTION_AGENT_UNAVAILABLE");
  }
  const deviceInspector = validateInspectorCapabilities(deviceInspectorPayload);
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw safeError("RUNNER_INTERNAL_ERROR", "Runner backend credentials are unavailable");
  return { python: pythonVersion[0], iperf3: `3.${iperfVersion[1]}`, mtr: true, traffic: true, device_inspector: deviceInspector };
}

export function buildAgentInvocation(config, job) {
  return [
    "-d", config.wsl_distro, "--exec", config.agent_path, "diagnostic-run", job.target.host,
    "--job-id", job.id,
    "--source-label", job.source_label,
    "--target-label", job.target.label,
    "--connection-type", job.connection_type,
    "--environment", job.target.environment,
    "--duration", String(job.duration_seconds),
    "--port", String(job.target.iperf_port),
  ];
}

export function buildTrafficInvocation(config, session) {
  return ["-d", config.wsl_distro, "--user", "root", "--exec", config.agent_path,
    "traffic-live", "--runner-id", config.runner_id, "--session-id", session.id,
    "--duration", String(session.duration_seconds), "--interface", config.traffic_interface];
}

export async function runTrafficAgent(config, session, onEvent, timeoutMs) {
  return runStructuredProcess(buildTrafficInvocation(config, session), validateTrafficEvent, onEvent, timeoutMs);
}

export async function runAgent(config, job, onEvent, timeoutMs) {
  return runStructuredProcess(buildAgentInvocation(config, job), validateAgentEvent, onEvent, timeoutMs);
}

export function buildInspectionInvocation(config, session, context) {
  const args = ["-d", config.wsl_distro, "--exec", config.agent_path, "device-inspect", session.target_ip,
    "--route-role", context.route_role,
    "--same-subnet", context.same_subnet ? "yes" : "no",
    "--reachable", context.reachable ? "yes" : "no",
    "--is-this-device", context.is_this_device ? "yes" : "no",
    "--interface-index", String(context.interface_index),
    "--interface-alias", context.interface_alias,
    "--interface-description", context.interface_description,
    "--interface-type", context.interface_type];
  if (context.default_gateway) args.push("--default-gateway", context.default_gateway);
  if (context.mac) args.push("--mac", context.mac);
  return args;
}

export async function runInspectionAgent(config, session, context, onEvent, timeoutMs = 30_000) {
  return runStructuredProcess(buildInspectionInvocation(config, session, context), validateInspectionEvent, onEvent, timeoutMs, {
    start: "INSPECTION_WSL_UNAVAILABLE",
    timeout: "INSPECTION_TIMEOUT",
    exit: "INSPECTION_AGENT_UNAVAILABLE",
  });
}

async function runStructuredProcess(args, validator, onEvent, timeoutMs, errorCodes = {}) {
  const child = spawn("wsl.exe", args, { windowsHide: CREATE_NO_WINDOW, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  let safeAgentError = null;
  let protocolError = null;
  let callbackError = null;
  let timedOut = false;
  let stderrBytes = 0;
  const exitPromise = new Promise((resolve, reject) => {
    child.once("error", () => reject(safeError(errorCodes.start ?? "WSL_START_FAILED")));
    child.once("close", resolve);
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  child.stderr.on("data", (chunk) => { stderrBytes += chunk.length; });

  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let event;
    try {
      event = validator(JSON.parse(line));
    } catch {
      protocolError = safeError("AGENT_PROTOCOL_ERROR");
      child.kill();
      break;
    }
    if (event.type === "error") {
      safeAgentError = safeError(event.code, event.message);
      continue;
    }
    try {
      await onEvent(event);
    } catch (error) {
      callbackError = error;
      child.kill();
      break;
    }
  }
  const exit = await exitPromise.finally(() => clearTimeout(timeout));
  if (timedOut) throw safeError(errorCodes.timeout ?? "JOB_TIMEOUT");
  if (protocolError) throw protocolError;
  if (callbackError) throw callbackError;
  if (safeAgentError) throw safeAgentError;
  if (exit !== 0) throw safeError(errorCodes.exit ?? "WSL_START_FAILED");
  return { exit, stderr_bytes: stderrBytes };
}

export function validateTrafficEvent(value) {
  if (!value || typeof value !== "object") throw safeError("AGENT_PROTOCOL_ERROR");
  if (value.type === "stage" && value.stage === "capturing" && value.status === "started") return { type: "stage", stage: "capturing", status: "started" };
  if (value.type === "complete" && isUuid(value.session_id)) return { type: "complete", session_id: value.session_id };
  if (value.type === "error" && typeof value.message === "string" && value.message.length <= 300) return { type: "error", code: "TRAFFIC_CAPTURE_FAILED", message: value.message };
  throw safeError("AGENT_PROTOCOL_ERROR");
}

export function validateAgentEvent(value) {
  if (!value || typeof value !== "object" || typeof value.type !== "string") throw safeError("AGENT_PROTOCOL_ERROR");
  if (value.type === "stage") {
    if (!["upload", "download", "mtr", "saving"].includes(value.stage) || value.status !== "started") throw safeError("AGENT_PROTOCOL_ERROR");
    return { type: "stage", stage: value.stage, status: "started" };
  }
  if (value.type === "interval") {
    if (!direction(value.direction)) throw safeError("AGENT_PROTOCOL_ERROR");
    for (const field of ["second", "mbps", "average_mbps", "peak_mbps", "minimum_mbps", "transferred_mb"]) requireNumber(value[field]);
    if (value.retransmits !== null) requireNumber(value.retransmits);
    return Object.fromEntries(["type", "direction", "second", "mbps", "average_mbps", "peak_mbps", "minimum_mbps", "transferred_mb", "retransmits"].map((key) => [key, value[key]]));
  }
  if (value.type === "summary") {
    if (!direction(value.direction)) throw safeError("AGENT_PROTOCOL_ERROR");
    requireNumber(value.average_mbps);
    for (const field of ["peak_mbps", "minimum_mbps", "transferred_mb", "retransmits", "duration_seconds"]) if (value[field] !== null) requireNumber(value[field]);
    return Object.fromEntries(["type", "direction", "average_mbps", "peak_mbps", "minimum_mbps", "transferred_mb", "retransmits", "duration_seconds"].map((key) => [key, value[key]]));
  }
  if (value.type === "complete") {
    if (!isUuid(value.job_id) || !Array.isArray(value.bandwidth_directions) || value.bandwidth_directions.join(",") !== "upload,download" || !Number.isSafeInteger(value.hop_count) || value.hop_count < 1) throw safeError("AGENT_PROTOCOL_ERROR");
    return { type: "complete", job_id: value.job_id, bandwidth_directions: ["upload", "download"], hop_count: value.hop_count };
  }
  if (value.type === "error") {
    if (!["UPLOAD_FAILED", "DOWNLOAD_FAILED", "MTR_FAILED", "BACKEND_UPLOAD_FAILED"].includes(value.code) || typeof value.message !== "string" || value.message.length > 300 || /[\r\n]/.test(value.message)) throw safeError("AGENT_PROTOCOL_ERROR");
    return { type: "error", code: value.code, message: value.message };
  }
  throw safeError("AGENT_PROTOCOL_ERROR");
}

export function validateInspectionEvent(value) {
  if (!value || typeof value !== "object") throw safeError("AGENT_PROTOCOL_ERROR");
  if (value.type === "stage" && ["network_role", "identity", "services", "normalizing"].includes(value.stage)) {
    return { type: "stage", stage: value.stage };
  }
  if (value.type === "result") return { type: "result", fingerprint: validateFingerprint(value.fingerprint) };
  throw safeError("AGENT_PROTOCOL_ERROR");
}

export function validateInspectorCapabilities(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema_version !== 1 ||
      value.available !== true || value.probe_engine !== "python_socket" ||
      !value.required || value.required.python_socket !== true) throw safeError("INSPECTION_AGENT_UNAVAILABLE");
  const booleanMap = (input) => input && typeof input === "object" && !Array.isArray(input) &&
    Object.values(input).every((item) => typeof item === "boolean");
  if (!booleanMap(value.optional) || (value.collectors !== undefined && !booleanMap(value.collectors)) ||
      !booleanMap(value.available_but_unused) || !booleanMap(value.optional_not_required) ||
      typeof value.python_version !== "string" || value.python_version.length > 32) throw safeError("INSPECTION_AGENT_UNAVAILABLE");
  return {
    schema_version: 1,
    available: true,
    probe_engine: "python_socket",
    python_version: value.python_version,
    required: { python_socket: true },
    collectors: value.collectors ? { ...value.collectors } : {
      tcp_connect: true, http_metadata: true, tls_metadata: Boolean(value.optional.openssl),
      upnp_unicast: true, netbios_node_status: true,
    },
    optional: { ...value.optional },
    available_but_unused: { ...value.available_but_unused },
    optional_not_required: { ...value.optional_not_required },
  };
}

function validateFingerprint(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !privateIpv4(value.ip) ||
      !["high", "medium", "low", "unknown"].includes(value.confidence) ||
      typeof value.likely_device_type !== "string" || !Array.isArray(value.capabilities) || value.capabilities.length > 16 ||
      !Array.isArray(value.evidence) || value.evidence.length > 32) throw safeError("AGENT_PROTOCOL_ERROR");
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > 64 * 1024 || /"(?:raw|stdout|stderr|html|xml|body|payload|cookie|token|authorization|credential|password|secret)"\s*:/i.test(encoded)) {
    throw safeError("AGENT_PROTOCOL_ERROR");
  }
  return value;
}

function captureWsl(config, args, errorCode) {
  const result = spawnSync("wsl.exe", ["-d", config.wsl_distro, "--exec", ...args], { windowsHide: CREATE_NO_WINDOW, shell: false, encoding: "utf8", timeout: 10000 });
  if (result.status !== 0) throw safeError(errorCode);
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.replaceAll("\u0000", "");
}

function captureWslStdout(config, args, errorCode) {
  const result = spawnSync("wsl.exe", ["-d", config.wsl_distro, "--exec", ...args], { windowsHide: CREATE_NO_WINDOW, shell: false, encoding: "utf8", timeout: 10000 });
  if (result.status !== 0) throw safeError(errorCode);
  return `${result.stdout ?? ""}`.replaceAll("\u0000", "");
}

function assertWsl(config, args, errorCode) { captureWsl(config, args, errorCode); }
function requireNumber(value) { if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw safeError("AGENT_PROTOCOL_ERROR"); }
function direction(value) { return value === "upload" || value === "download"; }
function isUuid(value) { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function privateIpv4(value) { if (typeof value !== "string") return false; const parts = value.split("."); if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return false; const [a, b] = parts.map(Number); return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168); }
