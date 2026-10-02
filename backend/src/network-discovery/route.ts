import type { FastifyInstance } from "fastify";

import { validRunnerBearerToken } from "../runner-heartbeat/auth.js";
import type { NetworkDiscoveryRepository } from "../persistence/network-discovery.js";
import { validateNetworkDiscoveryRequest } from "./contract.js";

export const NETWORK_DISCOVERY_BODY_LIMIT_BYTES = 80 * 1024;
export const NETWORK_DISCOVERY_PERSISTENCE_TIMEOUT_MS = 10_000;

export type NetworkDiscoveryRouteOptions = Readonly<{
  token: string;
  repository: NetworkDiscoveryRepository;
  now?: () => Date;
  timeoutMs?: number;
}>;

export function registerNetworkDiscoveryRoute(server: FastifyInstance, options: NetworkDiscoveryRouteOptions): void {
  server.post("/api/runner/network-discovery", { bodyLimit: NETWORK_DISCOVERY_BODY_LIMIT_BYTES }, async (request, reply) => {
    if (!validRunnerBearerToken(request.headers.authorization, options.token)) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Runner authentication required" } });
    }
    const validated = validateNetworkDiscoveryRequest(request.body);
    if (!validated.ok) {
      return reply.code(400).send({ error: { code: "INVALID_NETWORK_DISCOVERY_PAYLOAD", message: validated.message } });
    }
    const now = (options.now ?? (() => new Date()))();
    const signal = AbortSignal.timeout(options.timeoutMs ?? NETWORK_DISCOVERY_PERSISTENCE_TIMEOUT_MS);
    try {
      const input = validated.value;
      const data = input.action === "claim_session"
        ? await options.repository.claim(input.runner_id, now.toISOString(), signal)
        : input.action === "context_ready"
          ? await options.repository.contextReady(input.runner_id, input.session_id, input.context, now.toISOString(), signal)
          : input.action === "update_progress"
            ? await options.repository.progress(input.runner_id, input.session_id, input.context, input.scanned_hosts, input.results, now.toISOString(), signal)
            : input.action === "complete_session"
              ? await options.repository.complete(input.runner_id, input.session_id, input.scanned_hosts, now.toISOString(), signal)
              : await options.repository.fail(input.runner_id, input.session_id, input.error_code, now.toISOString(), signal);
      if (input.action !== "claim_session" && !data) {
        return reply.code(409).send({ error: { code: "DISCOVERY_SESSION_NOT_ACTIVE", message: "Discovery session is not active" } });
      }
      return reply.code(200).send({ data });
    } catch {
      request.log.error({ request_id: request.id, error_code: "NETWORK_DISCOVERY_PERSISTENCE_FAILED" }, "network discovery request failed");
      return reply.code(500).send({ error: { code: "NETWORK_DISCOVERY_PERSISTENCE_FAILED", message: "Network discovery request failed" } });
    }
  });
}
