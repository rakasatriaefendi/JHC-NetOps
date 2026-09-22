import type { FastifyInstance } from "fastify";

import type { DeviceInspectionRepository } from "../persistence/device-inspection.js";
import { validRunnerBearerToken } from "../runner-heartbeat/auth.js";
import { validateDeviceInspectionRequest } from "./contract.js";

export const DEVICE_INSPECTION_BODY_LIMIT_BYTES = 72 * 1024;
export const DEVICE_INSPECTION_PERSISTENCE_TIMEOUT_MS = 10_000;

export type DeviceInspectionRouteOptions = Readonly<{
  token: string;
  repository: DeviceInspectionRepository;
  now?: () => Date;
  timeoutMs?: number;
}>;

export function registerDeviceInspectionRoute(server: FastifyInstance, options: DeviceInspectionRouteOptions): void {
  server.post("/api/runner/device-inspector", { bodyLimit: DEVICE_INSPECTION_BODY_LIMIT_BYTES }, async (request, reply) => {
    if (!validRunnerBearerToken(request.headers.authorization, options.token)) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Runner authentication required" } });
    }
    const validated = validateDeviceInspectionRequest(request.body);
    if (!validated.ok) {
      return reply.code(validated.tooLarge ? 413 : 400).send({
        error: { code: validated.tooLarge ? "INSPECTION_RESULT_TOO_LARGE" : "INVALID_DEVICE_INSPECTION_PAYLOAD", message: validated.message },
      });
    }
    const input = validated.value;
    const now = (options.now ?? (() => new Date()))().toISOString();
    const signal = AbortSignal.timeout(options.timeoutMs ?? DEVICE_INSPECTION_PERSISTENCE_TIMEOUT_MS);
    try {
      const data = input.action === "claim_session"
        ? await options.repository.claim(input.runner_id, now, signal)
        : input.action === "update_stage"
          ? await options.repository.updateStage(input.runner_id, input.inspection_id, input.stage, now, signal)
          : input.action === "complete_session"
            ? await options.repository.complete(input.runner_id, input.inspection_id, input.result, now, signal)
            : await options.repository.fail(input.runner_id, input.inspection_id, input.error_code, now, signal);
      if (input.action !== "claim_session" && !data) {
        return reply.code(409).send({ error: { code: "INSPECTION_SESSION_NOT_ACTIVE", message: "Device inspection session is not active" } });
      }
      return reply.code(200).send({ data });
    } catch {
      request.log.error({ request_id: request.id, error_code: "DEVICE_INSPECTION_PERSISTENCE_FAILED" }, "device inspection request failed");
      return reply.code(500).send({ error: { code: "DEVICE_INSPECTION_PERSISTENCE_FAILED", message: "Device inspection request failed" } });
    }
  });
}
