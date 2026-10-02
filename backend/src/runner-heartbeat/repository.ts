import type { NormalizedRunnerHeartbeat } from "./contract.js";

export type RunnerHeartbeatRow = Readonly<{ id: string; display_name: string; last_seen_at: string; health_status: "online" | "degraded"; health_error_code: string | null; capabilities: NormalizedRunnerHeartbeat["capabilities"]; updated_at: string }>;
export type StoredRunnerHeartbeat = Readonly<Pick<RunnerHeartbeatRow, "id" | "last_seen_at" | "health_status" | "health_error_code">>;
export interface RunnerHeartbeatRepository {
  upsertHeartbeat(row: RunnerHeartbeatRow, signal: AbortSignal): Promise<StoredRunnerHeartbeat>;
  expireStaleTrafficSessions(runnerId: string, signal: AbortSignal): Promise<void>;
}
export class RunnerHeartbeatPersistenceError extends Error {
  constructor(readonly code: "RUNNER_HEARTBEAT_STORE_FAILED" | "RUNNER_HEARTBEAT_RECOVERY_FAILED") { super("Runner heartbeat persistence failed"); this.name = "RunnerHeartbeatPersistenceError"; }
}
