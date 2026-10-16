import "server-only";

import { localBackendConfig } from "./assets.ts";
import { getApplicationAuthority, type ApplicationAuthority } from "./application-authority.ts";
import { historyFailure, parseHealthHistory, validHistorySelection, type HealthHistoryResult } from "./health-history.ts";
import type { HealthTrendRange } from "./network-health-client.ts";

export { getApplicationAuthority as applicationAuthority, type ApplicationAuthority };

export async function localApplicationRequest(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; data: unknown; code: string }> {
  getApplicationAuthority();
  const config = localBackendConfig();
  const approvedPath = safeApplicationPath(path);
  if (!config || !approvedPath) {
    return { ok: false, data: null, code: "LOCAL_APPLICATION_UNAVAILABLE" };
  }
  try {
    const response = await fetch(new URL(approvedPath, config.origin), {
      method,
      headers: { authorization: `Bearer ${config.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!record(payload)) return { ok: false, data: null, code: "LOCAL_APPLICATION_UNAVAILABLE" };
    if (!response.ok) return { ok: false, data: null, code: safeCode(payload, approvedPath) };
    return { ok: true, data: payload.data ?? null, code: "OK" };
  } catch {
    return { ok: false, data: null, code: "LOCAL_APPLICATION_UNAVAILABLE" };
  }
}

/** Bounded relative application path; query values are data, never an origin or path. */
export function safeApplicationPath(path: string): string | null {
  if (!path.startsWith("/api/application/") || path.length > 1_000 || path.includes("#")) return null;
  try {
    const base = new URL("http://application.internal");
    const parsed = new URL(path, base);
    if (parsed.origin !== base.origin || !/^\/api\/application\/[a-z0-9_/-]{1,200}$/i.test(parsed.pathname)) return null;
    const entries = [...parsed.searchParams.entries()];
    if (entries.length > 20 || entries.some(([key, value]) =>
      !/^[a-z0-9_]{1,64}$/i.test(key) || value.length >
        (parsed.pathname === "/api/application/network-health-samples" && key === "target_ids" ? 740 : 500) ||
      /[\u0000-\u001f\u007f]/.test(value))) return null;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

export async function localProfile(userId: string): Promise<Record<string, unknown> | null> {
  if (!uuid(userId)) return null;
  const response = await localApplicationRequest("GET", `/api/application/profiles/${userId}`);
  return response.ok && record(response.data) ? response.data : null;
}

export async function localProfiles(): Promise<Record<string, unknown>[] | null> {
  const response = await localApplicationRequest("GET", "/api/application/profiles");
  return response.ok && Array.isArray(response.data) && response.data.every(record) ? response.data : null;
}

export type AccountLifecycleResult = Readonly<{ ok: boolean; data: unknown; code: string }>;

export async function disableAccountLocal(actorId: string, targetId: string): Promise<AccountLifecycleResult> {
  if (!uuid(actorId) || !uuid(targetId)) return { ok: false, data: null, code: "INVALID_PROFILE" };
  return localApplicationRequest("POST", `/api/application/profiles/${targetId}/disable`, { actor_id: actorId });
}

export async function reenableAccountLocal(actorId: string, targetId: string): Promise<AccountLifecycleResult> {
  if (!uuid(actorId) || !uuid(targetId)) return { ok: false, data: null, code: "INVALID_PROFILE" };
  return localApplicationRequest("POST", `/api/application/profiles/${targetId}/reenable`, { actor_id: actorId });
}

export async function deleteAccountLocal(actorId: string, targetId: string, confirmation: string): Promise<AccountLifecycleResult> {
  if (!uuid(actorId) || !uuid(targetId) || confirmation !== "DELETE USER") {
    return { ok: false, data: null, code: "INVALID_PROFILE" };
  }
  return localApplicationRequest("DELETE", `/api/application/profiles/${targetId}`, { actor_id: actorId, confirmation });
}

export async function bootstrapLocalProfile(userId: string, email: string, fullName: string | null): Promise<Record<string, unknown> | null> {
  if (!uuid(userId)) return null;
  const response = await localApplicationRequest("POST", "/api/application/profiles/bootstrap",
    { auth_user_id: userId, email, full_name: fullName });
  return response.ok && record(response.data) ? response.data : null;
}

export async function localNetworkNodes(): Promise<Record<string, unknown>[] | null> {
  const response = await localApplicationRequest("GET", "/api/application/network-nodes");
  return response.ok && Array.isArray(response.data) && response.data.every(record) ? response.data : null;
}

export async function localNetworkNode(nodeId: string): Promise<Record<string, unknown> | null> {
  if (!uuid(nodeId)) return null;
  const response = await localApplicationRequest("GET", `/api/application/network-nodes/${nodeId}`);
  return response.ok && record(response.data) ? response.data : null;
}

export async function localRunner(runnerId: string): Promise<Record<string, unknown> | null> {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(runnerId)) return null;
  const response = await localApplicationRequest("GET", `/api/application/runners/${runnerId}`);
  return response.ok && record(response.data) ? response.data : null;
}

export async function localRunners(): Promise<Record<string, unknown>[] | null> {
  const response = await localApplicationRequest("GET", "/api/application/runners");
  return response.ok && Array.isArray(response.data) && response.data.every(record) ? response.data : null;
}

export async function localHealthTargets(): Promise<Record<string, unknown>[] | null> {
  const response = await localApplicationRequest("GET", "/api/application/network-targets");
  return response.ok && Array.isArray(response.data) && response.data.every(record) ? response.data : null;
}

export async function localHealthSamples(targetIds: string[], range: HealthTrendRange): Promise<HealthHistoryResult> {
  if (!validHistorySelection(targetIds, range)) return historyFailure("INVALID_HEALTH_HISTORY_REQUEST");
  if (!targetIds.length) return { data: [], error: false, code: "OK", metadata: null };
  const query = new URLSearchParams({ target_ids: [...targetIds].sort().join(","), range });
  const response = await localApplicationRequest("GET", `/api/application/network-health-samples?${query}`);
  return response.ok ? parseHealthHistory(response.data, targetIds, range) : historyFailure(response.code);
}

export async function localHealthTarget(targetId: string): Promise<Record<string, unknown> | null> {
  if (!uuid(targetId)) return null;
  const response = await localApplicationRequest("GET", `/api/application/network-targets/${targetId}`);
  return response.ok && record(response.data) ? response.data : null;
}

export async function localManagedTarget(targetId: string): Promise<Record<string, unknown> | null> {
  if (!uuid(targetId)) return null;
  const response = await localApplicationRequest("GET", `/api/application/managed-targets/${targetId}`);
  return response.ok && record(response.data) ? response.data : null;
}

export async function localManagedTargets(): Promise<Record<string, unknown>[] | null> {
  const response = await localApplicationRequest("GET", "/api/application/managed-targets");
  return response.ok && Array.isArray(response.data) && response.data.every(record) ? response.data : null;
}

export async function localManagedInterfaces(targetId?: string): Promise<Record<string, unknown>[] | null> {
  if (targetId !== undefined && !uuid(targetId)) return null;
  const query = targetId ? `?target_id=${encodeURIComponent(targetId)}` : "";
  const response = await localApplicationRequest("GET", `/api/application/managed-interfaces${query}`);
  return response.ok && Array.isArray(response.data) && response.data.every(record) ? response.data : null;
}

export async function localManagedObservedHosts(targetId?: string): Promise<Record<string, unknown>[] | null> {
  if (targetId !== undefined && !uuid(targetId)) return null;
  const query = targetId ? `?target_id=${encodeURIComponent(targetId)}` : "";
  const response = await localApplicationRequest("GET", `/api/application/managed-observed-hosts${query}`);
  return response.ok && Array.isArray(response.data) && response.data.every(record) ? response.data : null;
}

export async function localDiagnosticJobs(runnerId: string): Promise<Record<string, unknown>[] | null> {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(runnerId)) return null;
  const response = await localApplicationRequest("GET", `/api/application/diagnostic-jobs/runner/${runnerId}`);
  return response.ok && Array.isArray(response.data) && response.data.every(record) ? response.data : null;
}

export async function localDiagnosticJob(jobId: string): Promise<Record<string, unknown> | null> {
  if (!uuid(jobId)) return null;
  const response = await localApplicationRequest("GET", `/api/application/diagnostic-jobs/${jobId}`);
  return response.ok && record(response.data) ? response.data : null;
}

export async function localNetworkDiscovery(runnerId: string): Promise<Record<string, unknown> | null> {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(runnerId)) return null;
  const response = await localApplicationRequest("GET", `/api/application/network-discovery/${runnerId}`);
  return response.ok && record(response.data) ? response.data : null;
}

export async function localDeviceInspection(runnerId: string): Promise<Record<string, unknown> | null> {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(runnerId)) return null;
  const response = await localApplicationRequest("GET", `/api/application/device-inspection/${runnerId}`);
  return response.ok && record(response.data) ? response.data : null;
}

export async function localPingJobs(runnerId: string): Promise<Record<string, unknown>[] | null> {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(runnerId)) return null;
  const response = await localApplicationRequest("GET", `/api/application/ping-jobs/runner/${runnerId}`);
  return response.ok && Array.isArray(response.data) && response.data.every(record) ? response.data : null;
}

export async function localPingJob(jobId: string): Promise<{ ok: boolean; data: Record<string, unknown> | null; code: string }> {
  if (!uuid(jobId)) return { ok: false, data: null, code: "INVALID_CONTROL_PLANE_INPUT" };
  const response = await localApplicationRequest("GET", `/api/application/ping-jobs/${jobId}`);
  return response.ok && record(response.data)
    ? { ok: true, data: response.data, code: "OK" }
    : { ok: false, data: null, code: response.ok ? "MANUAL_PING_RESULT_UNAVAILABLE" : response.code };
}

export async function localBandwidthMeasurements(limit = 100): Promise<Record<string, unknown>[] | null> {
  const response = await localApplicationRequest("GET", `/api/application/bandwidth-measurements?limit=${limit}`);
  return response.ok && Array.isArray(response.data) && response.data.every(record) ? response.data : null;
}

export async function localBandwidthByJob(jobId: string): Promise<Record<string, unknown>[] | null> {
  if (!uuid(jobId)) return null;
  const response = await localApplicationRequest("GET", `/api/application/bandwidth-measurements/job/${jobId}`);
  return response.ok && Array.isArray(response.data) && response.data.every(record) ? response.data : null;
}

export async function localHopBySession(sessionId: string): Promise<Record<string, unknown>[] | null> {
  if (!uuid(sessionId)) return null;
  const response = await localApplicationRequest("GET", `/api/application/hop-measurements/session/${sessionId}`);
  return response.ok && Array.isArray(response.data) && response.data.every(record) ? response.data : null;
}

export async function localHopByJob(jobId: string): Promise<Record<string, unknown>[] | null> {
  if (!uuid(jobId)) return null;
  const response = await localApplicationRequest("GET", `/api/application/hop-measurements/job/${jobId}`);
  return response.ok && Array.isArray(response.data) && response.data.every(record) ? response.data : null;
}

export async function localTrafficMetrics(limit = 100): Promise<Record<string, unknown>[] | null> {
  const response = await localApplicationRequest("GET", `/api/application/traffic-metrics?limit=${limit}`);
  return response.ok && Array.isArray(response.data) && response.data.every(record) ? response.data : null;
}

export async function localTrafficMetricsByStatus(status: string): Promise<Record<string, unknown>[] | null> {
  const response = await localApplicationRequest("GET", `/api/application/traffic-metrics/status/${status}`);
  return response.ok && Array.isArray(response.data) && response.data.every(record) ? response.data : null;
}

export async function localHopMeasurements(limit = 512): Promise<Record<string, unknown>[] | null> {
  const bounded = Math.max(1, Math.min(4096, Math.trunc(limit)));
  const response = await localApplicationRequest("GET", `/api/application/hop-measurements?limit=${bounded}`);
  return response.ok && Array.isArray(response.data) && response.data.every(record) ? response.data : null;
}

export async function localTrafficState(): Promise<Record<string, unknown> | null> {
  const response = await localApplicationRequest("GET", "/api/application/traffic-state");
  return response.ok && record(response.data) ? response.data : null;
}

export async function localEvents(limit = 50, source?: string, sourceRef?: string): Promise<Record<string, unknown>[] | null> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (source) params.set("source", source);
  if (sourceRef) params.set("source_ref", sourceRef);
  const response = await localApplicationRequest("GET", `/api/application/events?${params.toString()}`);
  return response.ok && Array.isArray(response.data) && response.data.every(record) ? response.data : null;
}

export async function localOpenEvents(limit = 50, source: string): Promise<Record<string, unknown>[] | null> {
  const params = new URLSearchParams({ limit: String(limit), source, unresolved: "true" });
  const response = await localApplicationRequest("GET", `/api/application/events?${params.toString()}`);
  return response.ok && Array.isArray(response.data) && response.data.every(record) ? response.data : null;
}

export async function requestDiagnosticPreflightLocal(actorId: string, runnerId: string,
  targetId: string): Promise<Record<string, unknown> | null> {
  const response = await localApplicationRequest("POST", "/api/application/diagnostic-jobs/preflight",
    { actor_id: actorId, input: { runner_id: runnerId, target_id: targetId } });
  return response.ok && record(response.data) ? response.data : null;
}

export async function createDiagnosticJobLocal(actorId: string, input: Readonly<{
  runner_id: string;
  source_label: string;
  target_id: string;
  duration_seconds: number;
}>): Promise<Record<string, unknown> | null> {
  const response = await localApplicationRequest("POST", "/api/application/diagnostic-jobs",
    { actor_id: actorId, input });
  return response.ok && record(response.data) ? response.data : null;
}

export async function createPingJobLocal(actorId: string, input: Readonly<{
  target_id: string;
}>): Promise<{ ok: boolean; data: Record<string, unknown> | null; code: string }> {
  const response = await localApplicationRequest("POST", "/api/application/ping-jobs",
    { actor_id: actorId, input });
  return response.ok && record(response.data)
    ? { ok: true, data: response.data, code: "OK" }
    : { ok: false, data: null, code: response.ok ? "MANUAL_PING_RESULT_UNAVAILABLE" : response.code };
}

export async function createNetworkDiscoveryLocal(actorId: string, input: Readonly<{
  runner_id: string;
}>): Promise<Record<string, unknown> | null> {
  const response = await localApplicationRequest("POST", "/api/application/network-discovery",
    { actor_id: actorId, input });
  return response.ok && record(response.data) ? response.data : null;
}

export async function startNetworkDiscoveryLocal(actorId: string, runnerId: string,
  sessionId: string): Promise<Record<string, unknown> | null> {
  const response = await localApplicationRequest("PATCH", `/api/application/network-discovery/${runnerId}`,
    { actor_id: actorId, input: { session_id: sessionId } });
  return response.ok && record(response.data) ? response.data : null;
}

export async function createDeviceInspectionLocal(actorId: string, input: Readonly<{
  runner_id: string;
  target_ip: string;
}>): Promise<Record<string, unknown> | null> {
  const response = await localApplicationRequest("POST", "/api/application/device-inspection",
    { actor_id: actorId, input });
  return response.ok && record(response.data) ? response.data : null;
}

export async function createTrafficSessionLocal(actorId: string, input: Readonly<{
  runner_id: string;
  duration_seconds: number;
}>): Promise<Record<string, unknown> | null> {
  const response = await localApplicationRequest("POST", "/api/application/traffic-live-sessions",
    { actor_id: actorId, input });
  return response.ok && record(response.data) ? response.data : null;
}

export async function stopTrafficSessionLocal(actorId: string, sessionId: string): Promise<Record<string, unknown> | null> {
  const response = await localApplicationRequest("DELETE", `/api/application/traffic-live-sessions/${sessionId}`,
    { actor_id: actorId, input: { session_id: sessionId } });
  return response.ok && record(response.data) ? response.data : null;
}

export function applicationDeleted(result: { ok: boolean; data: unknown }): boolean {
  return result.ok && record(result.data) && result.data.deleted === true;
}

export function uuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function safeCode(value: Record<string, unknown>, path = ""): string {
  if (!record(value.error) || typeof value.error.code !== "string") return "LOCAL_APPLICATION_UNAVAILABLE";
  if (value.error.code === "UNAUTHORIZED" && path.startsWith("/api/application/network-health-samples?")) return "UNAUTHORIZED";
  return new Set(["INVALID_APPLICATION_REQUEST", "INVALID_INVENTORY_INPUT", "OPERATOR_ACCESS_REQUIRED",
    "ADMIN_ACCESS_REQUIRED", "PROFILE_ACCESS_REQUIRED", "PROFILE_NOT_FOUND", "DEPENDENT_TARGETS_PRESENT", "RUNNER_PROFILE_UNAVAILABLE",
    "SELF_DEMOTION_BLOCKED", "LAST_ADMIN_BLOCKED", "INVALID_PROFILE", "SELF_DELETE_BLOCKED", "SELF_DISABLE_BLOCKED",
    "LAST_LOGIN_CAPABLE_ADMIN_BLOCKED", "ACCOUNT_HAS_HISTORY", "ACCOUNT_NOT_DISABLEABLE",
    "ACCOUNT_NOT_REENABLEABLE", "ACCOUNT_NOT_DELETABLE", "NODE_NOT_FOUND", "TARGET_NOT_FOUND",
    "RUNNER_NOT_FOUND", "CONFIRMATION_MISMATCH", "INVENTORY_DUPLICATE",
    "INVALID_CONTROL_PLANE_INPUT", "RUNNER_BUSY", "RUNNER_OFFLINE", "OPERATION_NOT_AUTHORIZED",
    "TARGET_NOT_AUTHORIZED", "OPERATION_NOT_READY", "STORAGE_CRITICAL", "ALREADY_ACTIVE",
    "INVALID_HEALTH_HISTORY_REQUEST", "HEALTH_HISTORY_TARGET_UNAVAILABLE", "HEALTH_HISTORY_RESPONSE_TOO_LARGE",
    "HEALTH_HISTORY_QUERY_FAILED"]).has(value.error.code)
    ? value.error.code : "LOCAL_APPLICATION_UNAVAILABLE";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
