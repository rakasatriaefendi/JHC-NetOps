export class BackendClient {
  constructor(url, serviceRoleKey, localBackend = null, persistenceAuthority = process.env.PERSISTENCE_AUTHORITY ?? "supabase") {
    if (!url || !serviceRoleKey) throw new Error("Backend credentials are unavailable");
    if (persistenceAuthority !== "supabase" && persistenceAuthority !== "local_postgres") {
      throw new Error("Persistence authority is invalid");
    }
    this.persistenceAuthority = persistenceAuthority;
    this.endpoint = `${url.replace(/\/$/, "")}/functions/v1/diagnostic-jobs`;
    this.trafficEndpoint = `${url.replace(/\/$/, "")}/functions/v1/traffic-live`;
    this.healthEndpoint = `${url.replace(/\/$/, "")}/functions/v1/network-health`;
    this.discoveryEndpoint = `${url.replace(/\/$/, "")}/functions/v1/network-discovery`;
    this.inspectionEndpoint = `${url.replace(/\/$/, "")}/functions/v1/device-inspector`;
    this.telemetryEndpoint = `${url.replace(/\/$/, "")}/functions/v1/managed-telemetry`;
    this.headers = {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      "Content-Type": "application/json",
    };
    this.localHeartbeatEndpoint = localBackend
      ? `${localBackend.url}/api/runner/heartbeat`
      : null;
    this.localHealthEndpoint = localBackend ? `${localBackend.url}/api/runner/network-health` : null;
    this.localTrafficEndpoint = localBackend ? `${localBackend.url}/api/runner/traffic` : null;
    this.localTelemetryEndpoint = localBackend ? `${localBackend.url}/api/runner/managed-telemetry` : null;
    this.localDiscoveryEndpoint = localBackend && persistenceAuthority === "local_postgres"
      ? `${localBackend.url}/api/runner/network-discovery`
      : null;
    this.localInspectionEndpoint = localBackend && persistenceAuthority === "local_postgres"
      ? `${localBackend.url}/api/runner/device-inspector`
      : null;
    this.localBackendHeaders = localBackend ? {
      Authorization: `Bearer ${localBackend.token}`,
      "Content-Type": "application/json",
    } : null;
  }

  heartbeat(runner) {
    return this.localHeartbeatEndpoint
      ? this.#postLocalHeartbeat({ runner })
      : this.#post({ action: "runner_heartbeat", runner });
  }
  claimPreflight(runnerId) { return this.#post({ action: "claim_preflight", runner_id: runnerId }); }
  completePreflight(runnerId, requestId, targetId, context) {
    return this.#post({ action: "complete_preflight", runner_id: runnerId, request_id: requestId, target_id: targetId, ...context });
  }
  failPreflight(runnerId, requestId, errorCode) {
    return this.#post({ action: "fail_preflight", runner_id: runnerId, request_id: requestId, error_code: errorCode });
  }
  claim(runnerId) { return this.#post({ action: "claim_job", runner_id: runnerId }); }
  updateJobContext(runnerId, jobId, context) {
    return this.#post({ action: "update_job_context", runner_id: runnerId, job_id: jobId, ...context });
  }
  progress(runnerId, jobId, stage, progress) {
    return this.#post({ action: "update_progress", runner_id: runnerId, job_id: jobId, stage, progress });
  }
  complete(runnerId, jobId) { return this.#post({ action: "complete_job", runner_id: runnerId, job_id: jobId }); }
  fail(runnerId, jobId, errorCode, errorMessage) {
    return this.#post({ action: "fail_job", runner_id: runnerId, job_id: jobId, error_code: errorCode, error_message: errorMessage });
  }
  claimTraffic(runnerId) { return this.#postRecurring("Traffic", this.localTrafficEndpoint, this.trafficEndpoint, { action: "claim_session", runner_id: runnerId }); }
  trafficProgress(runnerId, sessionId, stage) { return this.#postRecurring("Traffic", this.localTrafficEndpoint, this.trafficEndpoint, { action: "update_session", runner_id: runnerId, session_id: sessionId, stage }); }
  completeTraffic(runnerId, sessionId) { return this.#postRecurring("Traffic", this.localTrafficEndpoint, this.trafficEndpoint, { action: "complete_session", runner_id: runnerId, session_id: sessionId }); }
  failTraffic(runnerId, sessionId, code, message) { return this.#postRecurring("Traffic", this.localTrafficEndpoint, this.trafficEndpoint, { action: "fail_session", runner_id: runnerId, session_id: sessionId, error_code: code, error_message: message }); }
  healthTargets(runnerId) { return this.#postRecurring("Network health", this.localHealthEndpoint, this.healthEndpoint, { action: "list_targets", runner_id: runnerId }); }
  claimManualPing(runnerId) { return this.#postHealth({ action: "claim_manual_ping", runner_id: runnerId }); }
  completeManualPing(runnerId, pingId, result) {
    return this.#postHealth({ action: "complete_manual_ping", runner_id: runnerId, ping_id: pingId, result });
  }
  failManualPing(runnerId, pingId, errorCode) {
    return this.#postHealth({ action: "fail_manual_ping", runner_id: runnerId, ping_id: pingId, error_code: errorCode });
  }
  publishHealth(runnerId, states, transitions) {
    return this.#postRecurring("Network health", this.localHealthEndpoint, this.healthEndpoint, { action: "publish", runner_id: runnerId, states, transitions });
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
  managedTelemetryTargets(runnerId) { return this.#postRecurring("Managed telemetry", this.localTelemetryEndpoint, this.telemetryEndpoint, { action: "list_targets", runner_id: runnerId }); }
  publishManagedTelemetry(runnerId, device, interfaces, transitions, observedHosts = []) {
    return this.#postRecurring("Managed telemetry", this.localTelemetryEndpoint, this.telemetryEndpoint, { action: "publish", runner_id: runnerId, device, interfaces, transitions, observed_hosts: observedHosts }, true);
  }

  async #post(body) {
    this.#assertEdgeMutationAllowed();
    const response = await fetch(this.endpoint, { method: "POST", headers: this.headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(backendFailureMessage("Backend", response.status, payload));
    return payload.data;
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
  async #postRecurring(label, localEndpoint, edgeEndpoint, body, managedTelemetryPublish = false) {
    const local = Boolean(localEndpoint);
    if (!local) this.#assertEdgeMutationAllowed();
    const response = await fetch(localEndpoint ?? edgeEndpoint, {
      method: "POST",
      headers: local ? this.localBackendHeaders : this.headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (managedTelemetryPublish) throw managedTelemetryPublishError(response.status, payload);
      throw new Error(backendFailureMessage(`${local ? "Local " : ""}${label} backend`, response.status, payload));
    }
    return payload.data;
  }
  async #postHealth(body) {
    this.#assertEdgeMutationAllowed();
    const response = await fetch(this.healthEndpoint, { method: "POST", headers: this.headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(backendFailureMessage("Network health backend", response.status, payload));
    return payload.data;
  }
  async #postDiscovery(body) {
    return this.#postRecurring("Network discovery", this.localDiscoveryEndpoint, this.discoveryEndpoint, body);
  }
  async #postInspection(body) {
    return this.#postRecurring("Device inspection", this.localInspectionEndpoint, this.inspectionEndpoint, body);
  }

  #assertEdgeMutationAllowed() {
    if (this.persistenceAuthority !== "supabase") {
      throw new Error("Legacy Supabase application mutation is blocked under local_postgres authority");
    }
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
  for (const name of ["LOCAL_BACKEND_URL", "LOCAL_BACKEND_TOKEN"]) {
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
