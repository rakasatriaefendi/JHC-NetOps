import { createClient } from "@supabase/supabase-js";

type ConnectionType = "wifi" | "ethernet";
type Environment = "lan" | "localhost_demo";
type JobStage =
  | "queued"
  | "preparing_runner"
  | "starting_wsl"
  | "checking_target"
  | "upload"
  | "download"
  | "mtr"
  | "saving"
  | "complete"
  | "failed";

type RunnerTarget = {
  id: string;
  label: string;
  host: string;
  iperf_port: number;
  environment: Environment;
};

type RunnerCapabilities = {
  source_locations: string[];
  targets: RunnerTarget[];
  durations: number[];
  traffic_durations_seconds: number[];
  operations: ("bandwidth_and_path" | "traffic_live" | "network_discovery" | "device_inspect")[];
  device_inspector?: {
    schema_version: 1;
    available: true;
    probe_engine: "python_socket";
    python_version: string;
    required: Record<string, boolean>;
    collectors: Record<string, boolean>;
    optional: Record<string, boolean>;
    available_but_unused: Record<string, boolean>;
    optional_not_required: Record<string, boolean>;
  };
};
type NetworkContext = Record<string, unknown> & { connection_type: "wifi" | "ethernet" | "unknown" };
type RouteContext = Record<string, unknown>;
type PreflightContext = Record<string, unknown> & { iperf: Record<string, unknown> & { ready: boolean } };
type DiagnosticContext = { network_context: NetworkContext; route_context: RouteContext; preflight: PreflightContext };

const RUNNER_FRESHNESS_MS = 30_000;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};
const RUNNING_STAGES = new Set<JobStage>([
  "preparing_runner",
  "starting_wsl",
  "checking_target",
  "upload",
  "download",
  "mtr",
  "saving",
]);
const SAFE_ERROR_CODES = new Set([
  "AGENT_PROTOCOL_ERROR",
  "AGENT_PYTHON_UNSUPPORTED",
  "AGENT_VENV_MISSING",
  "BACKEND_UPLOAD_FAILED",
  "DOWNLOAD_FAILED",
  "INVALID_CONNECTION_TYPE",
  "INVALID_JOB",
  "INVALID_TARGET",
  "IPERF3_MISSING",
  "IPERF3_SERVER_UNAVAILABLE",
  "JOB_TIMEOUT",
  "MTR_FAILED",
  "MTR_MISSING",
  "RUNNER_INTERNAL_ERROR",
  "TARGET_UNREACHABLE",
  "UPLOAD_FAILED",
  "WSL_DISTRO_NOT_FOUND",
  "WSL_INVOCATION_TIMEOUT",
  "WSL_RUNTIME_FAILED",
  "WSL_START_FAILED",
  "NETWORK_CONTEXT_UNAVAILABLE",
  "NETWORK_CONTEXT_INVALID",
  "NETWORK_INTERFACE_DOWN",
  "NO_ROUTE_TO_TARGET",
]);
const PREFLIGHT_FRESHNESS_MS = 90_000;

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method === "GET") {
    return readState(request);
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, { Allow: "GET, POST" });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON" }, 400);
  }
  if (!isRecord(payload) || typeof payload.action !== "string") {
    return jsonResponse({ error: "A structured action is required" }, 400);
  }

  if (payload.action === "create_job") {
    return createJob(request, payload);
  }
  if (payload.action === "request_preflight") {
    return requestPreflight(request, payload);
  }
  return handleRunnerAction(request, payload);
});

async function readState(request: Request): Promise<Response> {
  const auth = await approvedUserClient(request);
  if (!auth.ok) return auth.response;

  const [runners, jobs] = await Promise.all([
    auth.client
      .from("diagnostic_runners")
      .select("id, display_name, last_seen_at, health_status, health_error_code, capabilities, preflight, updated_at")
      .order("display_name", { ascending: true }),
    auth.client
      .from("diagnostic_jobs")
      .select("id, runner_id, requested_by, status, type, source_label, target_id, target_label, target_host, iperf_port, connection_type, duration_seconds, environment, stage, progress, network_context, route_context, preflight_context, error_code, error_message, created_at, started_at, completed_at, updated_at")
      .order("created_at", { ascending: false })
      .limit(25),
  ]);

  if (runners.error || jobs.error) {
    console.error("diagnostic job state read failed", runners.error?.message ?? jobs.error?.message);
    return jsonResponse({ error: "Diagnostic state could not be loaded" }, 500);
  }
  return jsonResponse(
    { data: { runners: runners.data, jobs: jobs.data, server_time: new Date().toISOString() } },
    200,
  );
}

async function createJob(
  request: Request,
  payload: Record<string, unknown>,
): Promise<Response> {
  const auth = await approvedUserClient(request);
  if (!auth.ok) return auth.response;
  if (auth.role !== "admin") return jsonResponse({ error: "Only an admin may start an active bandwidth diagnostic" }, 403);

  if (!isIdentifier(payload.runner_id) || !isLabel(payload.source_label)) {
    return jsonResponse({ error: "runner_id and source_label are required" }, 400);
  }
  if (!isIdentifier(payload.target_id)) {
    return jsonResponse({ error: "target_id is invalid" }, 400);
  }
  if (!isDuration(payload.duration_seconds)) {
    return jsonResponse({ error: "duration_seconds must be 5 or 10" }, 400);
  }
  if (payload.type !== "bandwidth_and_path") {
    return jsonResponse({ error: "Unsupported diagnostic operation" }, 400);
  }

  const { data: runner, error: runnerError } = await auth.client
    .from("diagnostic_runners")
    .select("id, last_seen_at, health_status, capabilities, preflight")
    .eq("id", payload.runner_id)
    .maybeSingle();
  if (runnerError) {
    console.error("runner lookup failed", runnerError.message);
    return jsonResponse({ error: "Runner could not be checked" }, 500);
  }
  if (!runner || Date.now() - Date.parse(runner.last_seen_at) > RUNNER_FRESHNESS_MS) {
    return jsonResponse({ error: "Local diagnostic runner offline", code: "RUNNER_OFFLINE" }, 409);
  }
  if (runner.health_status !== "online") {
    return jsonResponse({ error: "Local diagnostic runner has a setup issue", code: "RUNNER_DEGRADED" }, 409);
  }

  const capabilities = validateCapabilities(runner.capabilities);
  if (!capabilities.ok) {
    return jsonResponse({ error: "Runner capabilities are invalid" }, 409);
  }
  if (!capabilities.value.source_locations.includes(payload.source_label)) {
    return jsonResponse({ error: "Source location is not authorized" }, 400);
  }
  if (!capabilities.value.durations.includes(payload.duration_seconds)) {
    return jsonResponse({ error: "Duration is not authorized" }, 400);
  }
  const target = capabilities.value.targets.find((item) => item.id === payload.target_id);
  if (!target) {
    return jsonResponse({ error: "Target is not authorized" }, 400);
  }
  const ready = validateStoredPreflight(runner.preflight, target);
  if (!ready.ok) return jsonResponse({ error: ready.error, code: ready.code }, 409);

  const { error: recoveryError } = await auth.serviceClient
    .rpc("expire_stale_traffic_sessions", { p_runner_id: runner.id });
  if (recoveryError) {
    console.error("traffic session recovery failed", recoveryError.message);
    return jsonResponse({ error: "Runner availability could not be checked" }, 500);
  }
  const { count: activeTrafficCount, error: activeTrafficError } = await auth.serviceClient
    .from("traffic_live_sessions")
    .select("id", { count: "exact", head: true })
    .eq("runner_id", runner.id)
    .in("status", ["queued", "running", "stopping"]);
  if (activeTrafficError) {
    console.error("traffic session availability check failed", activeTrafficError.message);
    return jsonResponse({ error: "Runner availability could not be checked" }, 500);
  }
  if ((activeTrafficCount ?? 0) > 0) {
    return jsonResponse({ error: "Runner is busy with a Traffic capture", code: "RUNNER_BUSY" }, 409);
  }
  const [{ count: activeDiscoveryCount }, { count: activeInspectionCount }] = await Promise.all([
    auth.serviceClient.from("network_discovery_sessions").select("session_id", { count: "exact", head: true }).eq("runner_id", runner.id).in("status", ["queued", "running"]),
    auth.serviceClient.from("device_inspection_sessions").select("inspection_id", { count: "exact", head: true }).eq("runner_id", runner.id).in("status", ["queued", "running"]),
  ]);
  if ((activeDiscoveryCount ?? 0) > 0 || (activeInspectionCount ?? 0) > 0) {
    return jsonResponse({ error: "Runner is busy with another active operation", code: "RUNNER_BUSY" }, 409);
  }

  const { data, error } = await auth.serviceClient
    .from("diagnostic_jobs")
    .insert({
      runner_id: runner.id,
      requested_by: auth.userId,
      status: "queued",
      type: "bandwidth_and_path",
      source_label: payload.source_label,
      target_id: target.id,
      target_label: target.label,
      target_host: target.host,
      iperf_port: target.iperf_port,
      connection_type: ready.value.network_context.connection_type,
      duration_seconds: payload.duration_seconds,
      environment: target.environment,
      stage: "queued",
      progress: {},
      network_context: ready.value.network_context,
      route_context: ready.value.route_context,
      preflight_context: ready.value.preflight,
    })
    .select("id, runner_id, requested_by, status, type, source_label, target_id, target_label, target_host, iperf_port, connection_type, duration_seconds, environment, stage, progress, network_context, route_context, preflight_context, error_code, error_message, created_at, started_at, completed_at, updated_at")
    .single();

  if (error) {
    if (error.code === "23505") {
      return jsonResponse({ error: "Runner already has an active diagnostic job", code: "RUNNER_BUSY" }, 409);
    }
    console.error("diagnostic job insert failed", error.message);
    return jsonResponse({ error: "Diagnostic job could not be created" }, 500);
  }
  return jsonResponse({ data }, 201);
}

async function requestPreflight(request: Request, payload: Record<string, unknown>): Promise<Response> {
  const auth = await approvedUserClient(request);
  if (!auth.ok) return auth.response;
  if (!isIdentifier(payload.runner_id) || !isIdentifier(payload.target_id)) {
    return jsonResponse({ error: "runner_id and target_id are required" }, 400);
  }
  const { data: runner, error } = await auth.client
    .from("diagnostic_runners")
    .select("id,last_seen_at,health_status,capabilities,preflight")
    .eq("id", payload.runner_id)
    .maybeSingle();
  if (error) return jsonResponse({ error: "Runner could not be checked" }, 500);
  if (!runner || runner.health_status !== "online" || Date.now() - Date.parse(runner.last_seen_at) > RUNNER_FRESHNESS_MS) {
    return jsonResponse({ error: "Local diagnostic runner offline", code: "RUNNER_OFFLINE" }, 409);
  }
  const capabilities = validateCapabilities(runner.capabilities);
  if (!capabilities.ok) return jsonResponse({ error: "Runner capabilities are invalid" }, 409);
  const target = capabilities.value.targets.find((item) => item.id === payload.target_id);
  if (!target) return jsonResponse({ error: "Target is not authorized" }, 400);

  if (isRecord(runner.preflight) && runner.preflight.target_id === target.id &&
      (runner.preflight.status === "queued" || runner.preflight.status === "running") &&
      typeof runner.preflight.requested_at === "string" && Date.now() - Date.parse(runner.preflight.requested_at) < PREFLIGHT_FRESHNESS_MS) {
    return jsonResponse({ data: runner.preflight }, 200);
  }
  if (isRecord(runner.preflight) && runner.preflight.target_id === target.id && runner.preflight.status === "completed" &&
      typeof runner.preflight.completed_at === "string" && Date.now() - Date.parse(runner.preflight.completed_at) < PREFLIGHT_FRESHNESS_MS) {
    return jsonResponse({ data: runner.preflight }, 200);
  }

  const state = {
    request_id: crypto.randomUUID(),
    target_id: target.id,
    status: "queued",
    requested_at: new Date().toISOString(),
  };
  const { data, error: updateError } = await auth.serviceClient
    .from("diagnostic_runners")
    .update({ preflight: state, updated_at: new Date().toISOString() })
    .eq("id", runner.id)
    .select("preflight")
    .single();
  if (updateError) return jsonResponse({ error: "Target preflight could not be queued" }, 500);
  return jsonResponse({ data: data.preflight }, 202);
}

async function handleRunnerAction(
  request: Request,
  payload: Record<string, unknown>,
): Promise<Response> {
  const service = serviceRoleClient(request);
  if (!service.ok) return service.response;

  if (payload.action === "runner_heartbeat") {
    return heartbeat(service.client, payload);
  }
  if (!isIdentifier(payload.runner_id)) {
    return jsonResponse({ error: "runner_id is invalid" }, 400);
  }
  if (payload.action === "claim_job") {
    return claimJob(service.client, payload.runner_id);
  }
  if (payload.action === "claim_preflight") return claimPreflight(service.client, payload.runner_id);
  if (payload.action === "complete_preflight" || payload.action === "fail_preflight") {
    if (!isUuid(payload.request_id)) return jsonResponse({ error: "request_id is invalid" }, 400);
    return finishPreflight(service.client, payload.runner_id, payload.request_id, payload.action === "complete_preflight", payload);
  }
  if (!isUuid(payload.job_id)) {
    return jsonResponse({ error: "job_id is invalid" }, 400);
  }
  if (payload.action === "update_progress") {
    return updateProgress(service.client, payload.runner_id, payload.job_id, payload);
  }
  if (payload.action === "update_job_context") {
    return updateJobContext(service.client, payload.runner_id, payload.job_id, payload);
  }
  if (payload.action === "complete_job") {
    return finishJob(service.client, payload.runner_id, payload.job_id, true, payload);
  }
  if (payload.action === "fail_job") {
    return finishJob(service.client, payload.runner_id, payload.job_id, false, payload);
  }
  return jsonResponse({ error: "Unsupported runner action" }, 400);
}

async function heartbeat(client: ReturnType<typeof createClient>, payload: Record<string, unknown>) {
  if (!isRecord(payload.runner) || !isIdentifier(payload.runner.id) || !isLabel(payload.runner.display_name)) {
    return jsonResponse({ error: "Runner identity is invalid" }, 400);
  }
  if (payload.runner.health_status !== "online" && payload.runner.health_status !== "degraded") {
    return jsonResponse({ error: "Runner health status is invalid" }, 400);
  }
  if (
    payload.runner.health_error_code !== null &&
    (typeof payload.runner.health_error_code !== "string" || !SAFE_ERROR_CODES.has(payload.runner.health_error_code))
  ) {
    return jsonResponse({ error: "Runner health error code is invalid" }, 400);
  }
  const capabilities = validateCapabilities(payload.runner.capabilities);
  if (!capabilities.ok) {
    return jsonResponse({ error: capabilities.error }, 400);
  }
  const now = new Date().toISOString();
  const { data, error } = await client
    .from("diagnostic_runners")
    .upsert({
      id: payload.runner.id,
      display_name: payload.runner.display_name,
      last_seen_at: now,
      health_status: payload.runner.health_status,
      health_error_code: payload.runner.health_error_code,
      capabilities: capabilities.value,
      updated_at: now,
    })
    .select("id, last_seen_at, health_status, health_error_code")
    .single();
  if (error) {
    console.error("runner heartbeat failed", error.message);
    return jsonResponse({ error: "Runner heartbeat could not be stored" }, 500);
  }
  const { error: recoveryError } = await client
    .rpc("expire_stale_traffic_sessions", { p_runner_id: payload.runner.id });
  if (recoveryError) {
    console.error("traffic session recovery on heartbeat failed", recoveryError.message);
    return jsonResponse({ error: "Runner heartbeat recovery failed" }, 500);
  }
  return jsonResponse({ data }, 200);
}

async function claimJob(client: ReturnType<typeof createClient>, runnerId: string) {
  const { data: queued, error: readError } = await client
    .from("diagnostic_jobs")
    .select("id")
    .eq("runner_id", runnerId)
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (readError) {
    console.error("queued job lookup failed", readError.message);
    return jsonResponse({ error: "Queued job could not be read" }, 500);
  }
  if (!queued) return jsonResponse({ data: null }, 200);

  const now = new Date().toISOString();
  const { data, error } = await client
    .from("diagnostic_jobs")
    .update({
      status: "running",
      stage: "preparing_runner",
      started_at: now,
      updated_at: now,
      progress: {},
      error_code: null,
      error_message: null,
    })
    .eq("id", queued.id)
    .eq("runner_id", runnerId)
    .eq("status", "queued")
    .select("id, runner_id, requested_by, status, type, source_label, target_id, target_label, target_host, iperf_port, connection_type, duration_seconds, environment, stage, created_at, started_at")
    .maybeSingle();
  if (error) {
    console.error("job claim failed", error.message);
    return jsonResponse({ error: "Job could not be claimed" }, 500);
  }
  return jsonResponse({ data }, 200);
}

async function claimPreflight(client: ReturnType<typeof createClient>, runnerId: string) {
  const { data: runner, error } = await client
    .from("diagnostic_runners")
    .select("preflight")
    .eq("id", runnerId)
    .maybeSingle();
  if (error) return jsonResponse({ error: "Preflight request could not be read" }, 500);
  if (!runner || !isRecord(runner.preflight) || runner.preflight.status !== "queued" ||
      !isUuid(runner.preflight.request_id) || !isIdentifier(runner.preflight.target_id)) {
    return jsonResponse({ data: null }, 200);
  }
  const claimed = { ...runner.preflight, status: "running", started_at: new Date().toISOString() };
  const { data, error: updateError } = await client
    .from("diagnostic_runners")
    .update({ preflight: claimed, updated_at: new Date().toISOString() })
    .eq("id", runnerId)
    .filter("preflight->>request_id", "eq", runner.preflight.request_id)
    .filter("preflight->>status", "eq", "queued")
    .select("id,preflight")
    .maybeSingle();
  if (updateError) return jsonResponse({ error: "Preflight request could not be claimed" }, 500);
  if (!data) return jsonResponse({ data: null }, 200);
  return jsonResponse({ data: { runner_id: data.id, request_id: claimed.request_id, target_id: claimed.target_id } }, 200);
}

async function finishPreflight(
  client: ReturnType<typeof createClient>,
  runnerId: string,
  requestId: string,
  completed: boolean,
  payload: Record<string, unknown>,
) {
  const { data: runner, error } = await client.from("diagnostic_runners").select("preflight,capabilities").eq("id", runnerId).maybeSingle();
  if (error) return jsonResponse({ error: "Preflight state could not be read" }, 500);
  if (!runner || !isRecord(runner.preflight) || runner.preflight.request_id !== requestId || runner.preflight.status !== "running") {
    return jsonResponse({ error: "Running preflight was not found" }, 409);
  }
  const capabilities = validateCapabilities(runner.capabilities);
  if (!capabilities.ok) return jsonResponse({ error: "Runner capabilities are invalid" }, 409);
  const target = capabilities.value.targets.find((item) => item.id === runner.preflight.target_id);
  if (!target) return jsonResponse({ error: "Target is no longer authorized" }, 409);

  let state: Record<string, unknown>;
  if (completed) {
    if (payload.target_id !== target.id) return jsonResponse({ error: "Preflight target mismatch" }, 400);
    const context = validateDiagnosticContext(payload, target);
    if (!context.ok) return jsonResponse({ error: context.error }, 400);
    state = {
      ...runner.preflight,
      status: "completed",
      completed_at: new Date().toISOString(),
      network_context: context.value.network_context,
      route_context: context.value.route_context,
      checks: context.value.preflight,
    };
  } else {
    if (typeof payload.error_code !== "string" || !SAFE_ERROR_CODES.has(payload.error_code)) return jsonResponse({ error: "Safe error_code is required" }, 400);
    state = { ...runner.preflight, status: "failed", completed_at: new Date().toISOString(), error_code: payload.error_code };
  }
  const { data, error: updateError } = await client
    .from("diagnostic_runners")
    .update({ preflight: state, updated_at: new Date().toISOString() })
    .eq("id", runnerId)
    .filter("preflight->>request_id", "eq", requestId)
    .select("preflight")
    .maybeSingle();
  if (updateError) return jsonResponse({ error: "Preflight result could not be stored" }, 500);
  return jsonResponse({ data: data?.preflight ?? null }, data ? 200 : 409);
}

async function updateJobContext(
  client: ReturnType<typeof createClient>,
  runnerId: string,
  jobId: string,
  payload: Record<string, unknown>,
) {
  const { data: job, error } = await client
    .from("diagnostic_jobs")
    .select("target_id,target_host,iperf_port,environment")
    .eq("id", jobId)
    .eq("runner_id", runnerId)
    .eq("status", "running")
    .maybeSingle();
  if (error) return jsonResponse({ error: "Running job context could not be checked" }, 500);
  if (!job) return jsonResponse({ error: "Running job was not found" }, 409);
  const target: RunnerTarget = { id: job.target_id, label: job.target_id, host: job.target_host, iperf_port: job.iperf_port, environment: job.environment };
  const context = validateDiagnosticContext(payload, target);
  if (!context.ok) return jsonResponse({ error: context.error }, 400);
  const connection = context.value.network_context.connection_type;
  if (!isConnectionType(connection)) return jsonResponse({ error: "Actual target route is not WiFi or Ethernet" }, 409);
  if (context.value.preflight.iperf.ready !== true) return jsonResponse({ error: "iperf3 server is unavailable" }, 409);
  const { data, error: updateError } = await client
    .from("diagnostic_jobs")
    .update({
      connection_type: connection,
      network_context: context.value.network_context,
      route_context: context.value.route_context,
      preflight_context: context.value.preflight,
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId)
    .eq("runner_id", runnerId)
    .eq("status", "running")
    .select("id,connection_type,network_context,route_context,preflight_context")
    .maybeSingle();
  if (updateError) return jsonResponse({ error: "Job network context could not be stored" }, 500);
  return jsonResponse({ data }, data ? 200 : 409);
}

async function updateProgress(
  client: ReturnType<typeof createClient>,
  runnerId: string,
  jobId: string,
  payload: Record<string, unknown>,
) {
  if (typeof payload.stage !== "string" || !RUNNING_STAGES.has(payload.stage as JobStage)) {
    return jsonResponse({ error: "Job stage is invalid" }, 400);
  }
  const progress = validateProgress(payload.progress);
  if (!progress.ok) return jsonResponse({ error: progress.error }, 400);

  const { data, error } = await client
    .from("diagnostic_jobs")
    .update({ stage: payload.stage, progress: progress.value, updated_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("runner_id", runnerId)
    .eq("status", "running")
    .select("id, status, stage, progress, updated_at")
    .maybeSingle();
  if (error) {
    console.error("job progress update failed", error.message);
    return jsonResponse({ error: "Job progress could not be stored" }, 500);
  }
  if (!data) return jsonResponse({ error: "Running job was not found" }, 409);
  return jsonResponse({ data }, 200);
}

async function finishJob(
  client: ReturnType<typeof createClient>,
  runnerId: string,
  jobId: string,
  completed: boolean,
  payload: Record<string, unknown>,
) {
  let errorCode: string | null = null;
  let errorMessage: string | null = null;
  if (!completed) {
    if (typeof payload.error_code !== "string" || !SAFE_ERROR_CODES.has(payload.error_code)) {
      return jsonResponse({ error: "Safe error_code is required" }, 400);
    }
    if (!isSafeErrorMessage(payload.error_message)) {
      return jsonResponse({ error: "Safe error_message is required" }, 400);
    }
    errorCode = payload.error_code;
    errorMessage = payload.error_message;
  }
  const now = new Date().toISOString();
  const { data, error } = await client
    .from("diagnostic_jobs")
    .update({
      status: completed ? "completed" : "failed",
      stage: completed ? "complete" : "failed",
      progress: {},
      error_code: errorCode,
      error_message: errorMessage,
      completed_at: now,
      updated_at: now,
    })
    .eq("id", jobId)
    .eq("runner_id", runnerId)
    .eq("status", "running")
    .select("id, status, stage, error_code, error_message, completed_at")
    .maybeSingle();
  if (error) {
    console.error("job completion update failed", error.message);
    return jsonResponse({ error: "Job completion could not be stored" }, 500);
  }
  if (!data) return jsonResponse({ error: "Running job was not found" }, 409);
  return jsonResponse({ data }, 200);
}

function validateCapabilities(value: unknown): { ok: true; value: RunnerCapabilities } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "Runner capabilities must be an object" };
  if (!Array.isArray(value.source_locations) || value.source_locations.length > 50) {
    return { ok: false, error: "Runner source_locations are invalid" };
  }
  const sources = value.source_locations.filter(isLabel);
  if (sources.length !== value.source_locations.length || new Set(sources).size !== sources.length) {
    return { ok: false, error: "Runner source_locations must be unique labels" };
  }
  if (!Array.isArray(value.durations) || value.durations.length < 1 || value.durations.length > 10) {
    return { ok: false, error: "Runner durations are invalid" };
  }
  const durations = value.durations.filter(isDuration);
  if (durations.length !== value.durations.length || new Set(durations).size !== durations.length) {
    return { ok: false, error: "Runner durations must be unique values" };
  }
  if (
    !Array.isArray(value.traffic_durations_seconds) ||
    value.traffic_durations_seconds.length < 1 ||
    value.traffic_durations_seconds.length > 4
  ) {
    return { ok: false, error: "Runner Traffic durations are invalid" };
  }
  const trafficDurations = value.traffic_durations_seconds.filter(isTrafficDuration);
  if (
    trafficDurations.length !== value.traffic_durations_seconds.length ||
    new Set(trafficDurations).size !== trafficDurations.length
  ) {
    return { ok: false, error: "Runner Traffic durations must be unique allow-listed values" };
  }
  if (
    !Array.isArray(value.operations) ||
    value.operations.length !== 4 ||
    !value.operations.includes("bandwidth_and_path") ||
    !value.operations.includes("traffic_live") ||
    !value.operations.includes("network_discovery") ||
    !value.operations.includes("device_inspect")
  ) {
    return { ok: false, error: "Runner operations are invalid" };
  }
  if (!Array.isArray(value.targets) || value.targets.length > 50) {
    return { ok: false, error: "Runner targets are invalid" };
  }
  const targets: RunnerTarget[] = [];
  for (const target of value.targets) {
    if (
      !isRecord(target) ||
      !isIdentifier(target.id) ||
      !isLabel(target.label) ||
      !isTargetHost(target.host) ||
      !isPort(target.iperf_port) ||
      !isEnvironment(target.environment)
    ) {
      return { ok: false, error: "Runner target is invalid" };
    }
    targets.push({
      id: target.id,
      label: target.label,
      host: target.host,
      iperf_port: target.iperf_port,
      environment: target.environment,
    });
  }
  if (new Set(targets.map((target) => target.id)).size !== targets.length) {
    return { ok: false, error: "Runner target IDs must be unique" };
  }
  const deviceInspector = validateDeviceInspectorCapability(value.device_inspector);
  if (!deviceInspector.ok) return deviceInspector;
  return {
    ok: true,
    value: {
      source_locations: sources,
      targets,
      durations,
      traffic_durations_seconds: trafficDurations,
      operations: ["bandwidth_and_path", "traffic_live", "network_discovery", "device_inspect"],
      ...(deviceInspector.value ? { device_inspector: deviceInspector.value } : {}),
    },
  };
}

function validateDeviceInspectorCapability(value: unknown):
  | { ok: true; value: RunnerCapabilities["device_inspector"] | undefined }
  | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: undefined };
  if (!isRecord(value) || value.schema_version !== 1 || value.available !== true ||
      value.probe_engine !== "python_socket" || typeof value.python_version !== "string" ||
      value.python_version.length > 32) return { ok: false, error: "Device Inspector capability is invalid" };
  const booleanMap = (item: unknown): item is Record<string, boolean> =>
    isRecord(item) && Object.keys(item).length <= 16 && Object.values(item).every((entry) => typeof entry === "boolean");
  if (!booleanMap(value.required) || value.required.python_socket !== true ||
      (value.collectors !== undefined && !booleanMap(value.collectors)) || !booleanMap(value.optional) ||
      !booleanMap(value.available_but_unused) || !booleanMap(value.optional_not_required)) {
    return { ok: false, error: "Device Inspector capability tool matrix is invalid" };
  }
  return { ok: true, value: {
    schema_version: 1,
    available: true,
    probe_engine: "python_socket",
    python_version: value.python_version,
    required: value.required,
    collectors: value.collectors ?? {
      tcp_connect: true,
      http_metadata: true,
      tls_metadata: Boolean(value.optional.openssl),
      upnp_unicast: true,
      netbios_node_status: true,
    },
    optional: value.optional,
    available_but_unused: value.available_but_unused,
    optional_not_required: value.optional_not_required,
  } };
}

function validateStoredPreflight(value: unknown, target: RunnerTarget):
  | { ok: true; value: DiagnosticContext }
  | { ok: false; error: string; code: string } {
  if (!isRecord(value) || value.status !== "completed" || value.target_id !== target.id ||
      typeof value.completed_at !== "string" || Date.now() - Date.parse(value.completed_at) > PREFLIGHT_FRESHNESS_MS) {
    return { ok: false, error: "Run target preflight before starting the diagnostic", code: "PREFLIGHT_REQUIRED" };
  }
  const checked = validateDiagnosticContext({
    network_context: value.network_context,
    route_context: value.route_context,
    preflight: value.checks,
  }, target);
  if (!checked.ok) return { ok: false, error: checked.error, code: "PREFLIGHT_INVALID" };
  if (!isConnectionType(checked.value.network_context.connection_type)) {
    return { ok: false, error: "Target route is not using a detected WiFi or Ethernet interface", code: "CONNECTION_UNKNOWN" };
  }
  if (!checked.value.preflight.iperf.ready) {
    return { ok: false, error: "iperf3 server is unavailable on the authorized target", code: "IPERF3_SERVER_UNAVAILABLE" };
  }
  return { ok: true, value: checked.value };
}

function validateDiagnosticContext(value: Record<string, unknown>, target: RunnerTarget):
  | { ok: true; value: DiagnosticContext }
  | { ok: false; error: string } {
  if (!isRecord(value.network_context) || !isRecord(value.route_context) || !isRecord(value.preflight)) {
    return { ok: false, error: "Diagnostic context must contain structured network, route, and preflight data" };
  }
  if (JSON.stringify({ network_context: value.network_context, route_context: value.route_context, preflight: value.preflight }).length > 24_000) {
    return { ok: false, error: "Diagnostic context is too large" };
  }
  const network = value.network_context;
  const route = value.route_context;
  const checks = value.preflight;
  if (!isShortText(network.host_name, 128) || !isShortText(network.interface_alias, 256) ||
      !isShortText(network.interface_description, 512) || !["wifi", "ethernet", "unknown"].includes(String(network.connection_type)) ||
      network.operational_status !== "up" || !isIpv4(network.local_ipv4) || !isIntegerBetween(network.prefix_length, 0, 32) ||
      !isIpv4(network.subnet_mask) || !isCidr(network.subnet_cidr) || !optionalIpv4(network.default_gateway) ||
      !Array.isArray(network.dns_servers) || network.dns_servers.length > 6 || !network.dns_servers.every((item) => typeof item === "string" && item.length <= 64) ||
      !optionalNumberBetween(network.link_speed_mbps, 0, 1_000_000) || !optionalShortText(network.ssid, 128) ||
      !optionalNumberBetween(network.wifi_signal_percent, 0, 100) || !optionalNumberBetween(network.wifi_receive_rate_mbps, 0, 1_000_000) ||
      !optionalNumberBetween(network.wifi_transmit_rate_mbps, 0, 1_000_000)) {
    return { ok: false, error: "Windows network context is invalid" };
  }
  if (route.target_id !== target.id || route.target_host !== target.host || !isIpv4(route.resolved_target_ip) ||
      !isIpv4(route.source_ip) || !["on_link", "routed"].includes(String(route.route_type)) ||
      !isShortText(route.interface_alias, 256) || !isIntegerBetween(route.interface_index, 1, 1_000_000) ||
      !optionalIpv4(route.next_hop) || !isIntegerBetween(route.route_metric, 0, 1_000_000) ||
      ((route.route_type === "on_link") !== (route.next_hop === null))) {
    return { ok: false, error: "Windows route context is invalid" };
  }
  if (checks.interface_detected !== true || checks.route_resolved !== true || !isTimestamp(checks.checked_at) ||
      !validPing(checks.gateway, true) || !validPing(checks.target, false) || !isRecord(checks.iperf) ||
      typeof checks.iperf.ready !== "boolean" || checks.iperf.port !== target.iperf_port ||
      (checks.iperf.managed_demo !== undefined && typeof checks.iperf.managed_demo !== "boolean")) {
    return { ok: false, error: "Target preflight context is invalid" };
  }
  return { ok: true, value: {
    network_context: network as NetworkContext,
    route_context: route,
    preflight: checks as PreflightContext,
  } };
}

function validateProgress(value: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "progress must be an object" };
  const serialized = JSON.stringify(value);
  if (serialized.length > 32_000) return { ok: false, error: "progress payload is too large" };
  const numericFields = [
    "elapsed_seconds",
    "duration_seconds",
    "current_mbps",
    "average_mbps",
    "peak_mbps",
    "minimum_mbps",
    "transferred_mb",
    "retransmits",
    "progress_percent",
  ];
  for (const field of numericFields) {
    if (value[field] !== undefined && !isNonNegativeNumber(value[field])) {
      return { ok: false, error: `${field} must be non-negative` };
    }
  }
  if (typeof value.progress_percent === "number" && value.progress_percent > 100) {
    return { ok: false, error: "progress_percent must be at most 100" };
  }
  if (value.direction !== undefined && value.direction !== "upload" && value.direction !== "download") {
    return { ok: false, error: "progress direction is invalid" };
  }
  if (value.live_samples !== undefined) {
    if (!Array.isArray(value.live_samples) || value.live_samples.length > 60) {
      return { ok: false, error: "live_samples must contain at most 60 items" };
    }
    for (const sample of value.live_samples) {
      if (!isRecord(sample) || !isNonNegativeNumber(sample.second) || !isNonNegativeNumber(sample.mbps)) {
        return { ok: false, error: "live sample is invalid" };
      }
    }
  }
  return { ok: true, value };
}

async function approvedUserClient(request: Request): Promise<
  | { ok: true; client: ReturnType<typeof createClient>; serviceClient: ReturnType<typeof createClient>; userId: string; role: string }
  | { ok: false; response: Response }
> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    console.error("Missing diagnostic-jobs environment variables");
    return { ok: false, response: jsonResponse({ error: "Server configuration error" }, 500) };
  }
  const token = getBearerToken(request);
  if (!token) return { ok: false, response: jsonResponse({ error: "Unauthorized" }, 401) };
  const client = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: userData, error: userError } = await client.auth.getUser(token);
  if (userError || !userData.user) {
    return { ok: false, response: jsonResponse({ error: "Unauthorized" }, 401) };
  }
  const { data: profile, error: profileError } = await client
    .from("profiles")
    .select("status,role")
    .eq("id", userData.user.id)
    .maybeSingle<{ status: string; role: string }>();
  if (profileError) {
    console.error("approved profile check failed", profileError.message);
    return { ok: false, response: jsonResponse({ error: "Authorization could not be checked" }, 500) };
  }
  if (profile?.status !== "approved") {
    return { ok: false, response: jsonResponse({ error: "Forbidden" }, 403) };
  }
  return {
    ok: true,
    client,
    serviceClient: createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    }),
    userId: userData.user.id,
    role: profile.role,
  };
}

function serviceRoleClient(request: Request):
  | { ok: true; client: ReturnType<typeof createClient> }
  | { ok: false; response: Response } {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const token = getBearerToken(request);
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("Missing service-role environment variables");
    return { ok: false, response: jsonResponse({ error: "Server configuration error" }, 500) };
  }
  if (!token || !isVerifiedServiceRoleJwt(token, supabaseUrl)) {
    return { ok: false, response: jsonResponse({ error: "Forbidden" }, 403) };
  }
  return {
    ok: true,
    client: createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    }),
  };
}

function getBearerToken(request: Request): string | undefined {
  return request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
}

function isVerifiedServiceRoleJwt(token: string, supabaseUrl: string): boolean {
  const claims = decodeJwtPayload(token);
  if (!claims || claims.role !== "service_role") return false;
  try {
    return claims.ref === new URL(supabaseUrl).hostname.split(".")[0];
  } catch {
    return false;
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), "=");
    const decoded = JSON.parse(atob(padded));
    return isRecord(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value);
}

function isLabel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200 && !/[\r\n]/.test(value);
}

function isTargetHost(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 253 && !/[\r\n]/.test(value);
}

function isConnectionType(value: unknown): value is ConnectionType {
  return value === "wifi" || value === "ethernet";
}

function isEnvironment(value: unknown): value is Environment {
  return value === "lan" || value === "localhost_demo";
}

function isDuration(value: unknown): value is number {
  return Number.isSafeInteger(value) && [5, 10].includes(Number(value));
}

function isTrafficDuration(value: unknown): value is number {
  return Number.isSafeInteger(value) && [300, 600, 900, 1800].includes(Number(value));
}

function isPort(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 65535;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isSafeErrorMessage(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 300 && !/[\r\n]/.test(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isShortText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\r\n]/.test(value);
}
function optionalShortText(value: unknown, max: number): boolean {
  return value === undefined || value === null || isShortText(value, max);
}
function isIntegerBetween(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
}
function optionalNumberBetween(value: unknown, min: number, max: number): boolean {
  return value === undefined || value === null || (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max);
}
function isIpv4(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return false;
  return value.split(".").every((part) => Number(part) >= 0 && Number(part) <= 255);
}
function optionalIpv4(value: unknown): boolean { return value === undefined || value === null || isIpv4(value); }
function isCidr(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const [address, prefix, extra] = value.split("/");
  return extra === undefined && isIpv4(address) && /^\d{1,2}$/.test(prefix ?? "") && Number(prefix) <= 32;
}
function isTimestamp(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function validPing(value: unknown, nullable: boolean): boolean {
  if (nullable && value === null) return true;
  return isRecord(value) && (value.status === "responded" || value.status === "no_response") && optionalNumberBetween(value.latency_ms, 0, 60_000);
}

function jsonResponse(body: Record<string, unknown>, status: number, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}
