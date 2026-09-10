import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from "fastify";

import { validRunnerBearerToken } from "../runner-heartbeat/auth.js";
import { validateAssetId } from "./contract.js";
import { ScanNetworkManagerError, type ScanNetworkManager } from "./scan-network-manager.js";
import { validateCreateScanNetwork, validateScanNetworkTest, validateUpdateScanNetwork } from "./scan-network-contract.js";
import { ScanNetworkRepositoryError } from "./scan-network-repository.js";

export type ScanNetworkRouteOptions = Readonly<{
  token: string;
  manager: Pick<ScanNetworkManager, "list" | "detected" | "inspect" | "create" | "update" | "remove">;
}>;

export function registerScanNetworkRoutes(server: FastifyInstance, options: ScanNetworkRouteOptions): void {
  const authorized = (authorization: unknown) => validRunnerBearerToken(authorization, options.token);

  server.get("/api/assets/scan-networks", async (request, reply) => {
    if (!authorized(request.headers.authorization)) return unauthorized(reply);
    try { return reply.code(200).send({ data: { networks: await options.manager.list() } }); }
    catch (error) { return unavailable(request.id, request.log, reply, error); }
  });

  server.get("/api/assets/scan-networks/detected", async (request, reply) => {
    if (!authorized(request.headers.authorization)) return unauthorized(reply);
    try { return reply.code(200).send({ data: await options.manager.detected() }); }
    catch (error) { return unavailable(request.id, request.log, reply, error); }
  });

  server.post("/api/assets/scan-networks/test", async (request, reply) => {
    if (!authorized(request.headers.authorization)) return unauthorized(reply);
    const validated = validateScanNetworkTest(request.body);
    if (!validated.ok) return invalid(reply, validated.code);
    try {
      return reply.code(200).send({ data: { ...await options.manager.inspect(validated.value.cidr), canonicalized: validated.canonicalized } });
    } catch (error) { return unavailable(request.id, request.log, reply, error); }
  });

  server.post("/api/assets/scan-networks", async (request, reply) => {
    if (!authorized(request.headers.authorization)) return unauthorized(reply);
    const validated = validateCreateScanNetwork(request.body);
    if (!validated.ok) return invalid(reply, validated.code);
    try {
      const created = await options.manager.create(validated.value);
      return reply.code(201).send({ data: { ...created, canonicalized: validated.canonicalized } });
    } catch (error) { return mutationError(request.id, request.log, reply, error); }
  });

  server.patch<{ Params: { id: string } }>("/api/assets/scan-networks/:id", async (request, reply) => {
    if (!authorized(request.headers.authorization)) return unauthorized(reply);
    if (!validateAssetId(request.params.id)) return invalid(reply, "INVALID_SCAN_NETWORK_ID");
    const validated = validateUpdateScanNetwork(request.body);
    if (!validated.ok) return invalid(reply, validated.code);
    try {
      const network = await options.manager.update(request.params.id, validated.value);
      return network ? reply.code(200).send({ data: { network } })
        : reply.code(404).send({ error: { code: "SCAN_NETWORK_NOT_FOUND", message: "Scan network was not found" } });
    } catch (error) { return mutationError(request.id, request.log, reply, error); }
  });

  server.delete<{ Params: { id: string } }>("/api/assets/scan-networks/:id", async (request, reply) => {
    if (!authorized(request.headers.authorization)) return unauthorized(reply);
    if (!validateAssetId(request.params.id)) return invalid(reply, "INVALID_SCAN_NETWORK_ID");
    try {
      return await options.manager.remove(request.params.id)
        ? reply.code(204).send()
        : reply.code(404).send({ error: { code: "SCAN_NETWORK_NOT_FOUND", message: "Scan network was not found" } });
    } catch (error) { return mutationError(request.id, request.log, reply, error); }
  });
}

function unauthorized(reply: FastifyReply) {
  return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Frontend server authentication required" } });
}

function invalid(reply: FastifyReply, code: string) {
  return reply.code(400).send({ error: { code, message: "Scan network request is invalid" } });
}

function mutationError(requestId: string, logger: FastifyBaseLogger, reply: FastifyReply, error: unknown) {
  if (error instanceof ScanNetworkRepositoryError) {
    return reply.code(error.code === "SCAN_NETWORK_DUPLICATE" ? 409 : 400)
      .send({ error: { code: error.code, message: error.code === "SCAN_NETWORK_DUPLICATE" ? "Scan network already exists" : "Scan network limit reached" } });
  }
  if (error instanceof ScanNetworkManagerError) {
    return reply.code(409).send({ error: { code: error.code, message: "Scan network route is not currently available" } });
  }
  return unavailable(requestId, logger, reply, error);
}

function unavailable(requestId: string, logger: FastifyBaseLogger, reply: FastifyReply, error: unknown) {
  void error;
  logger.error({ request_id: requestId, error_code: "SCAN_NETWORKS_UNAVAILABLE" }, "scan network operation failed");
  return reply.code(503).send({ error: { code: "SCAN_NETWORKS_UNAVAILABLE", message: "Scan network settings are temporarily unavailable" } });
}
