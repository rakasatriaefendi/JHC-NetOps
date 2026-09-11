import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { validRunnerBearerToken } from "../runner-heartbeat/auth.js";
import {
  validateCalibrationInput,
  validateMedicalEquipmentInput,
  validateMedicalId,
  validateMedicalListQuery,
  validateServiceInput,
} from "./contract.js";
import { MEDICAL_QUERY_TIMEOUT_MS, MedicalRepositoryError, type MedicalEquipmentRepository } from "./repository.js";

export type MedicalEquipmentRouteOptions = Readonly<{
  token: string;
  repository: MedicalEquipmentRepository;
  dueSoonDays?: number;
  timeoutMs?: number;
  now?: () => Date;
}>;

export function registerMedicalEquipmentRoutes(server: FastifyInstance, options: MedicalEquipmentRouteOptions): void {
  const authorize = (request: FastifyRequest, reply: FastifyReply) => {
    if (validRunnerBearerToken(request.headers.authorization, options.token)) return true;
    void reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Frontend server authentication required" } });
    return false;
  };
  const signal = () => AbortSignal.timeout(options.timeoutMs ?? MEDICAL_QUERY_TIMEOUT_MS);
  const today = () => localCalendarDate(
    (options.now ?? (() => new Date()))(),
  );
  const dueSoonDays = options.dueSoonDays ?? 30;

  server.get("/api/medical-equipment", async (request, reply) => {
    if (!authorize(request, reply)) return;
    const parsed = validateMedicalListQuery(request.query);
    if (!parsed.ok) return reply.code(400).send({ error: { code: "INVALID_MEDICAL_QUERY", message: parsed.message } });
    try {
      return reply.code(200).send({ data: await options.repository.list(parsed.value, today(), dueSoonDays, signal()) });
    } catch {
      return queryFailure(request, reply);
    }
  });

  server.get("/api/medical-equipment/network-assets", async (request, reply) => {
    if (!authorize(request, reply)) return;
    const query = request.query as Record<string, unknown>;
    if (Object.keys(query).some((key) => key !== "q") || (query.q !== undefined && (typeof query.q !== "string" || query.q.length > 100 || /[\u0000-\u001f\u007f]/.test(query.q)))) {
      return reply.code(400).send({ error: { code: "INVALID_MEDICAL_QUERY", message: "Network asset search is invalid" } });
    }
    try {
      return reply.code(200).send({ data: { items: await options.repository.networkAssets(typeof query.q === "string" ? query.q : "", signal()) } });
    } catch { return queryFailure(request, reply); }
  });

  server.get("/api/medical-equipment/network-links", async (request, reply) => {
    if (!authorize(request, reply)) return;
    const query = request.query as Record<string, unknown>;
    const raw = typeof query.asset_ids === "string" ? query.asset_ids : "";
    const ids = raw ? raw.split(",") : [];
    if (Object.keys(query).some((key) => key !== "asset_ids") || ids.length > 50 || ids.some((id) => !validateMedicalId(id))) {
      return reply.code(400).send({ error: { code: "INVALID_MEDICAL_QUERY", message: "Asset link query is invalid" } });
    }
    try { return reply.code(200).send({ data: { items: await options.repository.networkLinks(ids, signal()) } }); }
    catch { return queryFailure(request, reply); }
  });

  server.post("/api/medical-equipment", async (request, reply) => {
    if (!authorize(request, reply)) return;
    const parsed = validateMedicalEquipmentInput(request.body);
    if (!parsed.ok) return reply.code(400).send({ error: { code: "INVALID_MEDICAL_EQUIPMENT", message: parsed.message } });
    try { return reply.code(201).send({ data: await options.repository.create(parsed.value, today(), dueSoonDays, signal()) }); }
    catch (error) { return writeFailure(request, reply, error); }
  });

  server.get<{ Params: { id: string } }>("/api/medical-equipment/:id", async (request, reply) => {
    if (!authorize(request, reply)) return;
    if (!validateMedicalId(request.params.id)) return reply.code(400).send({ error: { code: "INVALID_MEDICAL_ID", message: "Medical equipment id is invalid" } });
    try {
      const data = await options.repository.detail(request.params.id, today(), dueSoonDays, signal());
      return data ? reply.code(200).send({ data }) : reply.code(404).send({ error: { code: "MEDICAL_EQUIPMENT_NOT_FOUND", message: "Medical equipment was not found" } });
    } catch { return queryFailure(request, reply); }
  });

  server.patch<{ Params: { id: string } }>("/api/medical-equipment/:id", async (request, reply) => {
    if (!authorize(request, reply)) return;
    if (!validateMedicalId(request.params.id)) return reply.code(400).send({ error: { code: "INVALID_MEDICAL_ID", message: "Medical equipment id is invalid" } });
    const parsed = validateMedicalEquipmentInput(request.body);
    if (!parsed.ok) return reply.code(400).send({ error: { code: "INVALID_MEDICAL_EQUIPMENT", message: parsed.message } });
    try {
      const data = await options.repository.update(request.params.id, parsed.value, today(), dueSoonDays, signal());
      return data ? reply.code(200).send({ data }) : reply.code(404).send({ error: { code: "MEDICAL_EQUIPMENT_NOT_FOUND", message: "Medical equipment was not found" } });
    } catch (error) { return writeFailure(request, reply, error); }
  });

  server.post<{ Params: { id: string } }>("/api/medical-equipment/:id/calibrations", async (request, reply) => {
    if (!authorize(request, reply)) return;
    if (!validateMedicalId(request.params.id)) return reply.code(400).send({ error: { code: "INVALID_MEDICAL_ID", message: "Medical equipment id is invalid" } });
    const parsed = validateCalibrationInput(request.body);
    if (!parsed.ok) return reply.code(400).send({ error: { code: "INVALID_CALIBRATION", message: parsed.message } });
    try {
      const data = await options.repository.addCalibration(request.params.id, parsed.value, signal());
      return data ? reply.code(201).send({ data }) : reply.code(404).send({ error: { code: "MEDICAL_EQUIPMENT_NOT_FOUND", message: "Medical equipment was not found" } });
    } catch (error) { return writeFailure(request, reply, error); }
  });

  server.post<{ Params: { id: string } }>("/api/medical-equipment/:id/services", async (request, reply) => {
    if (!authorize(request, reply)) return;
    if (!validateMedicalId(request.params.id)) return reply.code(400).send({ error: { code: "INVALID_MEDICAL_ID", message: "Medical equipment id is invalid" } });
    const parsed = validateServiceInput(request.body);
    if (!parsed.ok) return reply.code(400).send({ error: { code: "INVALID_SERVICE", message: parsed.message } });
    try {
      const data = await options.repository.addService(request.params.id, parsed.value, signal());
      return data ? reply.code(201).send({ data }) : reply.code(404).send({ error: { code: "MEDICAL_EQUIPMENT_NOT_FOUND", message: "Medical equipment was not found" } });
    } catch (error) { return writeFailure(request, reply, error); }
  });
}

function queryFailure(request: FastifyRequest, reply: FastifyReply) {
  request.log.error({ request_id: request.id, error_code: "MEDICAL_EQUIPMENT_QUERY_FAILED" }, "medical equipment query failed");
  return reply.code(503).send({ error: { code: "MEDICAL_EQUIPMENT_UNAVAILABLE", message: "Medical equipment data is temporarily unavailable" } });
}

function writeFailure(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof MedicalRepositoryError) {
    const status = error.code === "NETWORK_ASSET_NOT_FOUND" ? 400 : 409;
    const messages = {
      MEDICAL_EQUIPMENT_DUPLICATE: "Equipment code already exists",
      NETWORK_ASSET_ALREADY_LINKED: "Network asset is already linked to medical equipment",
      NETWORK_ASSET_NOT_FOUND: "Network asset was not found",
    } as const;
    return reply.code(status).send({ error: { code: error.code, message: messages[error.code] } });
  }
  request.log.error({ request_id: request.id, error_code: "MEDICAL_EQUIPMENT_WRITE_FAILED" }, "medical equipment write failed");
  return reply.code(503).send({ error: { code: "MEDICAL_EQUIPMENT_WRITE_FAILED", message: "Medical equipment change could not be saved" } });
}
function localCalendarDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}