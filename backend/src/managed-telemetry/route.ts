import type { FastifyInstance } from "fastify";

import { validRunnerBearerToken } from "../runner-heartbeat/auth.js";
import { validateManagedTelemetryRequest } from "./contract.js";
import { ManagedTelemetryRepositoryError, type ManagedTelemetryRepository } from "./repository.js";

export const MANAGED_TELEMETRY_BODY_LIMIT_BYTES = 160 * 1024;
export const MANAGED_TELEMETRY_PERSISTENCE_TIMEOUT_MS = 10_000;

export type ManagedTelemetryRouteOptions = Readonly<{
  token: string;
  repository: ManagedTelemetryRepository;
  now?: () => Date;
  timeoutMs?: number;
}>;

export function registerManagedTelemetryRoute(server: FastifyInstance, options: ManagedTelemetryRouteOptions): void {
  server.post("/api/runner/managed-telemetry", { bodyLimit: MANAGED_TELEMETRY_BODY_LIMIT_BYTES }, async (request, reply) => {
    if (!validRunnerBearerToken(request.headers.authorization, options.token)) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Runner authentication required" } });
    }
    const now = (options.now ?? (() => new Date()))();
    const validated = validateManagedTelemetryRequest(request.body, now.getTime());
    if (!validated.ok) {
      return reply.code(400).send({ error: { code: "INVALID_MANAGED_TELEMETRY_PAYLOAD", message: validated.message } });
    }
    const signal = AbortSignal.timeout(options.timeoutMs ?? MANAGED_TELEMETRY_PERSISTENCE_TIMEOUT_MS);
    try {
      const value = validated.value;
      const data = value.action === "list_targets"
        ? await options.repository.listTargets(value.runner_id, signal)
        : await options.repository.publish(value.runner_id, value.device, value.interfaces, value.transitions, value.observed_hosts, now.toISOString(), signal);
      return reply.code(200).send({ data });
    } catch (error) {
      if (error instanceof ManagedTelemetryRepositoryError && error.code === "TARGET_NOT_AUTHORIZED") {
        return reply.code(403).send({ error: { code: "TARGET_NOT_AUTHORIZED", message: "Managed telemetry target is not authorized" } });
      }
      request.log.error({ request_id: request.id, error_code: "MANAGED_TELEMETRY_PERSISTENCE_FAILED" }, "managed telemetry request failed");
      return reply.code(500).send({ error: { code: "MANAGED_TELEMETRY_PERSISTENCE_FAILED", message: "Managed telemetry request failed" } });
    }
  });
}
