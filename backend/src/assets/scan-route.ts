import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from "fastify";

import { validRunnerBearerToken } from "../runner-heartbeat/auth.js";
import { validateAssetId } from "./contract.js";
import { AssetScanError, type AssetScanController } from "./scan-controller.js";
import { validateAssetScanRequest } from "./scan-contract.js";

export type AssetScanRouteOptions = Readonly<{
  token: string;
  controller: Pick<AssetScanController, "networks" | "state" | "start" | "cancel">;
}>;

export function registerAssetScanRoutes(server: FastifyInstance, options: AssetScanRouteOptions): void {
  const authorized = (authorization: unknown) => validRunnerBearerToken(authorization, options.token);

  server.get("/api/assets/scan", async (request, reply) => {
    if (!authorized(request.headers.authorization)) return unauthorized(reply);
    try {
      return reply.code(200).send({ data: await options.controller.state() });
    } catch {
      request.log.error({ request_id: request.id, error_code: "ASSET_SCAN_STATE_FAILED" }, "asset scan state failed");
      return reply.code(503).send({ error: { code: "ASSET_SCAN_STATE_FAILED", message: "Scanner state is temporarily unavailable" } });
    }
  });

  server.post("/api/assets/scan", async (request, reply) => {
    if (!authorized(request.headers.authorization)) return unauthorized(reply);
    const validated = validateAssetScanRequest(request.body, options.controller.networks);
    if (!validated.ok) {
      return reply.code(400).send({ error: { code: validated.code, message: "Scan request is invalid or not allowed" } });
    }
    try {
      return reply.code(202).send({ data: await options.controller.start(validated.value.mode, validated.value.network) });
    } catch (error) {
      return scanError(request.id, error, request.log, reply);
    }
  });

  server.delete<{ Params: { id: string } }>("/api/assets/scan/:id", async (request, reply) => {
    if (!authorized(request.headers.authorization)) return unauthorized(reply);
    if (!validateAssetId(request.params.id)) {
      return reply.code(400).send({ error: { code: "INVALID_SCAN_ID", message: "Scan identifier is invalid" } });
    }
    try {
      return reply.code(200).send({ data: await options.controller.cancel(request.params.id) });
    } catch (error) {
      return scanError(request.id, error, request.log, reply);
    }
  });
}

function unauthorized(reply: FastifyReply) {
  return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Frontend server authentication required" } });
}

function scanError(
  requestId: string,
  error: unknown,
  logger: FastifyBaseLogger,
  reply: FastifyReply,
) {
  if (error instanceof AssetScanError) {
    const status = error.code === "SCAN_ALREADY_RUNNING" ? 409 : error.code === "SCANNER_UNAVAILABLE" ? 503 : 404;
    return reply.code(status).send({ error: { code: error.code, message: scanMessage(error.code) } });
  }
  logger.error({ request_id: requestId, error_code: "ASSET_SCAN_FAILED" }, "asset scan request failed");
  return reply.code(503).send({ error: { code: "ASSET_SCAN_FAILED", message: "Scanner is temporarily unavailable" } });
}

function scanMessage(code: AssetScanError["code"]): string {
  if (code === "SCAN_ALREADY_RUNNING") return "Another asset scan is already running";
  if (code === "SCANNER_UNAVAILABLE") return "Asset scanner is not available";
  return "Asset scan is not running";
}
