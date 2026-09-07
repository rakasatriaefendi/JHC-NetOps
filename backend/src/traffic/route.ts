import type { FastifyInstance } from "fastify";

import { validRunnerBearerToken } from "../runner-heartbeat/auth.js";
import { validateTrafficRequest } from "./contract.js";
import { TrafficRepositoryError, type TrafficRepository } from "./repository.js";

export const TRAFFIC_BODY_LIMIT_BYTES = 160 * 1024;
export const TRAFFIC_PERSISTENCE_TIMEOUT_MS = 10_000;

export type TrafficRouteOptions = Readonly<{
  token: string;
  repository: TrafficRepository;
  now?: () => Date;
  timeoutMs?: number;
}>;

export function registerTrafficRoute(
  server: FastifyInstance,
  options: TrafficRouteOptions,
): void {
  server.post("/api/runner/traffic", { bodyLimit: TRAFFIC_BODY_LIMIT_BYTES }, async (request, reply) => {
    if (!validRunnerBearerToken(request.headers.authorization, options.token)) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Runner authentication required" } });
    }
    const validated = validateTrafficRequest(request.body);
    if (!validated.ok) {
      return reply.code(validated.status).send({ error: { code: "INVALID_TRAFFIC_PAYLOAD", message: validated.message } });
    }
    const now = (options.now ?? (() => new Date()))();
    const signal = AbortSignal.timeout(options.timeoutMs ?? TRAFFIC_PERSISTENCE_TIMEOUT_MS);
    try {
      let data: Record<string, unknown> | null;
      const value = validated.value;
      if (value.action === "claim_session") data = await options.repository.claim(value.runner_id, now, signal);
      else if (value.action === "update_session") data = await options.repository.updateSession(value.runner_id, value.session_id, value.stage, now.toISOString(), signal);
      else if (value.action === "update_snapshot") data = await options.repository.updateSnapshot(value, now.toISOString(), signal);
      else if (value.action === "persist_flow_batch") data = await options.repository.persistFlows(value, signal);
      else data = await options.repository.finish(value, now.toISOString(), signal);
      return reply.code(200).send({ data });
    } catch (error) {
      if (error instanceof TrafficRepositoryError && error.code === "SESSION_NOT_ACTIVE") {
        return reply.code(409).send({ error: { code: "SESSION_NOT_ACTIVE", message: "Traffic session is not active" } });
      }
      request.log.error({ request_id: request.id, error_code: "TRAFFIC_PERSISTENCE_FAILED" }, "traffic request failed");
      return reply.code(500).send({ error: { code: "TRAFFIC_PERSISTENCE_FAILED", message: "Traffic request failed" } });
    }
  });
}
