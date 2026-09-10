import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { validRunnerBearerToken } from "../runner-heartbeat/auth.js";
import { validateAssetId } from "./contract.js";
import { validateAssetChangeQuery } from "./change-contract.js";
import type { AssetChangeRepository } from "./change-repository.js";

export const ASSET_CHANGE_QUERY_TIMEOUT_MS = 5_000;

export type AssetChangeRouteOptions = Readonly<{
  token: string;
  repository: AssetChangeRepository;
  timeoutMs?: number;
  now?: () => Date;
}>;

export function registerAssetChangeRoutes(server: FastifyInstance, options: AssetChangeRouteOptions): void {
  const authorize = (authorization: unknown) => validRunnerBearerToken(authorization, options.token);

  server.get("/api/assets/events", async (request, reply) => {
    if (!authorize(request.headers.authorization)) return unauthorized(reply);
    const validated = validateAssetChangeQuery(request.query);
    if (!validated.ok) return reply.code(400).send({ error: { code: "INVALID_ASSET_CHANGE_QUERY", message: validated.message } });
    return listEvents(request, reply, options, { ...validated.value, assetId: null });
  });

  server.get<{ Params: { id: string } }>("/api/assets/:id/events", async (request, reply) => {
    if (!authorize(request.headers.authorization)) return unauthorized(reply);
    if (!validateAssetId(request.params.id)) return reply.code(400).send({ error: { code: "INVALID_ASSET_ID", message: "Asset identifier is invalid" } });
    const validated = validateAssetChangeQuery(request.query);
    if (!validated.ok) return reply.code(400).send({ error: { code: "INVALID_ASSET_CHANGE_QUERY", message: validated.message } });
    return listEvents(request, reply, options, { ...validated.value, assetId: request.params.id });
  });
}

async function listEvents(
  request: FastifyRequest,
  reply: FastifyReply,
  options: AssetChangeRouteOptions,
  query: Parameters<AssetChangeRepository["list"]>[0],
) {
  try {
    const data = await options.repository.list(query, AbortSignal.timeout(options.timeoutMs ?? ASSET_CHANGE_QUERY_TIMEOUT_MS));
    return reply.code(200).send({ data: { ...data, server_time: (options.now ?? (() => new Date()))().toISOString() } });
  } catch {
    request.log.error({ error_code: "ASSET_CHANGE_QUERY_FAILED" }, "asset change history query failed");
    return reply.code(503).send({ error: { code: "ASSET_CHANGE_QUERY_FAILED", message: "Asset change history is temporarily unavailable" } });
  }
}

function unauthorized(reply: FastifyReply) {
  return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Frontend server authentication required" } });
}
