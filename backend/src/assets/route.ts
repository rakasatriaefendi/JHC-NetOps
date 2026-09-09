import type { FastifyInstance } from "fastify";

import { validRunnerBearerToken } from "../runner-heartbeat/auth.js";
import { validateAssetId, validateAssetListQuery } from "./contract.js";
import type { AssetRepository } from "./repository.js";
import type { AssetSynchronizer } from "./ingestion.js";

export const ASSET_PERSISTENCE_TIMEOUT_MS = 7_000;

export type AssetRouteOptions = Readonly<{
  token: string;
  repository: AssetRepository;
  synchronizer?: AssetSynchronizer;
  timeoutMs?: number;
  now?: () => Date;
}>;

export function registerAssetRoutes(server: FastifyInstance, options: AssetRouteOptions): void {
  const authorize = (authorization: unknown) => validRunnerBearerToken(authorization, options.token);

  server.get("/api/assets", async (request, reply) => {
    if (!authorize(request.headers.authorization)) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Frontend server authentication required" } });
    }
    const validated = validateAssetListQuery(request.query);
    if (!validated.ok) return reply.code(400).send({ error: { code: "INVALID_ASSET_QUERY", message: validated.message } });
    try {
      if (options.synchronizer) {
        try {
          await options.synchronizer.synchronize();
        } catch {
          request.log.warn({ request_id: request.id, error_code: "ASSET_EVIDENCE_SYNC_FAILED" }, "asset evidence sync failed; serving retained inventory");
        }
      }
      const data = await options.repository.list(
        validated.value,
        AbortSignal.timeout(options.timeoutMs ?? ASSET_PERSISTENCE_TIMEOUT_MS),
      );
      return reply.code(200).send({ data: { ...data, server_time: (options.now ?? (() => new Date()))().toISOString() } });
    } catch {
      request.log.error({ request_id: request.id, error_code: "ASSET_QUERY_FAILED" }, "asset query failed");
      return reply.code(503).send({ error: { code: "ASSET_QUERY_FAILED", message: "Asset inventory is temporarily unavailable" } });
    }
  });

  server.get<{ Params: { id: string } }>("/api/assets/:id", async (request, reply) => {
    if (!authorize(request.headers.authorization)) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Frontend server authentication required" } });
    }
    if (!validateAssetId(request.params.id)) {
      return reply.code(400).send({ error: { code: "INVALID_ASSET_ID", message: "Asset identifier is invalid" } });
    }
    try {
      const data = await options.repository.detail(
        request.params.id,
        AbortSignal.timeout(options.timeoutMs ?? ASSET_PERSISTENCE_TIMEOUT_MS),
      );
      return data
        ? reply.code(200).send({ data })
        : reply.code(404).send({ error: { code: "ASSET_NOT_FOUND", message: "Asset was not found" } });
    } catch {
      request.log.error({ request_id: request.id, error_code: "ASSET_QUERY_FAILED" }, "asset detail query failed");
      return reply.code(503).send({ error: { code: "ASSET_QUERY_FAILED", message: "Asset inventory is temporarily unavailable" } });
    }
  });
}
