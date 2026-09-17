import { createClient } from "@supabase/supabase-js";
import { legacyApplicationMutationBlocked, legacyApplicationMutationBlockedResponse } from "../_shared/persistence-authority.ts";

type MetricsPayload = {
  recorded_at: string;
  interval_seconds: number;
  bytes_in: number;
  bytes_out: number;
  packet_count: number;
  avg_latency_ms: number | null;
  packet_loss_pct: number;
  gateway_reachable: boolean;
  dns_reachable: boolean;
  protocol_breakdown: Record<string, number>;
};

type NetworkStatus = "normal" | "down" | "not_internet";

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, {
      Allow: "POST",
    });
  }
  if (legacyApplicationMutationBlocked()) return legacyApplicationMutationBlockedResponse();

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    console.error("Missing Supabase function environment variables");
    return jsonResponse({ error: "Server configuration error" }, 500);
  }

  const bearerToken = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!bearerToken || !constantTimeEqual(bearerToken, serviceRoleKey)) {
    return jsonResponse({ error: "Forbidden" }, 403);
  }

  let rawPayload: unknown;
  try {
    rawPayload = await request.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON" }, 400);
  }

  const validation = validateMetrics(rawPayload);
  if (!validation.ok) {
    return jsonResponse({ error: validation.error }, 400);
  }

  const metrics = validation.value;
  const status = classifyConnectivity(metrics);
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase
    .from("traffic_metrics")
    .insert({ ...metrics, status })
    .select("id, recorded_at, status")
    .single();

  if (error) {
    console.error("traffic_metrics insert failed", error.message);
    return jsonResponse({ error: "Metrics could not be stored" }, 500);
  }

  return jsonResponse({ data }, 201);
});

function classifyConnectivity(metrics: MetricsPayload): NetworkStatus {
  if (!metrics.gateway_reachable) {
    return "down";
  }
  if (!metrics.dns_reachable) {
    return "not_internet";
  }
  return "normal";
}

function validateMetrics(
  value: unknown,
): { ok: true; value: MetricsPayload } | { ok: false; error: string } {
  if (!isRecord(value)) {
    return { ok: false, error: "Payload must be a JSON object" };
  }

  if (
    typeof value.recorded_at !== "string" ||
    Number.isNaN(Date.parse(value.recorded_at))
  ) {
    return { ok: false, error: "recorded_at must be a valid timestamp" };
  }

  for (const field of ["interval_seconds", "bytes_in", "bytes_out", "packet_count"] as const) {
    if (!isNonNegativeInteger(value[field])) {
      return { ok: false, error: `${field} must be a non-negative integer` };
    }
  }
  if (value.interval_seconds < 1 || value.interval_seconds > 3600) {
    return { ok: false, error: "interval_seconds must be between 1 and 3600" };
  }

  if (
    value.avg_latency_ms !== null &&
    !isNonNegativeNumber(value.avg_latency_ms)
  ) {
    return { ok: false, error: "avg_latency_ms must be null or non-negative" };
  }
  if (
    !isNonNegativeNumber(value.packet_loss_pct) ||
    value.packet_loss_pct > 100
  ) {
    return { ok: false, error: "packet_loss_pct must be between 0 and 100" };
  }
  if (
    typeof value.gateway_reachable !== "boolean" ||
    typeof value.dns_reachable !== "boolean"
  ) {
    return { ok: false, error: "Reachability fields must be boolean" };
  }
  if (!isRecord(value.protocol_breakdown)) {
    return { ok: false, error: "protocol_breakdown must be a JSON object" };
  }
  for (const protocolValue of Object.values(value.protocol_breakdown)) {
    if (!isNonNegativeInteger(protocolValue)) {
      return {
        ok: false,
        error: "protocol_breakdown values must be non-negative integers",
      };
    }
  }

  return { ok: true, value: value as MetricsPayload };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function jsonResponse(
  body: Record<string, unknown>,
  status: number,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}
