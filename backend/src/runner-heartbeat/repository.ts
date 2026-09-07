import type { NormalizedRunnerHeartbeat } from "./contract.js";

export type RunnerHeartbeatRow = Readonly<{
  id: string;
  display_name: string;
  last_seen_at: string;
  health_status: "online" | "degraded";
  health_error_code: string | null;
  capabilities: NormalizedRunnerHeartbeat["capabilities"];
  updated_at: string;
}>;

export type StoredRunnerHeartbeat = Readonly<Pick<
  RunnerHeartbeatRow,
  "id" | "last_seen_at" | "health_status" | "health_error_code"
>>;

export interface RunnerHeartbeatRepository {
  upsertHeartbeat(row: RunnerHeartbeatRow, signal: AbortSignal): Promise<StoredRunnerHeartbeat>;
  expireStaleTrafficSessions(runnerId: string, signal: AbortSignal): Promise<void>;
}

export class SupabaseRunnerHeartbeatRepository implements RunnerHeartbeatRepository {
  readonly #baseUrl: string;
  readonly #headers: Readonly<Record<string, string>>;

  constructor(supabaseUrl: string, serviceRoleKey: string) {
    this.#baseUrl = supabaseUrl.replace(/\/$/, "");
    this.#headers = Object.freeze({
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      "Content-Type": "application/json",
    });
  }

  async upsertHeartbeat(row: RunnerHeartbeatRow, signal: AbortSignal): Promise<StoredRunnerHeartbeat> {
    const response = await fetch(
      `${this.#baseUrl}/rest/v1/diagnostic_runners?on_conflict=id&select=id,last_seen_at,health_status,health_error_code`,
      {
        method: "POST",
        headers: { ...this.#headers, Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify(row),
        signal,
      },
    );
    if (!response.ok) throw new RunnerHeartbeatPersistenceError("RUNNER_HEARTBEAT_STORE_FAILED");
    const payload: unknown = await response.json();
    const stored = Array.isArray(payload) ? payload[0] : payload;
    if (!isStoredHeartbeat(stored)) {
      throw new RunnerHeartbeatPersistenceError("RUNNER_HEARTBEAT_STORE_FAILED");
    }
    return stored;
  }

  async expireStaleTrafficSessions(runnerId: string, signal: AbortSignal): Promise<void> {
    const response = await fetch(`${this.#baseUrl}/rest/v1/rpc/expire_stale_traffic_sessions`, {
      method: "POST",
      headers: this.#headers,
      body: JSON.stringify({ p_runner_id: runnerId }),
      signal,
    });
    if (!response.ok) throw new RunnerHeartbeatPersistenceError("RUNNER_HEARTBEAT_RECOVERY_FAILED");
  }
}

export class RunnerHeartbeatPersistenceError extends Error {
  constructor(readonly code: "RUNNER_HEARTBEAT_STORE_FAILED" | "RUNNER_HEARTBEAT_RECOVERY_FAILED") {
    super("Runner heartbeat persistence failed");
    this.name = "RunnerHeartbeatPersistenceError";
  }
}

function isStoredHeartbeat(value: unknown): value is StoredRunnerHeartbeat {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && typeof row.last_seen_at === "string" &&
    (row.health_status === "online" || row.health_status === "degraded") &&
    (row.health_error_code === null || typeof row.health_error_code === "string");
}
