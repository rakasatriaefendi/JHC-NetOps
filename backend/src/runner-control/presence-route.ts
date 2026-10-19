import type { FastifyInstance } from "fastify";
import { validRunnerBearerToken } from "../runner-heartbeat/auth.js";
import type { MonitoringRuntime } from "./runtime.js";
import { persistenceCall } from "../runner-work/service.js";

export type PresenceRouteOptions = {
  token: string; runtime: MonitoringRuntime;
  session: (token: string, signal: AbortSignal) => Promise<{ expires_at: string }>;
  checkMs?: number;
};

/** Next forwards its HttpOnly cookie server-to-server; browser supplies no user ID.
 * Stream leases are revalidated independently of browser timers or SSE activity. */
export function registerPresenceRoute(server: FastifyInstance, options: PresenceRouteOptions): void {
  const closeAll = new Set<() => void>();
  server.get("/api/application/presence", async (request, reply) => {
    if (!validRunnerBearerToken(request.headers.authorization, options.token)) return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
    const token = request.headers["x-netops-session"];
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
    if (closeAll.size >= 128) return reply.code(503).send({ error: { code: "PRESENCE_LIMIT" } });
    let expiresAt: number;
    try { expiresAt = Date.parse((await persistenceCall(AbortSignal.timeout(3_000), (signal) => options.session(token, signal))).expires_at); }
    catch { return reply.code(401).send({ error: { code: "UNAUTHORIZED" } }); }
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || reply.raw.destroyed) return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
    // Recheck capacity after asynchronous authorization to close admission races.
    if (closeAll.size >= 128) return reply.code(503).send({ error: { code: "PRESENCE_LIMIT" } });
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe = () => {};
    const leave = options.runtime.enter();
    const socket = reply.raw.socket;
    const oldTimeout = socket?.timeout ?? 0;
    const close = () => {
      if (closed) return;
      closed = true; clearTimeout(timer); clearTimeout(expiry); unsubscribe(); leave(); closeAll.delete(close);
      if (socket && !socket.destroyed) socket.setTimeout?.(oldTimeout);
      reply.raw.end();
    };
    const send = () => {
      if (closed) return;
      const value = JSON.stringify(options.runtime.snapshot());
      if (!reply.raw.write(`event: runtime\ndata: ${value}\n\n`)) close();
    };
    closeAll.add(close);
    unsubscribe = options.runtime.subscribe(send);
    reply.hijack(); socket?.setTimeout?.(0);
    reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "private, no-store, no-transform", "x-accel-buffering": "no", connection: "keep-alive" });
    reply.raw.once("close", close); reply.raw.once("error", close); request.raw.once("aborted", close);
    const expiry = setTimeout(close, Math.min(43_200_000, expiresAt - Date.now()));
    send();
    const check = async () => {
      try {
        await persistenceCall(AbortSignal.timeout(3_000), (signal) => options.session(token, signal));
        if (closed) return;
        send(); timer = setTimeout(() => { void check(); }, options.checkMs ?? 15_000);
      } catch { close(); }
    };
    timer = setTimeout(() => { void check(); }, options.checkMs ?? 15_000);
  });
  server.addHook("preClose", async () => { for (const close of closeAll) close(); });
}
