import type { FastifyInstance } from "fastify";

import { validRunnerBearerToken } from "./auth.js";
import { validateRunnerHeartbeatRequest } from "./contract.js";
import {
  RunnerHeartbeatPersistenceError,
  type RunnerHeartbeatRepository,
  type RunnerHeartbeatRow,
} from "./repository.js";

export const RUNNER_HEARTBEAT_BODY_LIMIT_BYTES = 32 * 1024;
export const RUNNER_HEARTBEAT_PERSISTENCE_TIMEOUT_MS = 10_000;

export type RunnerHeartbeatRouteOptions = Readonly<{
  token: string;
  repository: RunnerHeartbeatRepository;
  now?: () => Date;
  monitoringAssignments?: (runnerId: string, signal: AbortSignal) => Promise<{ health: boolean; telemetry: boolean }>;
}>;

export function registerRunnerHeartbeatRoute(
  server: FastifyInstance,
  options: RunnerHeartbeatRouteOptions,
): void {
  server.post("/api/runner/heartbeat", { bodyLimit: RUNNER_HEARTBEAT_BODY_LIMIT_BYTES }, async (request, reply) => {
    if (!validRunnerBearerToken(request.headers.authorization, options.token)) {
      return reply.code(401).send({
        error: { code: "UNAUTHORIZED", message: "Runner authentication required" },
      });
    }

    const validated = validateRunnerHeartbeatRequest(request.body);
    if (!validated.ok) {
      return reply.code(400).send({
        error: { code: "INVALID_HEARTBEAT", message: validated.message },
      });
    }

    const timestamp = (options.now ?? (() => new Date()))().toISOString();
    const row: RunnerHeartbeatRow = {
      ...validated.value,
      last_seen_at: timestamp,
      updated_at: timestamp,
    };
    try {
      const persistenceSignal = AbortSignal.timeout(RUNNER_HEARTBEAT_PERSISTENCE_TIMEOUT_MS);
      const stored = await options.repository.upsertHeartbeat(row, persistenceSignal);
      await options.repository.expireStaleTrafficSessions(row.id, persistenceSignal);
      let assignments: { health: boolean; telemetry: boolean } | undefined;
      if (options.monitoringAssignments) {
        try {
          assignments = await options.monitoringAssignments(row.id, persistenceSignal);
        } catch {
          // Optional optimization must never turn a persisted heartbeat into
          // failure or invent an empty assignment. Runner resumes ordinary GETs.
          request.log.warn({ error_code: "MONITORING_ASSIGNMENTS_UNAVAILABLE" }, "monitoring hint unavailable");
        }
      }
      return reply.code(200).send({ data: { ...stored, ...(assignments ? { monitoring_assignments: assignments } : {}) } });
    } catch (error) {
      const code = error instanceof RunnerHeartbeatPersistenceError
        ? error.code
        : "RUNNER_HEARTBEAT_PERSISTENCE_FAILED";
      request.log.error({ request_id: request.id, error_code: code }, "runner heartbeat persistence failed");
      return reply.code(500).send({
        error: { code: "HEARTBEAT_PERSISTENCE_FAILED", message: "Runner heartbeat could not be stored" },
      });
    }
  });
}
