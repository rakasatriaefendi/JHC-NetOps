import { createClient } from "@supabase/supabase-js";
import { legacyApplicationMutationBlocked, legacyApplicationMutationBlockedResponse } from "../_shared/persistence-authority.ts";

type ConnectionType = "wifi" | "ethernet";
type Direction = "upload" | "download";
type DiagnosticEnvironment = "lan" | "localhost_demo";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

type BandwidthMeasurement = {
  source_label: string;
  target_label: string;
  target_host: string;
  connection_type: ConnectionType;
  bitrate_mbps: number;
  jitter_ms: number | null;
  measured_at: string;
  job_id: string | null;
  direction: Direction | null;
  environment: DiagnosticEnvironment | null;
  peak_mbps: number | null;
  minimum_mbps: number | null;
  transferred_mb: number | null;
  retransmits: number | null;
  duration_seconds: number | null;
};

type HopMeasurement = {
  session_id: string;
  source_label: string;
  target_label: string;
  target_host: string;
  connection_type: ConnectionType;
  hop_number: number;
  hop_ip: string | null;
  avg_latency_ms: number | null;
  loss_percent: number;
  measured_at: string;
  job_id: string | null;
  environment: DiagnosticEnvironment | null;
};

type StoredBandwidthMeasurement = Omit<
  BandwidthMeasurement,
  "target_host" | "connection_type"
> & {
  id: string;
  target_host: string | null;
  connection_type: ConnectionType | null;
};

type StoredHopMeasurement = Omit<
  HopMeasurement,
  "source_label" | "target_label" | "target_host" | "connection_type"
> & {
  id: string;
  source_label: string | null;
  target_label: string | null;
  target_host: string | null;
  connection_type: ConnectionType | null;
};

type StoredDiagnosticJob = {
  id: string;
  source_label: string;
  target_label: string;
  target_host: string;
  connection_type: ConnectionType;
  environment: DiagnosticEnvironment;
  duration_seconds: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

type HistoryQuery = {
  from: string;
  to: string;
  source: string;
  target: string;
  connectionType: "all" | ConnectionType;
  includeDevelopment: boolean;
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method === "GET") {
    return readDiagnostics(request);
  }
  if (request.method === "POST") {
    if (legacyApplicationMutationBlocked()) return legacyApplicationMutationBlockedResponse(CORS_HEADERS);
    return storeDiagnostics(request);
  }

  return jsonResponse({ error: "Method not allowed" }, 405, {
    Allow: "GET, POST",
  });
});

async function readDiagnostics(request: Request): Promise<Response> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !anonKey) {
    console.error("Missing Supabase read environment variables");
    return jsonResponse({ error: "Server configuration error" }, 500);
  }

  const bearerToken = getBearerToken(request);
  if (!bearerToken) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const supabase = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${bearerToken}` } },
  });
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser(bearerToken);
  if (userError || !user) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("status")
    .eq("id", user.id)
    .maybeSingle<{ status: string }>();
  if (profileError) {
    console.error("Approved profile check failed", profileError.message);
    return jsonResponse({ error: "Diagnostics could not be loaded" }, 500);
  }
  if (profile?.status !== "approved") {
    return jsonResponse({ error: "Forbidden" }, 403);
  }

  const requestUrl = new URL(request.url);
  if (requestUrl.searchParams.get("view") === "history") {
    return readDiagnosticHistory(supabase, requestUrl.searchParams);
  }

  const [bandwidthResult, hopResult] = await Promise.all([
    supabase
      .from("bandwidth_measurements")
      .select(
        "id, job_id, source_label, target_label, target_host, connection_type, direction, environment, bitrate_mbps, peak_mbps, minimum_mbps, transferred_mb, retransmits, duration_seconds, jitter_ms, measured_at",
      )
      .order("measured_at", { ascending: false })
      .limit(200)
      .returns<StoredBandwidthMeasurement[]>(),
    supabase
      .from("hop_measurements")
      .select(
        "id, job_id, session_id, source_label, target_label, target_host, connection_type, environment, hop_number, hop_ip, avg_latency_ms, loss_percent, measured_at",
      )
      .order("measured_at", { ascending: false })
      .order("hop_number", { ascending: true })
      .limit(512)
      .returns<StoredHopMeasurement[]>(),
  ]);

  if (bandwidthResult.error || hopResult.error) {
    console.error(
      "Diagnostics read failed",
      bandwidthResult.error?.message ?? hopResult.error?.message,
    );
    return jsonResponse({ error: "Diagnostics could not be loaded" }, 500);
  }

  return jsonResponse(
    {
      data: {
        bandwidth: bandwidthResult.data,
        hops: hopResult.data,
      },
    },
    200,
  );
}

async function readDiagnosticHistory(
  supabase: ReturnType<typeof createClient>,
  searchParams: URLSearchParams,
): Promise<Response> {
  const parsed = parseHistoryQuery(searchParams);
  if (!parsed.ok) return jsonResponse({ error: parsed.error }, 400);
  const query = parsed.value;

  let seedQuery = supabase
    .from("bandwidth_measurements")
    .select("job_id")
    .not("job_id", "is", null)
    .gte("measured_at", query.from)
    .lt("measured_at", query.to)
    .order("measured_at", { ascending: false })
    .limit(200);
  seedQuery = query.includeDevelopment
    ? seedQuery.in("environment", ["lan", "localhost_demo"])
    : seedQuery.eq("environment", "lan");
  if (query.source !== "all") seedQuery = seedQuery.eq("source_label", query.source);
  if (query.target !== "all") seedQuery = seedQuery.eq("target_label", query.target);
  if (query.connectionType !== "all") {
    seedQuery = seedQuery.eq("connection_type", query.connectionType);
  }

  const seedResult = await seedQuery.returns<{ job_id: string | null }[]>();
  if (seedResult.error) {
    console.error("Diagnostic history seed query failed", seedResult.error.message);
    return jsonResponse({ error: "Diagnostic history could not be loaded" }, 500);
  }
  const jobIds = Array.from(
    new Set(seedResult.data.flatMap((row) => row.job_id ? [row.job_id] : [])),
  ).slice(0, 100);
  if (!jobIds.length) {
    return jsonResponse({ data: { jobs: [], bandwidth: [], hops: [] } }, 200);
  }

  const [jobResult, bandwidthResult, hopResult] = await Promise.all([
    supabase
      .from("diagnostic_jobs")
      .select(
        "id, source_label, target_label, target_host, connection_type, environment, duration_seconds, network_context, route_context, preflight_context, created_at, started_at, completed_at",
      )
      .in("id", jobIds)
      .eq("status", "completed")
      .returns<StoredDiagnosticJob[]>(),
    supabase
      .from("bandwidth_measurements")
      .select(
        "id, job_id, source_label, target_label, target_host, connection_type, direction, environment, bitrate_mbps, peak_mbps, minimum_mbps, transferred_mb, retransmits, duration_seconds, jitter_ms, measured_at",
      )
      .in("job_id", jobIds)
      .order("measured_at", { ascending: true })
      .limit(200)
      .returns<StoredBandwidthMeasurement[]>(),
    supabase
      .from("hop_measurements")
      .select(
        "id, job_id, session_id, source_label, target_label, target_host, connection_type, environment, hop_number, hop_ip, avg_latency_ms, loss_percent, measured_at",
      )
      .in("job_id", jobIds)
      .order("measured_at", { ascending: true })
      .order("hop_number", { ascending: true })
      .limit(4096)
      .returns<StoredHopMeasurement[]>(),
  ]);

  if (jobResult.error || bandwidthResult.error || hopResult.error) {
    console.error(
      "Diagnostic history correlation failed",
      jobResult.error?.message ?? bandwidthResult.error?.message ?? hopResult.error?.message,
    );
    return jsonResponse({ error: "Diagnostic history could not be loaded" }, 500);
  }

  const completedJobIds = new Set(jobResult.data.map((job) => job.id));
  return jsonResponse({
    data: {
      jobs: jobResult.data,
      bandwidth: bandwidthResult.data.filter((row) => row.job_id && completedJobIds.has(row.job_id)),
      hops: hopResult.data.filter((row) => row.job_id && completedJobIds.has(row.job_id)),
    },
  }, 200);
}

function parseHistoryQuery(
  searchParams: URLSearchParams,
): { ok: true; value: HistoryQuery } | { ok: false; error: string } {
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const source = searchParams.get("source") ?? "all";
  const target = searchParams.get("target") ?? "all";
  const connectionType = searchParams.get("connection_type") ?? "all";
  const includeDevelopment = searchParams.get("include_development") === "true";
  if (!from || !to || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
    return { ok: false, error: "A valid history date range is required" };
  }
  if (Date.parse(from) >= Date.parse(to)) {
    return { ok: false, error: "History date range is invalid" };
  }
  if (!isHistoryFilter(source) || !isHistoryFilter(target)) {
    return { ok: false, error: "History source or target filter is invalid" };
  }
  if (connectionType !== "all" && !isConnectionType(connectionType)) {
    return { ok: false, error: "History connection filter is invalid" };
  }
  if (!["true", "false"].includes(searchParams.get("include_development") ?? "false")) {
    return { ok: false, error: "History environment filter is invalid" };
  }
  return {
    ok: true,
    value: { from, to, source, target, connectionType, includeDevelopment },
  };
}

function isHistoryFilter(value: string) {
  return value.length > 0 && value.length <= 200 && !/[\r\n]/.test(value);
}

async function storeDiagnostics(request: Request): Promise<Response> {

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("Missing Supabase function environment variables");
    return jsonResponse({ error: "Server configuration error" }, 500);
  }

  const bearerToken = getBearerToken(request);
  if (!bearerToken || !isVerifiedServiceRoleJwt(bearerToken, supabaseUrl)) {
    return jsonResponse({ error: "Forbidden" }, 403);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON" }, 400);
  }
  if (!isRecord(payload) || typeof payload.type !== "string") {
    return jsonResponse({ error: "Invalid diagnostics payload" }, 400);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  if (payload.type === "bandwidth") {
    const validation = validateBandwidth(payload.measurement);
    if (!validation.ok) {
      return jsonResponse({ error: validation.error }, 400);
    }

    const { data, error } = await supabase
      .from("bandwidth_measurements")
      .insert(validation.value)
      .select("id, measured_at")
      .single();
    if (error) {
      console.error("bandwidth_measurements insert failed", error.message);
      return jsonResponse({ error: "Bandwidth measurement could not be stored" }, 500);
    }
    return jsonResponse({ data }, 201);
  }

  if (payload.type === "hops") {
    const validation = validateHops(payload.measurements);
    if (!validation.ok) {
      return jsonResponse({ error: validation.error }, 400);
    }

    const { data, error } = await supabase
      .from("hop_measurements")
      .insert(validation.value)
      .select("id, session_id, hop_number, measured_at");
    if (error) {
      console.error("hop_measurements insert failed", error.message);
      return jsonResponse({ error: "Hop measurements could not be stored" }, 500);
    }
    return jsonResponse({ data }, 201);
  }

  return jsonResponse({ error: "Unsupported diagnostics type" }, 400);
}

function getBearerToken(request: Request): string | undefined {
  return request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
}

function validateBandwidth(
  value: unknown,
): { ok: true; value: BandwidthMeasurement } | { ok: false; error: string } {
  if (!isRecord(value)) {
    return { ok: false, error: "measurement must be an object" };
  }
  if (!isLabel(value.source_label) || !isLabel(value.target_label)) {
    return { ok: false, error: "source_label and target_label are required" };
  }
  if (!isTargetHost(value.target_host)) {
    return { ok: false, error: "target_host is required" };
  }
  if (!isConnectionType(value.connection_type)) {
    return { ok: false, error: "connection_type must be wifi or ethernet" };
  }
  if (!isNonNegativeNumber(value.bitrate_mbps)) {
    return { ok: false, error: "bitrate_mbps must be non-negative" };
  }
  if (value.jitter_ms !== null && !isNonNegativeNumber(value.jitter_ms)) {
    return { ok: false, error: "jitter_ms must be null or non-negative" };
  }
  if (!isTimestamp(value.measured_at)) {
    return { ok: false, error: "measured_at must be a valid timestamp" };
  }
  if (!isOptionalUuid(value.job_id)) {
    return { ok: false, error: "job_id must be null or a UUID" };
  }
  if (!isOptionalDirection(value.direction)) {
    return { ok: false, error: "direction must be null, upload, or download" };
  }
  if (!isOptionalEnvironment(value.environment)) {
    return { ok: false, error: "environment must be null, lan, or localhost_demo" };
  }
  for (const field of ["peak_mbps", "minimum_mbps", "transferred_mb", "duration_seconds"] as const) {
    if (value[field] !== null && !isPositiveOrZero(value[field], field === "duration_seconds")) {
      return { ok: false, error: `${field} has an invalid value` };
    }
  }
  if (
    value.retransmits !== null &&
    (!Number.isSafeInteger(value.retransmits) || Number(value.retransmits) < 0)
  ) {
    return { ok: false, error: "retransmits must be null or a non-negative integer" };
  }
  if (value.job_id !== null && (value.direction === null || value.environment === null)) {
    return { ok: false, error: "Job measurements require direction and environment" };
  }
  return {
    ok: true,
    value: {
      source_label: value.source_label,
      target_label: value.target_label,
      target_host: value.target_host,
      connection_type: value.connection_type,
      bitrate_mbps: value.bitrate_mbps,
      jitter_ms: value.jitter_ms,
      measured_at: value.measured_at,
      job_id: value.job_id,
      direction: value.direction,
      environment: value.environment,
      peak_mbps: value.peak_mbps,
      minimum_mbps: value.minimum_mbps,
      transferred_mb: value.transferred_mb,
      retransmits: value.retransmits,
      duration_seconds: value.duration_seconds,
    },
  };
}

function validateHops(
  value: unknown,
): { ok: true; value: HopMeasurement[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256) {
    return { ok: false, error: "measurements must contain 1-256 hops" };
  }

  const sessionIds = new Set<string>();
  const sessionContexts = new Set<string>();
  const normalized: HopMeasurement[] = [];
  for (const hop of value) {
    if (!isRecord(hop)) {
      return { ok: false, error: "Each hop must be an object" };
    }
    if (typeof hop.session_id !== "string" || !isUuid(hop.session_id)) {
      return { ok: false, error: "session_id must be a UUID" };
    }
    sessionIds.add(hop.session_id);
    if (!isLabel(hop.source_label) || !isLabel(hop.target_label)) {
      return { ok: false, error: "source_label and target_label are required" };
    }
    if (!isTargetHost(hop.target_host)) {
      return { ok: false, error: "target_host is required" };
    }
    if (!isConnectionType(hop.connection_type)) {
      return { ok: false, error: "connection_type must be wifi or ethernet" };
    }
    if (
      typeof hop.hop_number !== "number" ||
      !Number.isSafeInteger(hop.hop_number) ||
      hop.hop_number <= 0
    ) {
      return { ok: false, error: "hop_number must be a positive integer" };
    }
    if (hop.hop_ip !== null && !isIpAddress(hop.hop_ip)) {
      return { ok: false, error: "hop_ip must be null or an IP string" };
    }
    if (hop.avg_latency_ms !== null && !isNonNegativeNumber(hop.avg_latency_ms)) {
      return { ok: false, error: "avg_latency_ms must be null or non-negative" };
    }
    if (!isNonNegativeNumber(hop.loss_percent) || hop.loss_percent > 100) {
      return { ok: false, error: "loss_percent must be between 0 and 100" };
    }
    if (!isTimestamp(hop.measured_at)) {
      return { ok: false, error: "measured_at must be a valid timestamp" };
    }
    if (!isOptionalUuid(hop.job_id)) {
      return { ok: false, error: "job_id must be null or a UUID" };
    }
    if (!isOptionalEnvironment(hop.environment)) {
      return { ok: false, error: "environment must be null, lan, or localhost_demo" };
    }
    if (hop.job_id !== null && hop.environment === null) {
      return { ok: false, error: "Job hop measurements require environment" };
    }
    sessionContexts.add(
      [
        hop.source_label,
        hop.target_label,
        hop.target_host,
        hop.connection_type,
        hop.measured_at,
        hop.job_id,
        hop.environment,
      ].join("\u0000"),
    );
    normalized.push({
      session_id: hop.session_id,
      source_label: hop.source_label,
      target_label: hop.target_label,
      target_host: hop.target_host,
      connection_type: hop.connection_type,
      hop_number: hop.hop_number,
      hop_ip: hop.hop_ip,
      avg_latency_ms: hop.avg_latency_ms,
      loss_percent: hop.loss_percent,
      measured_at: hop.measured_at,
      job_id: hop.job_id,
      environment: hop.environment,
    });
  }

  if (sessionIds.size !== 1) {
    return { ok: false, error: "All hops must belong to one session_id" };
  }
  if (sessionContexts.size !== 1) {
    return { ok: false, error: "All hops must share one measurement context" };
  }
  return { ok: true, value: normalized };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLabel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200;
}

function isTargetHost(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 253;
}

function isConnectionType(value: unknown): value is ConnectionType {
  return value === "wifi" || value === "ethernet";
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPositiveOrZero(value: unknown, strictlyPositive: boolean): value is number {
  return isNonNegativeNumber(value) && (!strictlyPositive || value > 0);
}

function isOptionalUuid(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && isUuid(value));
}

function isOptionalDirection(value: unknown): value is Direction | null {
  return value === null || value === "upload" || value === "download";
}

function isOptionalEnvironment(value: unknown): value is DiagnosticEnvironment | null {
  return value === null || value === "lan" || value === "localhost_demo";
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function isIpAddress(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  if (value.includes(":")) {
    if (!/^[0-9a-f:]+$/i.test(value)) {
      return false;
    }
    try {
      return new URL(`http://[${value}]`).hostname.length > 0;
    } catch {
      return false;
    }
  }
  const octets = value.split(".");
  return (
    octets.length === 4 &&
    octets.every(
      (octet) => /^\d{1,3}$/.test(octet) && Number(octet) >= 0 && Number(octet) <= 255,
    )
  );
}

function isVerifiedServiceRoleJwt(token: string, supabaseUrl: string): boolean {
  // config.toml keeps verify_jwt enabled, so the Supabase gateway validates the
  // signature and expiry before this handler runs. Claims are used only for
  // authorization, avoiding a brittle exact comparison after key rotation.
  const claims = decodeJwtPayload(token);
  if (!claims || claims.role !== "service_role") {
    return false;
  }

  try {
    const expectedProjectRef = new URL(supabaseUrl).hostname.split(".")[0];
    return claims.ref === expectedProjectRef;
  } catch {
    return false;
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "=",
    );
    const decoded = JSON.parse(atob(padded));
    return isRecord(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function jsonResponse(
  body: Record<string, unknown>,
  status: number,
  headers: Record<string, string> = {},
) {
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
