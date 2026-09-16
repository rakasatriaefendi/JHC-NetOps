import { localBackendConfig } from "./assets.ts";

export type ApplicationAuthority = "supabase" | "local_postgres";

export function applicationAuthority(environment: Readonly<Record<string, string | undefined>> = process.env): ApplicationAuthority {
  const value = environment.PERSISTENCE_AUTHORITY?.trim();
  if (value !== "supabase" && value !== "local_postgres") {
    throw new Error("Application persistence authority is missing or invalid");
  }
  return value;
}

export async function localApplicationRequest(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; data: unknown; code: string }> {
  if (applicationAuthority() !== "local_postgres") {
    throw new Error("Local application request requires local_postgres authority");
  }
  const config = localBackendConfig();
  if (!config || !/^\/api\/application\/[a-z0-9_/-]{1,200}$/i.test(path)) {
    return { ok: false, data: null, code: "LOCAL_APPLICATION_UNAVAILABLE" };
  }
  try {
    const response = await fetch(new URL(path, config.origin), {
      method,
      headers: { authorization: `Bearer ${config.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!record(payload)) return { ok: false, data: null, code: "LOCAL_APPLICATION_UNAVAILABLE" };
    if (!response.ok) return { ok: false, data: null, code: safeCode(payload) };
    return { ok: true, data: payload.data ?? null, code: "OK" };
  } catch {
    return { ok: false, data: null, code: "LOCAL_APPLICATION_UNAVAILABLE" };
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

export async function localPingJob(jobId: string): Promise<Record<string, unknown> | null> {
  if (!uuid(jobId)) return null;
  const response = await localApplicationRequest("GET", `/api/application/ping-jobs/${jobId}`);
  return response.ok && record(response.data) ? response.data : null;
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

export async function localEvents(limit = 50, source?: string, sourceRef?: string): Promise<Record<string, unknown>[] | null> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (source) params.set("source", source);
  if (sourceRef) params.set("source_ref", sourceRef);
  const response = await localApplicationRequest("GET", `/api/application/events?${params.toString()}`);
  return response.ok && Array.isArray(response.data) && response.data.every(record) ? response.data : null;
}

export function applicationDeleted(result: { ok: boolean; data: unknown }): boolean {
  return result.ok && record(result.data) && result.data.deleted === true;
}

export function uuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function safeCode(value: Record<string, unknown>): string {
  if (!record(value.error) || typeof value.error.code !== "string") return "LOCAL_APPLICATION_UNAVAILABLE";
  return new Set(["INVALID_APPLICATION_REQUEST", "INVALID_INVENTORY_INPUT", "OPERATOR_ACCESS_REQUIRED",
    "ADMIN_ACCESS_REQUIRED", "PROFILE_NOT_FOUND", "DEPENDENT_TARGETS_PRESENT", "RUNNER_PROFILE_UNAVAILABLE",
    "SELF_DEMOTION_BLOCKED", "LAST_ADMIN_BLOCKED", "NODE_NOT_FOUND", "TARGET_NOT_FOUND",
    "RUNNER_NOT_FOUND", "CONFIRMATION_MISMATCH", "INVENTORY_DUPLICATE"]).has(value.error.code)
    ? value.error.code : "LOCAL_APPLICATION_UNAVAILABLE";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
