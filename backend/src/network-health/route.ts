import type { FastifyInstance } from "fastify";

import { validRunnerBearerToken } from "../runner-heartbeat/auth.js";
import { validateNetworkHealthRequest } from "./contract.js";
import { NetworkHealthRepositoryError, type NetworkHealthRepository } from "./repository.js";

export const NETWORK_HEALTH_BODY_LIMIT_BYTES = 128 * 1024;
export const NETWORK_HEALTH_PERSISTENCE_TIMEOUT_MS = 10_000;

export type NetworkHealthRouteOptions = Readonly<{
  token: string;
  repository: NetworkHealthRepository;
  now?: () => Date;
  timeoutMs?: number;
}>;

export function registerNetworkHealthRoute(
  server: FastifyInstance,
  options: NetworkHealthRouteOptions,
): void {
  server.post("/api/runner/network-health", { bodyLimit: NETWORK_HEALTH_BODY_LIMIT_BYTES }, async (request, reply) => {
    if (!validRunnerBearerToken(request.headers.authorization, options.token)) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Runner authentication required" } });
    }
    const now = (options.now ?? (() => new Date()))();
    const validated = validateNetworkHealthRequest(request.body, now.getTime());
    if (!validated.ok) {
      return reply.code(400).send({ error: { code: "INVALID_NETWORK_HEALTH_PAYLOAD", message: validated.message } });
    }
    const signal = AbortSignal.timeout(options.timeoutMs ?? NETWORK_HEALTH_PERSISTENCE_TIMEOUT_MS);
    try {
      const value = validated.value;
      let data;
      if (value.action === "list_targets") {
        data = await options.repository.listTargets(value.runner_id, signal);
      } else if (value.action === "publish") {
        data = await options.repository.publish(value.runner_id, value.states, value.transitions, now.toISOString(), signal);
      } else if (value.action === "claim_manual_ping") {
        data = await options.repository.claimManualPing(value.runner_id, signal);
      } else if (value.action === "complete_manual_ping") {
        data = await options.repository.completeManualPing(value.ping_id, value.runner_id, now.toISOString(), value.result, signal);
        if (!data) return reply.code(409).send({ error: { code: "MANUAL_PING_NOT_CLAIMED", message: "Manual ping job not claimed or already terminal" } });
      } else if (value.action === "fail_manual_ping") {
        data = await options.repository.failManualPing(value.ping_id, value.runner_id, now.toISOString(), value.error_code, signal);
        if (!data) return reply.code(409).send({ error: { code: "MANUAL_PING_NOT_CLAIMED", message: "Manual ping job not claimed or already terminal" } });
      }
      return reply.code(200).send({ data });
    } catch (error) {
      if (error instanceof NetworkHealthRepositoryError && error.code === "TARGET_NOT_AUTHORIZED") {
        return reply.code(403).send({ error: { code: "TARGET_NOT_AUTHORIZED", message: "Health target is not authorized" } });
      }
      request.log.error({ request_id: request.id, error_code: "NETWORK_HEALTH_PERSISTENCE_FAILED" }, "network health request failed");
      return reply.code(500).send({ error: { code: "NETWORK_HEALTH_PERSISTENCE_FAILED", message: "Network health request failed" } });
    }
  });
}
