export class BackendClient {
  constructor(localBackend, persistenceAuthority = process.env.PERSISTENCE_AUTHORITY) {
    if (persistenceAuthority !== "local_postgres") throw new Error("PERSISTENCE_AUTHORITY must be local_postgres");
    if (!localBackend) throw new Error("Local backend configuration is required");
    this.localHeartbeatEndpoint = localBackend
      ? `${localBackend.url}/api/runner/heartbeat`
      : null;
    this.localHealthEndpoint = localBackend ? `${localBackend.url}/api/runner/network-health` : null;
    this.localTrafficEndpoint = localBackend ? `${localBackend.url}/api/runner/traffic` : null;
    this.localTelemetryEndpoint = localBackend ? `${localBackend.url}/api/runner/managed-telemetry` : null;
    this.localDiscoveryEndpoint = `${localBackend.url}/api/runner/network-discovery`;
    this.localInspectionEndpoint = `${localBackend.url}/api/runner/device-inspector`;
    this.localWorkEndpoint = `${localBackend.url}/api/runner/work/wait`;
    this.shortWorkWaitUntil = 0;
    this.assignmentHint = null;
    this.localBackendHeaders = localBackend ? {
      Authorization: `Bearer ${localBackend.token}`,
      "Content-Type": "application/json",
    } : null;
  }

  async heartbeat(runner) {
    const data = await this.#postLocalHeartbeat({ runner });
    const hints = data?.monitoring_assignments;
    this.assignmentHint = data?.id === runner.id && hints && Object.keys(hints).length === 2 &&
      typeof hints.health === "boolean" && typeof hints.telemetry === "boolean"
      ? { ...hints, receivedAt: Date.now() } : null;
    return data;
  }
  monitoringIdle(kind, now = Date.now()) {
    const hint = this.assignmentHint;
    const age = hint ? now - hint.receivedAt : Infinity;
    return ["health", "telemetry"].includes(kind) && hint?.[kind] === false && age >= 0 && age <= 120_000;
  }
  async waitForWork(runnerId, signal) {
    const quietWait = Date.now() >= this.shortWorkWaitUntil;
    const response = await fetch(this.localWorkEndpoint, {
      method: "POST", headers: this.localBackendHeaders,
      body: JSON.stringify({ runner_id: runnerId, ...(quietWait ? { wait_seconds: 60 } : {}) }),
      signal: AbortSignal.any([AbortSignal.timeout(quietWait ? 70_000 : 20_000), ...(signal ? [signal] : [])]),
    });
    // Capability fallback only: auth, capacity and transport failures never downgrade.
    if (response.status === 404 || response.status === 405) return { supported: false };
    if (quietWait && response.status === 400) {
      const errorBody = await response.text();
      let code;
      if (errorBody.length <= 4_096) {
        try { code = JSON.parse(errorBody)?.error?.code; } catch { /* no raw error propagation */ }
      }
      if (code === "INVALID_WORK_WAIT") {
        this.shortWorkWaitUntil = Date.now() + 60_000;
        return this.waitForWork(runnerId, signal);
      }
    }
    if (!response.ok) {
      const error = new Error(`Local work wait failed with HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const text = await response.text();
    if (text.length > 4_096) throw new Error("Invalid work wait response");
    let data;
    try { data = JSON.parse(text).data; } catch { throw new Error("Invalid work wait response"); }
    const kinds = ["manual_ping", "traffic", "discovery", "device_inspector"];
    if (!data || Object.keys(data).length !== 3 || data.runner_id !== runnerId ||
        typeof data.timed_out !== "boolean" || !Array.isArray(data.available) || data.available.length > 4 ||
        new Set(data.available).size !== data.available.length || data.available.some((kind) => !kinds.includes(kind)) ||
        data.timed_out !== (data.available.length === 0)) throw new Error("Invalid work wait response");
    return { supported: true, ...data };
  }
  claimPreflight() { return Promise.resolve(null); }
  completePreflight() { return Promise.resolve(null); }
  failPreflight() { return Promise.resolve(null); }
  claim() { return Promise.resolve(null); }
  updateJobContext() { return Promise.resolve(null); }
  progress() { return Promise.resolve(null); }
  complete() { return Promise.resolve(null); }
  fail() { return Promise.resolve(null); }
  claimTraffic(runnerId) { return this.#postRecurring("Traffic", this.localTrafficEndpoint, { action: "claim_session", runner_id: runnerId }); }
  trafficProgress(runnerId, sessionId, stage) { return this.#postRecurring("Traffic", this.localTrafficEndpoint, { action: "update_session", runner_id: runnerId, session_id: sessionId, stage }); }
  completeTraffic(runnerId, sessionId) { return this.#postRecurring("Traffic", this.localTrafficEndpoint, { action: "complete_session", runner_id: runnerId, session_id: sessionId }); }
  failTraffic(runnerId, sessionId, code, message) { return this.#postRecurring("Traffic", this.localTrafficEndpoint, { action: "fail_session", runner_id: runnerId, session_id: sessionId, error_code: code, error_message: message }); }
  healthTargets(runnerId) { return this.#postRecurring("Network health", this.localHealthEndpoint, { action: "list_targets", runner_id: runnerId }); }
  claimManualPing(runnerId) { return this.#postRecurring("Network health", this.localHealthEndpoint, { action: "claim_manual_ping", runner_id: runnerId }); }
  completeManualPing(runnerId, pingId, result) {
    return this.#postRecurring("Network health", this.localHealthEndpoint, { action: "complete_manual_ping", runner_id: runnerId, ping_id: pingId, result });
  }
  failManualPing(runnerId, pingId, errorCode) {
    return this.#postRecurring("Network health", this.localHealthEndpoint, { action: "fail_manual_ping", runner_id: runnerId, ping_id: pingId, error_code: errorCode });
  }
  publishHealth(runnerId, states, transitions) {
    return this.#postRecurring("Network health", this.localHealthEndpoint, { action: "publish", runner_id: runnerId, states, transitions });
  }
  claimDiscovery(runnerId) { return this.#postDiscovery({ action: "claim_session", runner_id: runnerId }); }
  discoveryContextReady(runnerId, sessionId, context) {
    return this.#postDiscovery({ action: "context_ready", runner_id: runnerId, session_id: sessionId, context });
  }
  discoveryProgress(runnerId, sessionId, context, progress) {
    return this.#postDiscovery({ action: "update_progress", runner_id: runnerId, session_id: sessionId, context, ...progress });
  }
  completeDiscovery(runnerId, sessionId, scannedHosts) {
    return this.#postDiscovery({ action: "complete_session", runner_id: runnerId, session_id: sessionId, scanned_hosts: scannedHosts });
  }
  failDiscovery(runnerId, sessionId, errorCode) {
    return this.#postDiscovery({ action: "fail_session", runner_id: runnerId, session_id: sessionId, error_code: errorCode });
  }
  claimInspection(runnerId) { return this.#postInspection({ action: "claim_session", runner_id: runnerId }); }
  inspectionStage(runnerId, inspectionId, stage) {
    return this.#postInspection({ action: "update_stage", runner_id: runnerId, inspection_id: inspectionId, stage });
  }
  completeInspection(runnerId, inspectionId, result) {
    return this.#postInspection({ action: "complete_session", runner_id: runnerId, inspection_id: inspectionId, result });
  }
  failInspection(runnerId, inspectionId, errorCode) {
    return this.#postInspection({ action: "fail_session", runner_id: runnerId, inspection_id: inspectionId, error_code: errorCode });
  }
  managedTelemetryTargets(runnerId) { return this.#postRecurring("Managed telemetry", this.localTelemetryEndpoint, { action: "list_targets", runner_id: runnerId }); }
  publishManagedTelemetry(runnerId, device, interfaces, transitions, observedHosts = []) {
    return this.#postRecurring("Managed telemetry", this.localTelemetryEndpoint, { action: "publish", runner_id: runnerId, device, interfaces, transitions, observed_hosts: observedHosts }, true);
  }

  async #postLocalHeartbeat(body) {
    const response = await fetch(this.localHeartbeatEndpoint, {
      method: "POST",
      headers: this.localBackendHeaders,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Local heartbeat request failed with HTTP ${response.status}`);
    return payload.data;
  }
  async #postRecurring(label, localEndpoint, body, managedTelemetryPublish = false) {
    const response = await fetch(localEndpoint, {
      method: "POST",
      headers: this.localBackendHeaders,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (managedTelemetryPublish) throw managedTelemetryPublishError(response.status, payload);
      throw new Error(backendFailureMessage(`Local ${label} backend`, response.status, payload));
    }
    return payload.data;
  }
async #postDiscovery(body) {
    return this.#postRecurring("Network discovery", this.localDiscoveryEndpoint, body);
  }
  async #postInspection(body) {
    return this.#postRecurring("Device inspection", this.localInspectionEndpoint, body);
  }
}

export function loadLocalHeartbeatConfig(environment = process.env) {
  const rawUrl = environment.LOCAL_BACKEND_URL?.trim();
  const token = environment.LOCAL_BACKEND_TOKEN;
  if (!rawUrl && !token) return null;
  if (!rawUrl || typeof token !== "string" || token.length < 32 || token.length > 512 || /\s/.test(token)) {
    throw new Error("Local heartbeat configuration is invalid");
  }
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
        url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
      throw new Error("invalid");
    }
    return Object.freeze({ url: url.origin, token });
  } catch {
    throw new Error("Local heartbeat configuration is invalid");
  }
}

export const loadLocalBackendConfig = loadLocalHeartbeatConfig;

export function exposeLocalBackendToWsl(localBackend, environment = process.env, platform = process.platform) {
  if (!localBackend || platform !== "win32") return;
  const entries = String(environment.WSLENV ?? "").split(":").filter(Boolean);
  const names = new Set(entries.map((entry) => entry.split("/")[0]));
  const exportedNames = ["LOCAL_BACKEND_URL", "LOCAL_BACKEND_TOKEN",
    ...(environment.PERSISTENCE_AUTHORITY ? ["PERSISTENCE_AUTHORITY"] : [])];
  for (const name of exportedNames) {
    if (!names.has(name)) entries.push(name);
  }
  environment.LOCAL_BACKEND_URL = localBackend.url;
  environment.LOCAL_BACKEND_TOKEN = localBackend.token;
  environment.WSLENV = entries.join(":");
}

const MANAGED_TELEMETRY_PUBLISH_CODE = "MANAGED_TELEMETRY_PUBLISH_FAILED";
const SAFE_BACKEND_CODE = /^[a-z][a-z0-9_-]{0,63}$/i;
const SECRET_SHAPED = /(?:authorization|bearer|token|password|passwd|secret|community|auth_password|priv_password|service_role|apikey|sb_[a-z0-9_-]+)/i;
const SAFE_MANAGED_TELEMETRY_MESSAGES = new Set([
  "Managed telemetry request failed",
  "Managed telemetry device payload is invalid",
  "Managed telemetry interface payload is invalid",
  "Managed telemetry event payload is invalid",
  "Managed telemetry interface target mismatch",
  "Managed telemetry event target mismatch",
  "Managed telemetry observed host payload is invalid",
  "Managed observed host state could not be prepared",
  "Latest managed observed host state could not be stored",
  "Stale managed observed host state could not be stored",
  "Managed telemetry payload is invalid",
  "Managed telemetry target authorization failed",
  "Managed telemetry target is not authorized",
  "Latest managed device state could not be stored",
  "Latest managed interface state could not be stored",
  "Stale managed interface state could not be removed",
  "Managed telemetry event deduplication failed",
  "Managed telemetry event could not be stored",
]);

export function managedTelemetryPublishError(status, payload) {
  const safeStatus = Number.isSafeInteger(status) && status >= 400 && status <= 599 ? status : null;
  const backendCode = safeBackendCode(payload);
  const backendMessage = safeBackendMessage(payload);
  const error = new Error(managedTelemetryPublishDiagnostic({
    code: MANAGED_TELEMETRY_PUBLISH_CODE,
    status: safeStatus,
    backendCode,
    backendMessage,
  }));
  error.code = MANAGED_TELEMETRY_PUBLISH_CODE;
  error.status = safeStatus;
  error.backendCode = backendCode;
  error.backendMessage = backendMessage;
  return error;
}

export function managedTelemetryPublishDiagnostic(error) {
  const parts = [`code=${MANAGED_TELEMETRY_PUBLISH_CODE}`];
  if (error?.code !== MANAGED_TELEMETRY_PUBLISH_CODE) return parts.join(" ");
  if (Number.isSafeInteger(error.status) && error.status >= 400 && error.status <= 599) parts.push(`status=${error.status}`);
  if (typeof error.backendCode === "string" && SAFE_BACKEND_CODE.test(error.backendCode) && !SECRET_SHAPED.test(error.backendCode)) {
    parts.push(`backend_code=${error.backendCode}`);
  }
  if (typeof error.backendMessage === "string" && SAFE_MANAGED_TELEMETRY_MESSAGES.has(error.backendMessage)) {
    parts.push(`backend_message=${JSON.stringify(error.backendMessage)}`);
  }
  return parts.join(" ");
}

function safeBackendCode(payload) {
  for (const candidate of [payload?.code, payload?.error_code, payload?.category, payload?.error?.code]) {
    if (typeof candidate === "string" && SAFE_BACKEND_CODE.test(candidate) && !SECRET_SHAPED.test(candidate)) return candidate;
  }
  return null;
}

function safeBackendMessage(payload) {
  const candidate = typeof payload?.error === "string" ? payload.error : payload?.error?.message;
  return typeof candidate === "string" && SAFE_MANAGED_TELEMETRY_MESSAGES.has(candidate) ? candidate : null;
}

export function backendFailureMessage(label, status, payload) {
  const detail = typeof payload?.error === "string"
    ? payload.error.replace(/[\r\n\x00-\x1f\x7f]/g, " ").trim().slice(0, 200)
    : "";
  return `${label} request failed with HTTP ${status}${detail ? `: ${detail}` : ""}`;
}
