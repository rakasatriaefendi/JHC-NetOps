import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline";
import { safeError } from "./config.mjs";
import { resolvePlatform } from "./platform.mjs";

const CREATE_NO_WINDOW = true;
export const WSL_READINESS_TIMEOUT_MS = 15_000;
const INSPECTION_TRACE_PREFIX = "INSPECTION_TRACE ";
const MAX_INSPECTION_TRACE_BYTES = 512;
const MAX_INSPECTION_TRACE_RECORDS = 128;
const INSPECTION_TRACE_PHASES = new Set([
  "cli_entry", "inspect_device_entry", "tcp_phase_start", "tcp_phase_end",
  "collector_start", "collector_end", "normalization_start", "normalization_end",
  "partial_finalize_start", "partial_finalize_end", "json_serialize_start",
  "json_serialize_end", "stdout_write", "cli_return", "child_created",
  "terminate_requested", "kill_requested", "child_exit_observed",
]);
const INSPECTION_TRACE_STATUSES = new Set(["completed", "timeout", "skipped_budget", "failed", "exited"]);

export function runPreflight(config, spawnSyncProcess = spawnSync) {
  if (runtimePlatform(config) === "linux") return runLinuxPreflight(config, spawnSyncProcess);
  const distroList = spawnSyncProcess("wsl.exe", ["--list", "--quiet"], { windowsHide: CREATE_NO_WINDOW, shell: false, encoding: "utf8", timeout: 10000 });
  assertWslInvocation(distroList, "WSL_RUNTIME_FAILED");
  const distros = `${distroList.stdout ?? ""}${distroList.stderr ?? ""}`.replaceAll("\u0000", "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  if (!distros.includes(config.wsl_distro)) throw safeError("WSL_DISTRO_NOT_FOUND");

  assertWslPath(config, ["/usr/bin/test", "-d", config.wsl_project_root], "AGENT_VENV_MISSING", spawnSyncProcess);
  assertWslPath(config, ["/usr/bin/test", "-x", config.agent_path], "AGENT_VENV_MISSING", spawnSyncProcess);
  const python = captureWsl(config, [config.python_path, "--version"], "AGENT_PYTHON_UNSUPPORTED", spawnSyncProcess);
  const pythonVersion = python.match(/Python\s+(\d+)\.(\d+)/);
  if (!pythonVersion || Number(pythonVersion[1]) < 3 || (Number(pythonVersion[1]) === 3 && Number(pythonVersion[2]) < 11)) throw safeError("AGENT_PYTHON_UNSUPPORTED");

  const iperf = captureWsl(config, ["/usr/local/bin/iperf3", "--version"], "IPERF3_MISSING", spawnSyncProcess);
  const iperfVersion = iperf.match(/iperf\s+3\.(\d+)/i);
  if (!iperfVersion || Number(iperfVersion[1]) < 7) throw safeError("IPERF3_MISSING");
  captureWsl(config, ["/usr/bin/mtr", "--version"], "MTR_MISSING", spawnSyncProcess);
  captureWsl(config, [config.python_path, "-c", "import scapy"], "TRAFFIC_CAPTURE_FAILED", spawnSyncProcess);
  captureWsl(config, [config.agent_path, "traffic-interface-check", "--interface", config.traffic_interface], "TRAFFIC_CAPTURE_FAILED", spawnSyncProcess);
  let deviceInspectorPayload;
  try {
    deviceInspectorPayload = JSON.parse(captureWslStdout(
      config, [config.agent_path, "capabilities"], "INSPECTION_AGENT_UNAVAILABLE", spawnSyncProcess,
    ).trim());
  } catch (error) {
    if (error?.code) throw error;
    throw safeError("INSPECTION_AGENT_UNAVAILABLE");
  }
  const deviceInspector = validateInspectorCapabilities(deviceInspectorPayload);
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw safeError("RUNNER_INTERNAL_ERROR", "Runner backend credentials are unavailable");
  return { platform: "win32", python: pythonVersion[0], iperf3: `3.${iperfVersion[1]}`, mtr: true, ping: true,
    linux_network_context: false, traffic: true, diagnostics: true, device_inspector: deviceInspector,
    operations: ["bandwidth_and_path", "traffic_live", "network_discovery", "device_inspect", ...(config.enable_manual_ping === true ? ["manual_ping"] : [])] };
}

export function buildAgentInvocation(config, job) {
  const args = ["diagnostic-run", job.target.host,
    "--job-id", job.id,
    "--source-label", job.source_label,
    "--target-label", job.target.label,
    "--connection-type", job.connection_type,
    "--environment", job.target.environment,
    "--duration", String(job.duration_seconds),
    "--port", String(job.target.iperf_port),
  ];
  return wrapAgentInvocation(config, args);
}

export function buildTrafficInvocation(config, session) {
  const args = ["traffic-live", "--runner-id", config.runner_id, "--session-id", session.id,
    "--duration", String(session.duration_seconds), "--interface", config.traffic_interface];
  return runtimePlatform(config) === "win32"
    ? ["-d", config.wsl_distro, "--user", "root", "--exec", config.agent_path, ...args]
    : args;
}

export async function runTrafficAgent(config, session, onEvent, timeoutMs) {
  return runStructuredProcess(config, buildTrafficInvocation(config, session), validateTrafficEvent, onEvent, timeoutMs);
}

export async function runAgent(config, job, onEvent, timeoutMs) {
  return runStructuredProcess(config, buildAgentInvocation(config, job), validateAgentEvent, onEvent, timeoutMs);
}

export function buildInspectionInvocation(config, session, context) {
  const args = ["device-inspect", session.target_ip,
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
  return wrapAgentInvocation(config, args);
}

export function buildWslReadinessInvocation(config) {
  return ["-d", config.wsl_distro, "--exec", "/usr/bin/env", "true"];
}

export async function waitForWslReadiness(
  config, { timeoutMs = WSL_READINESS_TIMEOUT_MS, spawnProcess = spawn, onTrace = () => {} } = {},
) {
  const startedAt = Date.now();
  const emitTrace = (phase) => {
    try { onTrace({ source: "runner", phase, elapsed_ms: boundedMilliseconds(Date.now() - startedAt) }); } catch {}
  };
  emitTrace("wsl_readiness_start");

  let child;
  try {
    child = spawnProcess("wsl.exe", buildWslReadinessInvocation(config), {
      windowsHide: CREATE_NO_WINDOW,
      shell: false,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    emitTrace("wsl_readiness_failed");
    throw safeError("WSL_RUNTIME_FAILED");
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (error, phase) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      emitTrace(phase);
      if (error) reject(error);
      else resolve({ exit: 0 });
    };
    child.once("error", () => finish(safeError("WSL_RUNTIME_FAILED"), "wsl_readiness_failed"));
    child.once("close", (exit) => {
      if (exit === 0) finish(null, "wsl_readiness_ready");
      else finish(safeError("WSL_RUNTIME_FAILED"), "wsl_readiness_failed");
    });
    timer = setTimeout(() => {
      finish(safeError("WSL_READINESS_TIMEOUT"), "wsl_readiness_timeout");
      try { child.kill(); } catch {}
    }, timeoutMs);
  });
}

export async function runInspectionAgent(
  config, session, context, onEvent, timeoutMs = 30_000, spawnProcess = spawn, onTrace = () => {},
  readiness = {},
) {
  const platform = runtimePlatform(config);
  if (platform === "win32") {
    await waitForWslReadiness(config, {
      timeoutMs: readiness.timeoutMs ?? WSL_READINESS_TIMEOUT_MS,
      spawnProcess: readiness.spawnProcess ?? spawnProcess,
      onTrace,
    });
  }
  return runStructuredProcess(config, buildInspectionInvocation(config, session, context), validateInspectionEvent, onEvent, timeoutMs, {
    start: platform === "win32" ? "INSPECTION_WSL_UNAVAILABLE" : "INSPECTION_AGENT_UNAVAILABLE",
    timeout: "INSPECTION_TIMEOUT",
    exit: "INSPECTION_AGENT_UNAVAILABLE",
    trace: onTrace,
  }, spawnProcess);
}

export function buildSnmpInvocation(config, target, creds, netbiosOffset = 0) {
  const safeNetbiosOffset = Number.isSafeInteger(netbiosOffset) && netbiosOffset >= 0 && netbiosOffset < 256
    ? netbiosOffset : 0;
  const args = ["managed-telemetry-poll",
    "--target-id", target.id,
    "--runner-id", config.runner_id,
    "--node-id", target.node_id,
    "--ip-address", target.ip_address,
    "--credential-profile-ref", target.credential_profile_ref,
    "--snmp-version", target.snmp_version,
    "--snmp-port", String(target.snmp_port ?? 161),
    "--timeout", String(config.snmp_timeout_seconds ?? 3),
    "--netbios-offset", String(safeNetbiosOffset)];
  if (creds.version === "3") {
    if (creds.username) args.push("--username", creds.username);
    if (creds.auth_protocol) args.push("--auth-protocol", creds.auth_protocol);
    if (creds.auth_password) args.push("--auth-password", creds.auth_password);
    if (creds.priv_protocol) args.push("--priv-protocol", creds.priv_protocol);
    if (creds.priv_password) args.push("--priv-password", creds.priv_password);
  } else if (creds.version === "2c" && creds.community) {
    args.push("--community", creds.community);
  }
  return wrapAgentInvocation(config, args);
}

export async function runTelemetryAgent(config, target, creds, onEvent, timeoutMs = 30_000, netbiosOffset = 0) {
  return runStructuredProcess(config, buildSnmpInvocation(config, target, creds, netbiosOffset), validateTelemetryEvent, onEvent, timeoutMs, {
    start: "SNMP_AGENT_UNAVAILABLE",
    timeout: "SNMP_TIMEOUT",
    exit: "SNMP_AGENT_UNAVAILABLE",
  });
}

export function validateTelemetryEvent(value) {
  if (!value || typeof value !== "object") throw safeError("AGENT_PROTOCOL_ERROR");
  if (value.type === "poll_start" && typeof value.host === "string" && value.host.length <= 64) {
    return { type: "poll_start" };
  }
  if (value.type === "poll_complete" && Number.isSafeInteger(value.interface_count) && value.interface_count >= 0 && value.interface_count <= 200) {
    return { type: "poll_complete", interface_count: value.interface_count };
  }
  if (value.type === "poll_error" && typeof value.message === "string" && value.message.length <= 300) {
    return { type: "poll_error", category: typeof value.category === "string" ? value.category : "agent_error" };
  }
  if (value.type === "telemetry_result") return { type: "telemetry_result", payload: validateTelemetryPayload(value.payload) };
  throw safeError("AGENT_PROTOCOL_ERROR");
}

export function validateTelemetryPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.type !== "managed_telemetry") throw safeError("AGENT_PROTOCOL_ERROR");
  if (!isUuid(payload.target_id) || !isUuid(payload.node_id) || !privateIpv4(payload.ip_address)) throw safeError("AGENT_PROTOCOL_ERROR");
  if (typeof payload.credential_profile_ref !== "string" || payload.credential_profile_ref.length > 64) throw safeError("AGENT_PROTOCOL_ERROR");
  if (!["3", "2c"].includes(payload.snmp_version)) throw safeError("AGENT_PROTOCOL_ERROR");
  const device = payload.device;
  if (!device || typeof device !== "object" || Array.isArray(device)) throw safeError("AGENT_PROTOCOL_ERROR");
  if (!["connected", "partial", "auth_failed", "timeout", "unreachable", "unsupported", "poll_failed"].includes(device.status)) throw safeError("AGENT_PROTOCOL_ERROR");
  if (!["available", "empty", "partial", "unsupported"].includes(device.observed_hosts_status)) throw safeError("AGENT_PROTOCOL_ERROR");
  for (const field of ["sys_name", "sys_descr", "sys_object_id", "manufacturer", "model", "serial_number", "error", "error_category"]) {
    if (device[field] !== undefined && device[field] !== null && (typeof device[field] !== "string" || device[field].length > 512)) throw safeError("AGENT_PROTOCOL_ERROR");
  }
  if (!Array.isArray(payload.interfaces) || payload.interfaces.length > 200) throw safeError("AGENT_PROTOCOL_ERROR");
  const interfaces = [];
  for (const item of payload.interfaces) {
    interfaces.push(validateTelemetryInterface(item));
  }
  if (!Array.isArray(payload.observed_hosts) || payload.observed_hosts.length > 256) throw safeError("AGENT_PROTOCOL_ERROR");
  const observedHosts = payload.observed_hosts.map(validateObservedHost);
  const encoded = JSON.stringify({ device, interfaces, observed_hosts: observedHosts });
  if (Buffer.byteLength(encoded, "utf8") > 64 * 1024) throw safeError("AGENT_PROTOCOL_ERROR");
  return { target_id: payload.target_id, runner_id: payload.runner_id, node_id: payload.node_id, ip_address: payload.ip_address,
    credential_profile_ref: payload.credential_profile_ref, snmp_version: payload.snmp_version, device, interfaces, observed_hosts: observedHosts };
}

function validateObservedHost(item) {
  if (!item || typeof item !== "object" || Array.isArray(item) || !privateIpv4(item.ip_address)) throw safeError("AGENT_PROTOCOL_ERROR");
  const mac = item.mac_address ?? null;
  if (mac !== null && (typeof mac !== "string" || !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(mac) || mac === "00:00:00:00:00:00")) throw safeError("AGENT_PROTOCOL_ERROR");
  const name = item.netbios_name ?? null;
  if (name !== null && (typeof name !== "string" || name.length < 1 || name.length > 15 || /[\x00-\x1f\x7f]/.test(name))) throw safeError("AGENT_PROTOCOL_ERROR");
  if (!["ip_net_to_physical", "ip_net_to_media"].includes(item.observation_source)) throw safeError("AGENT_PROTOCOL_ERROR");
  if (!["resolved", "unavailable", "not_attempted"].includes(item.enrichment_status)) throw safeError("AGENT_PROTOCOL_ERROR");
  return { ip_address: item.ip_address, mac_address: mac, netbios_name: name,
    observation_source: item.observation_source, enrichment_status: item.enrichment_status };
}

function validateTelemetryInterface(item) {
  if (!item || typeof item !== "object" || Array.isArray(item) || !Number.isSafeInteger(item.if_index) || item.if_index < 0 || item.if_index > 2147483647) throw safeError("AGENT_PROTOCOL_ERROR");
  const out = { if_index: item.if_index };
  for (const field of ["name", "description", "admin_status", "oper_status"]) {
    if (item[field] !== undefined && item[field] !== null && (typeof item[field] !== "string" || item[field].length > 128)) throw safeError("AGENT_PROTOCOL_ERROR");
    out[field] = item[field] ?? null;
  }
  if (item.if_type !== undefined && item.if_type !== null && !Number.isSafeInteger(item.if_type)) throw safeError("AGENT_PROTOCOL_ERROR");
  out.if_type = item.if_type ?? null;
  if (item.is_physical !== undefined && typeof item.is_physical !== "boolean") throw safeError("AGENT_PROTOCOL_ERROR");
  out.is_physical = item.is_physical === true;
  for (const field of ["speed_bps", "if_high_speed_mbps", "in_octets", "out_octets", "in_discards", "out_discards", "in_errors", "out_errors"]) {
    if (item[field] !== undefined && item[field] !== null && (!Number.isSafeInteger(item[field]) || item[field] < 0)) throw safeError("AGENT_PROTOCOL_ERROR");
    out[field] = item[field] ?? null;
  }
  for (const field of ["in_octets_bits", "out_octets_bits", "in_discards_bits", "out_discards_bits", "in_errors_bits", "out_errors_bits"]) {
    if (item[field] !== undefined && item[field] !== null && ![32, 64].includes(item[field])) throw safeError("AGENT_PROTOCOL_ERROR");
    out[field] = item[field] ?? null;
  }
  return out;
}

async function runStructuredProcess(config, args, validator, onEvent, timeoutMs, errorCodes = {}, spawnProcess = spawn) {
  const startedAt = Date.now();
  const platform = runtimePlatform(config);
  const executable = platform === "win32" ? "wsl.exe" : config.agent_path;
  let child;
  try {
    child = spawnProcess(executable, args, { windowsHide: CREATE_NO_WINDOW, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    throw safeError(errorCodes.start ?? (platform === "win32" ? "WSL_START_FAILED" : "NATIVE_AGENT_UNAVAILABLE"));
  }
  let safeAgentError = null;
  let protocolError = null;
  let callbackError = null;
  let timedOut = false;
  let stderrBytes = 0;
  let firstAgentOutput = false;
  let acceptedTraceRecords = 0;
  let stderrTraceBuffer = "";
  let discardStderrLine = false;
  const emitTrace = (record) => {
    if (typeof errorCodes.trace !== "function") return;
    try { errorCodes.trace(record); } catch {}
  };
  const emitRunnerTrace = (phase, extra = {}) => emitTrace({
    source: "runner", phase, elapsed_ms: boundedMilliseconds(Date.now() - startedAt), ...extra,
  });
  const noteFirstAgentOutput = () => {
    if (firstAgentOutput) return;
    firstAgentOutput = true;
    emitRunnerTrace("first_agent_output");
  };
  emitRunnerTrace(platform === "win32" ? "wsl_spawn" : "native_spawn");
  const exitPromise = new Promise((resolve, reject) => {
    child.once("error", () => reject(safeError(errorCodes.start ?? (platform === "win32" ? "WSL_START_FAILED" : "NATIVE_AGENT_UNAVAILABLE"))));
    child.once("close", resolve);
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    emitRunnerTrace("outer_timeout");
    child.kill();
  }, timeoutMs);
  const acceptStderrTraceLine = (line) => {
    if (acceptedTraceRecords >= MAX_INSPECTION_TRACE_RECORDS) return;
    const record = parseInspectionTraceLine(line.endsWith("\r") ? line.slice(0, -1) : line);
    if (!record) return;
    acceptedTraceRecords += 1;
    noteFirstAgentOutput();
    emitTrace(record);
  };
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (typeof errorCodes.trace !== "function") return;
    const fragments = chunk.toString("utf8").split("\n");
    for (let index = 0; index < fragments.length; index += 1) {
      if (!discardStderrLine) {
        const candidate = stderrTraceBuffer + fragments[index];
        if (Buffer.byteLength(candidate, "utf8") <= MAX_INSPECTION_TRACE_BYTES) stderrTraceBuffer = candidate;
        else { stderrTraceBuffer = ""; discardStderrLine = true; }
      }
      if (index < fragments.length - 1) {
        if (!discardStderrLine) acceptStderrTraceLine(stderrTraceBuffer);
        stderrTraceBuffer = "";
        discardStderrLine = false;
      }
    }
  });
  child.stderr.on("end", () => {
    if (stderrTraceBuffer && !discardStderrLine) acceptStderrTraceLine(stderrTraceBuffer);
    stderrTraceBuffer = "";
  });

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
    noteFirstAgentOutput();
    if (event.type === "result") emitRunnerTrace("normalized_result_received");
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
  emitRunnerTrace(platform === "win32" ? "wsl_close" : "native_close", { exit_code: Number.isInteger(exit) ? exit : -1 });
  if (timedOut) throw safeError(errorCodes.timeout ?? "JOB_TIMEOUT");
  if (protocolError) throw protocolError;
  if (callbackError) throw callbackError;
  if (safeAgentError) throw safeAgentError;
  if (exit !== 0) throw safeError(errorCodes.exit ?? (platform === "win32" ? "WSL_START_FAILED" : "NATIVE_AGENT_UNAVAILABLE"));
  return { exit, stderr_bytes: stderrBytes };
}

export function parseInspectionTraceLine(line) {
  if (typeof line !== "string" || Buffer.byteLength(line, "utf8") > MAX_INSPECTION_TRACE_BYTES ||
      !line.startsWith(INSPECTION_TRACE_PREFIX)) return null;
  let value;
  try { value = JSON.parse(line.slice(INSPECTION_TRACE_PREFIX.length)); }
  catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value) || !INSPECTION_TRACE_PHASES.has(value.phase)) return null;
  const allowed = new Set([
    "phase", "elapsed_ms", "collector_name", "status", "remaining_budget_ms", "duration_ms",
    "child_pid", "process_group_id", "exit_code",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || !boundedTraceNumber(value.elapsed_ms)) return null;
  const record = { source: "agent", phase: value.phase, elapsed_ms: value.elapsed_ms };
  if (value.collector_name !== undefined) {
    if (typeof value.collector_name !== "string" || !/^[a-z][a-z0-9_:-]{0,39}$/.test(value.collector_name)) return null;
    record.collector_name = value.collector_name;
  }
  if (value.status !== undefined) {
    if (!INSPECTION_TRACE_STATUSES.has(value.status)) return null;
    record.status = value.status;
  }
  for (const name of ["remaining_budget_ms", "duration_ms"]) {
    if (value[name] !== undefined) {
      if (!boundedTraceNumber(value[name])) return null;
      record[name] = value[name];
    }
  }
  for (const name of ["child_pid", "process_group_id", "exit_code"]) {
    if (value[name] !== undefined) {
      if (!Number.isSafeInteger(value[name]) || value[name] < -1 || value[name] > 2_147_483_647) return null;
      record[name] = value[name];
    }
  }
  return record;
}

function boundedTraceNumber(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 120_000;
}

function boundedMilliseconds(value) {
  return Math.max(0, Math.min(120_000, Math.round(value)));
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
  if (value.type === "error" && value.code === "INSPECTION_TIMEOUT" && typeof value.message === "string" && value.message.length <= 160 && !/[\r\n]/.test(value.message)) {
    return { type: "error", code: "INSPECTION_TIMEOUT", message: value.message };
  }
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

function runLinuxPreflight(config, spawnSyncProcess) {
  const python = captureNative(config.python_path, ["--version"], "AGENT_PYTHON_UNSUPPORTED", spawnSyncProcess);
  const pythonVersion = python.match(/Python\s+(\d+)\.(\d+)/);
  if (!pythonVersion || Number(pythonVersion[1]) < 3 || (Number(pythonVersion[1]) === 3 && Number(pythonVersion[2]) < 11)) {
    throw safeError("AGENT_PYTHON_UNSUPPORTED");
  }
  let deviceInspectorPayload;
  try {
    deviceInspectorPayload = JSON.parse(captureNative(config.agent_path, ["capabilities"], "NATIVE_AGENT_UNAVAILABLE", spawnSyncProcess, true).trim());
  } catch (error) {
    if (error?.code) throw error;
    throw safeError("NATIVE_AGENT_UNAVAILABLE");
  }
  const deviceInspector = validateInspectorCapabilities(deviceInspectorPayload);
  const ip = nativeTool("ip", ["-V"], spawnSyncProcess);
  const ping = nativeTool("ping", ["-V"], spawnSyncProcess);
  const mtr = nativeTool("mtr", ["--version"], spawnSyncProcess);
  const iperfResult = nativeToolResult("iperf3", ["--version"], spawnSyncProcess);
  const iperfMatch = `${iperfResult.stdout ?? ""}${iperfResult.stderr ?? ""}`.match(/iperf\s+3\.(\d+)/i);
  const iperf = iperfResult.available && iperfMatch && Number(iperfMatch[1]) >= 7;
  const scapy = nativeTool(config.python_path, ["-c", "import scapy"], spawnSyncProcess);
  const traffic = scapy && nativeTool(config.agent_path, ["traffic-interface-check", "--interface", config.traffic_interface], spawnSyncProcess);
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw safeError("RUNNER_INTERNAL_ERROR", "Runner backend credentials are unavailable");
  const operations = [
    ...(iperf && mtr && ip ? ["bandwidth_and_path"] : []),
    ...(traffic ? ["traffic_live"] : []),
    ...(ip && ping ? ["network_discovery"] : []),
    ...(ip ? ["device_inspect"] : []),
    ...(config.enable_manual_ping === true && ping ? ["manual_ping"] : []),
  ];
  return {
    platform: "linux",
    python: pythonVersion[0],
    iperf3: iperf ? `3.${iperfMatch[1]}` : null,
    mtr,
    ping,
    linux_network_context: ip,
    traffic,
    diagnostics: Boolean(iperf && mtr && ip),
    device_inspector: deviceInspector,
    operations,
  };
}

function captureNative(executable, args, errorCode, spawnSyncProcess, stdoutOnly = false) {
  const result = spawnSyncProcess(executable, args, { windowsHide: CREATE_NO_WINDOW, shell: false, encoding: "utf8", timeout: 10000 });
  if (result?.error?.code === "ETIMEDOUT") throw safeError("NATIVE_AGENT_TIMEOUT");
  if (result?.error || result?.status !== 0) throw safeError(errorCode);
  return `${result.stdout ?? ""}${stdoutOnly ? "" : result.stderr ?? ""}`;
}

function nativeTool(executable, args, spawnSyncProcess) {
  return nativeToolResult(executable, args, spawnSyncProcess).available;
}

function nativeToolResult(executable, args, spawnSyncProcess) {
  try {
    const result = spawnSyncProcess(executable, args, { windowsHide: CREATE_NO_WINDOW, shell: false, encoding: "utf8", timeout: 10000 });
    return { available: !result?.error && result?.status === 0, stdout: result?.stdout, stderr: result?.stderr };
  } catch { return { available: false, stdout: "", stderr: "" }; }
}

function runtimePlatform(config) {
  return resolvePlatform(config?.runtime_platform ?? "win32");
}

function wrapAgentInvocation(config, args) {
  return runtimePlatform(config) === "win32"
    ? ["-d", config.wsl_distro, "--exec", config.agent_path, ...args]
    : args;
}

function captureWsl(config, args, errorCode, spawnSyncProcess = spawnSync) {
  const result = spawnSyncProcess("wsl.exe", ["-d", config.wsl_distro, "--exec", ...args], { windowsHide: CREATE_NO_WINDOW, shell: false, encoding: "utf8", timeout: 10000 });
  assertWslInvocation(result, errorCode);
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.replaceAll("\u0000", "");
}

function captureWslStdout(config, args, errorCode, spawnSyncProcess = spawnSync) {
  const result = spawnSyncProcess("wsl.exe", ["-d", config.wsl_distro, "--exec", ...args], { windowsHide: CREATE_NO_WINDOW, shell: false, encoding: "utf8", timeout: 10000 });
  assertWslInvocation(result, errorCode);
  return `${result.stdout ?? ""}`.replaceAll("\u0000", "");
}

function assertWslPath(config, args, errorCode, spawnSyncProcess) {
  const result = spawnSyncProcess("wsl.exe", ["-d", config.wsl_distro, "--exec", ...args], { windowsHide: CREATE_NO_WINDOW, shell: false, encoding: "utf8", timeout: 10000 });
  assertWslInvocation(result, errorCode, { pathCheck: true });
}

export function assertWslInvocation(result, commandErrorCode, { pathCheck = false } = {}) {
  const timedOut = result?.error?.code === "ETIMEDOUT";
  if (timedOut) throw safeError("WSL_INVOCATION_TIMEOUT");
  if (result?.error || result?.status === null || result?.status === undefined) throw safeError("WSL_RUNTIME_FAILED");
  if (result.status !== 0) {
    const stderr = `${result.stderr ?? ""}`.replaceAll("\u0000", "").trim();
    if (pathCheck && (result.status !== 1 || wslRuntimeFailure(stderr))) throw safeError("WSL_RUNTIME_FAILED");
    throw safeError(commandErrorCode);
  }
}
function wslRuntimeFailure(stderr) {
  return /(?:failed to (?:configure|mount|start)|mount failed|wsl\/(?:service|e_)|error code|access is denied|distribution.*(?:not found|not running))/i.test(stderr);
}
function requireNumber(value) { if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw safeError("AGENT_PROTOCOL_ERROR"); }
function direction(value) { return value === "upload" || value === "download"; }
function isUuid(value) { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function privateIpv4(value) { if (typeof value !== "string") return false; const parts = value.split("."); if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return false; const [a, b] = parts.map(Number); return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168); }
