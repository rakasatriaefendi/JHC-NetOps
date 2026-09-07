import type { NormalizedRunnerHeartbeat } from "./contract.js";
import { firstRow, SupabaseRestClient } from "../supabase-rest.js";

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
  readonly #client: SupabaseRestClient;

  constructor(supabaseUrl: string, serviceRoleKey: string) {
    this.#client = new SupabaseRestClient(supabaseUrl, serviceRoleKey);
  }

  async upsertHeartbeat(row: RunnerHeartbeatRow, signal: AbortSignal): Promise<StoredRunnerHeartbeat> {
    try {
      const payload = await this.#client.table<unknown>("diagnostic_runners", {
        method: "POST",
        query: { on_conflict: "id", select: "id,last_seen_at,health_status,health_error_code" },
        prefer: "resolution=merge-duplicates,return=representation",
        body: row,
        signal,
      });
      const stored = firstRow<StoredRunnerHeartbeat>(payload);
      if (!isStoredHeartbeat(stored)) {
        throw new RunnerHeartbeatPersistenceError("RUNNER_HEARTBEAT_STORE_FAILED");
      }
      return stored;
    } catch (error) {
      if (error instanceof RunnerHeartbeatPersistenceError) throw error;
      throw new RunnerHeartbeatPersistenceError("RUNNER_HEARTBEAT_STORE_FAILED");
    }
  }

  async expireStaleTrafficSessions(runnerId: string, signal: AbortSignal): Promise<void> {
    try {
      await this.#client.rpc("expire_stale_traffic_sessions", { p_runner_id: runnerId }, signal);
    } catch {
      throw new RunnerHeartbeatPersistenceError("RUNNER_HEARTBEAT_RECOVERY_FAILED");
    }
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
