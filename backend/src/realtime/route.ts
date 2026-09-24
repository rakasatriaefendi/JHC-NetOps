import type { FastifyInstance } from "fastify";

import { validRunnerBearerToken } from "../runner-heartbeat/auth.js";
import type { LocalRealtimeBroker } from "./broker.js";
import { createSyncInvalidation, serializeLocalRealtimeSse } from "./contract.js";

export const LOCAL_REALTIME_HEARTBEAT_MS = 15_000;

export type LocalRealtimeRouteOptions = Readonly<{
  token: string;
  broker: LocalRealtimeBroker;
  now?: () => Date;
  eventId?: () => string;
  heartbeatMs?: number;
}>;

export function registerLocalRealtimeRoute(server: FastifyInstance, options: LocalRealtimeRouteOptions): void {
  server.get("/api/realtime/events", async (request, reply) => {
    if (!validRunnerBearerToken(request.headers.authorization, options.token)) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } });
    }

    let disposed = false;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let unsubscribe = () => {};
    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe();
    };
    const close = () => {
      cleanup();
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
    };
    const send = (event: Parameters<typeof serializeLocalRealtimeSse>[0]) => {
      if (disposed || reply.raw.destroyed || reply.raw.writableEnded) return false;
      return reply.raw.write(serializeLocalRealtimeSse(event));
    };

    const subscribed = options.broker.subscribe({ send, close });
    if (!subscribed) {
      return reply.code(503).send({
        error: { code: "REALTIME_SUBSCRIBER_LIMIT", message: "Realtime stream unavailable" },
      });
    }
    unsubscribe = subscribed;

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "private, no-cache, no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    request.raw.once("aborted", cleanup);
    reply.raw.once("error", cleanup);
    reply.raw.once("close", cleanup);

    if (!send(createSyncInvalidation(options.now, options.eventId))) return close();
    const heartbeatMs = options.heartbeatMs ?? LOCAL_REALTIME_HEARTBEAT_MS;
    heartbeat = setInterval(() => {
      if (disposed || !reply.raw.write(`: heartbeat ${Date.now()}\n\n`)) close();
    }, heartbeatMs);
  });
}
