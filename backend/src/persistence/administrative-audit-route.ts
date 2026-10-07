import type { FastifyInstance } from "fastify";
import { validRunnerBearerToken } from "../runner-heartbeat/auth.js";
import { ProfilePersistenceError } from "./profiles.js";
import type { PostgresAdministrativeAuditRepository } from "./administrative-audit.js";

export function registerAdministrativeAuditRoute(server: FastifyInstance, options: {
  token: string; repository: PostgresAdministrativeAuditRepository;
}) {
  server.get("/api/application/administrative-audit", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    if (!validRunnerBearerToken(request.headers.authorization, options.token)) return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
    const query = request.query as Record<string, unknown>;
    if (Object.keys(query).some((key) => !["actor_id", "offset"].includes(key)) || typeof query.actor_id !== "string" ||
      (query.offset !== undefined && (typeof query.offset !== "string" || !/^\d{1,5}$/.test(query.offset)))) return reply.code(400).send({ error: { code: "INVALID_PROFILE" } });
    try {
      return { data: await options.repository.list(query.actor_id, Number(query.offset ?? 0), AbortSignal.timeout(7_000)) };
    } catch (error) {
      return reply.code(error instanceof ProfilePersistenceError ? error.code === "INVALID_PROFILE" ? 400 : 403 : 503).send({ error: { code:
        error instanceof ProfilePersistenceError ? error.code : "ADMINISTRATIVE_AUDIT_UNAVAILABLE" } });
    }
  });
}
