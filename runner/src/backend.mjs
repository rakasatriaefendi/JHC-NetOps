export class BackendClient {
  constructor(url, serviceRoleKey) {
    if (!url || !serviceRoleKey) throw new Error("Backend credentials are unavailable");
    this.endpoint = `${url.replace(/\/$/, "")}/functions/v1/diagnostic-jobs`;
    this.trafficEndpoint = `${url.replace(/\/$/, "")}/functions/v1/traffic-live`;
    this.healthEndpoint = `${url.replace(/\/$/, "")}/functions/v1/network-health`;
    this.discoveryEndpoint = `${url.replace(/\/$/, "")}/functions/v1/network-discovery`;
    this.inspectionEndpoint = `${url.replace(/\/$/, "")}/functions/v1/device-inspector`;
    this.headers = {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      "Content-Type": "application/json",
    };
  }

  heartbeat(runner) { return this.#post({ action: "runner_heartbeat", runner }); }
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
  claimTraffic(runnerId) { return this.#postTraffic({ action: "claim_session", runner_id: runnerId }); }
  trafficProgress(runnerId, sessionId, stage) { return this.#postTraffic({ action: "update_session", runner_id: runnerId, session_id: sessionId, stage }); }
  completeTraffic(runnerId, sessionId) { return this.#postTraffic({ action: "complete_session", runner_id: runnerId, session_id: sessionId }); }
  failTraffic(runnerId, sessionId, code, message) { return this.#postTraffic({ action: "fail_session", runner_id: runnerId, session_id: sessionId, error_code: code, error_message: message }); }
  healthTargets(runnerId) { return this.#postHealth({ action: "list_targets", runner_id: runnerId }); }
  publishHealth(runnerId, states, transitions) {
    return this.#postHealth({ action: "publish", runner_id: runnerId, states, transitions });
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

  async #post(body) {
    const response = await fetch(this.endpoint, { method: "POST", headers: this.headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(backendFailureMessage("Backend", response.status, payload));
    return payload.data;
  }
  async #postTraffic(body) {
    const response = await fetch(this.trafficEndpoint, { method: "POST", headers: this.headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(backendFailureMessage("Traffic backend", response.status, payload));
    return payload.data;
  }
  async #postHealth(body) {
    const response = await fetch(this.healthEndpoint, { method: "POST", headers: this.headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(backendFailureMessage("Network health backend", response.status, payload));
    return payload.data;
  }
  async #postDiscovery(body) {
    const response = await fetch(this.discoveryEndpoint, { method: "POST", headers: this.headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(backendFailureMessage("Network discovery backend", response.status, payload));
    return payload.data;
  }
  async #postInspection(body) {
    const response = await fetch(this.inspectionEndpoint, { method: "POST", headers: this.headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(backendFailureMessage("Device inspection backend", response.status, payload));
    return payload.data;
  }
}

export function backendFailureMessage(label, status, payload) {
  const detail = typeof payload?.error === "string"
    ? payload.error.replace(/[\r\n\x00-\x1f\x7f]/g, " ").trim().slice(0, 200)
    : "";
  return `${label} request failed with HTTP ${status}${detail ? `: ${detail}` : ""}`;
}
