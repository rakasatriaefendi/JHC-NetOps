import type { FastifyInstance } from "fastify";
import { validRunnerBearerToken } from "../runner-heartbeat/auth.js";
import { requestedWorkWait, workRunner } from "./contract.js";
import { RunnerNotRegistered } from "./repository.js";
import { RunnerWorkService, WorkWaitLimit } from "./service.js";

export type RunnerWorkRouteOptions = { token: string; service: RunnerWorkService };
const ENQUEUE_ROUTES = new Set([
  "POST /api/application/ping-jobs", "POST /api/application/traffic-live-sessions",
  "POST /api/application/network-discovery", "PATCH /api/application/network-discovery/:runnerId",
  "POST /api/application/device-inspection",
]);

export function registerRunnerWorkRoute(server: FastifyInstance, options: RunnerWorkRouteOptions): void {
  server.addHook("onReady", async () => {
    options.service.start(() => server.log.error({ error_code: "WORK_RECOVERY_FAILED" }, "work recovery failed"));
  });
  server.addHook("preClose", async () => { await options.service.stop(); });
  server.addHook("onResponse", async (request, reply) => {
    if (reply.statusCode >= 200 && reply.statusCode < 300 &&
        ENQUEUE_ROUTES.has(`${request.method} ${request.routeOptions.url}`)) {
      // This body/route has already passed application authorization/validation.
      const body = request.body as { input?: { runner_id?: unknown } } | undefined;
      const params = request.params as { runnerId?: unknown } | undefined;
      const id = params?.runnerId ?? body?.input?.runner_id;
      // Ping enqueue derives its runner from target_id inside the repository;
      // a bounded broadcast hint avoids a second query or any job payload.
      options.service.wake(typeof id === "string" ? id : undefined);
    }
  });
  server.post("/api/runner/work/wait", { bodyLimit: 256 }, async (request, reply) => {
    if (!validRunnerBearerToken(request.headers.authorization, options.token)) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
    }
    const runnerId = workRunner(request.body);
    if (!runnerId) return reply.code(400).send({ error: { code: "INVALID_WORK_WAIT" } });
    const controller = new AbortController();
    const cancel = () => controller.abort();
    request.raw.once("aborted", cancel);
    reply.raw.once("close", cancel);
    const socket = reply.raw.socket;
    const previousTimeout = socket?.timeout ?? 0;
    // Only this authenticated bounded wait may exceed the ordinary 5s idle timeout.
    socket?.setTimeout?.(0);
    try {
      const data = await options.service.wait(runnerId, controller.signal, requestedWorkWait(request.body));
      return reply.code(200).header("cache-control", "no-store").send({ data });
    } catch (error) {
      const code = error instanceof RunnerNotRegistered ? "RUNNER_NOT_REGISTERED"
        : error instanceof WorkWaitLimit ? "WORK_WAIT_LIMIT" : "WORK_WAIT_UNAVAILABLE";
      return reply.code(error instanceof RunnerNotRegistered ? 403 : 503).send({ error: { code } });
    } finally {
      request.raw.removeListener("aborted", cancel);
      reply.raw.removeListener("close", cancel);
      if (socket && !socket.destroyed) socket.setTimeout?.(previousTimeout);
    }
  });
}
