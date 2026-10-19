import type { FastifyInstance } from "fastify";
import { WebSocketServer, WebSocket } from "ws";
import { Socket } from "node:net";
import { validRunnerBearerToken } from "../runner-heartbeat/auth.js";
import { validateRunnerHeartbeatRequest } from "../runner-heartbeat/contract.js";
import type { RunnerHeartbeatRepository } from "../runner-heartbeat/repository.js";
import type { RunnerWorkRepository } from "../runner-work/repository.js";
import type { RunnerWorkService } from "../runner-work/service.js";
import { persistenceCall } from "../runner-work/service.js";
import type { MonitoringRuntime } from "./runtime.js";

export type RunnerControlOptions = {
  token: string; heartbeat: RunnerHeartbeatRepository; work: RunnerWorkRepository;
  service: RunnerWorkService; runtime: MonitoringRuntime;
  busy: (signal: AbortSignal) => Promise<boolean>;
  reconcileMs?: number;
};

export function registerRunnerControl(server: FastifyInstance, options: RunnerControlOptions): void {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 32_768, perMessageDeflate: false });
  const ids = new Map<string, WebSocket>();
  const shutdown = new AbortController();
  const refreshers = new Map<WebSocket, () => void>();
  let busyCheck = false;
  let busyRevision = 0;
  let busyTrailing: ReturnType<typeof setTimeout> | undefined;
  let durableBusy = false;
  let durableUncertain = true;
  const reports = new Map<WebSocket, { ready: boolean; busy: boolean; revision: number }>();
  const evidence = () => {
    const revision = options.runtime.policyRevision;
    options.runtime.evidence(durableBusy || [...reports.values()].some((r) => r.busy),
      reports.size > 0 && [...reports.values()].every((r) => r.ready && r.revision === revision), durableUncertain,
      reports.size > 0 && [...reports.values()].every((r) => r.revision === revision));
  };
  const runtimeMessage = (type: "runtime" | "ready") => JSON.stringify({ type,
    ...options.runtime.snapshot(), policy_revision: options.runtime.policyRevision });
  const reconcileBusy = async () => {
    if (busyCheck || shutdown.signal.aborted) return;
    busyCheck = true;
    const revision = busyRevision;
    try {
      const busy = await options.busy(AbortSignal.any([shutdown.signal, AbortSignal.timeout(3_000)]));
      if (revision === busyRevision) { durableBusy = busy; durableUncertain = false; }
    }
    catch { durableUncertain = true; }
    finally {
      busyCheck = false; evidence();
      if (revision !== busyRevision && !shutdown.signal.aborted) {
        busyTrailing ??= setTimeout(() => { busyTrailing = undefined; void reconcileBusy(); }, 100);
      }
    }
  };
  const unsubscribeWake = options.service.subscribeWake((id) => {
    busyRevision += 1;
    durableUncertain = true;
    evidence();
    for (const [socket, refresh] of refreshers) if (!id || ids.get(id) === socket) refresh();
    void reconcileBusy();
  });
  const unsubscribeRuntime = options.runtime.subscribe(() => {
    const payload = runtimeMessage("runtime");
    for (const socket of reports.keys()) send(socket, payload);
  });
  const maintenance = setInterval(() => { void reconcileBusy(); }, options.reconcileMs ?? 10_000);
  maintenance.unref();
  void reconcileBusy();
  function send(socket: WebSocket, payload: string): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 65_536) return socket.terminate();
    socket.send(payload);
  }
  server.server.on("upgrade", (request, socket, head) => {
    const loopback = socket instanceof Socket && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(socket.remoteAddress ?? "");
    if (request.url !== "/api/runner/control" || !loopback || request.headers.origin ||
      !validRunnerBearerToken(request.headers.authorization, options.token) || shutdown.signal.aborted || sockets.clients.size >= 32) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); return;
    }
    if (socket instanceof Socket) socket.setTimeout(0);
    sockets.handleUpgrade(request, socket, head, (ws) => sockets.emit("connection", ws));
  });
  sockets.on("connection", (socket) => {
    let id: string | null = null;
    let healthyAt = Date.now();
    let pong = true;
    let lastPingAt = 0;
    let processing = false;
    let revision = 0;
    let checked = 0;
    let checking = false;
    let initialized = false;
    let messageWindow = Date.now();
    let messages = 0;
    let lastWork = "";
    let nextCheckAt = 0;
    let trailing: ReturnType<typeof setTimeout> | undefined;
    const signal = new AbortController();
    const querySignal = () => AbortSignal.any([signal.signal, shutdown.signal, AbortSignal.timeout(3_000)]);
    const refresh = async () => {
      revision += 1;
      if (!id || !initialized || checking || signal.signal.aborted) return;
      if (Date.now() < nextCheckAt) {
        trailing ??= setTimeout(() => { trailing = undefined; void refresh(); }, nextCheckAt - Date.now());
        return;
      }
      checking = true;
      try {
        // Subscribe before check; a commit during the query schedules one trailing read.
        checked = revision;
        nextCheckAt = Date.now() + 100;
        const available = await persistenceCall(querySignal(), (signal) => options.work.available(id!, signal));
        const next = JSON.stringify({ type: "work_available", available });
        if (available.length || next !== lastWork) { send(socket, next); lastWork = next; }
      } catch { socket.close(1011, "CONTROL_UNAVAILABLE"); }
      finally {
        checking = false;
        if (checked !== revision && !signal.signal.aborted) void refresh();
      }
    };
    refreshers.set(socket, () => { void refresh(); });
    const helloDeadline = setTimeout(() => { if (!initialized) socket.terminate(); }, 8_000);
    const tick = setInterval(() => {
      if (Date.now() - healthyAt > 90_000) return socket.terminate();
      if (Date.now() - lastPingAt >= 10_000) {
        if (!pong) return socket.terminate();
        pong = false; lastPingAt = Date.now(); socket.ping();
      }
      void refresh();
      send(socket, runtimeMessage("runtime"));
    }, options.reconcileMs ?? 10_000);
    socket.on("pong", () => { pong = true; });
    socket.on("error", () => { /* never log frames, headers or credentials */ });
    socket.on("message", (data, binary) => {
      if (Date.now() - messageWindow >= 1000) { messageWindow = Date.now(); messages = 0; }
      if (binary || ++messages > 12) return socket.close(1008, "INVALID_CONTROL_MESSAGE");
      let body: unknown;
      try { body = JSON.parse(data.toString()); } catch { return socket.close(1008, "INVALID_CONTROL_MESSAGE"); }
      if (!body || typeof body !== "object" || Array.isArray(body)) return socket.close(1008, "INVALID_CONTROL_MESSAGE");
      const message = body as Record<string, unknown>;
      if (message.type === "reconcile" && Object.keys(message).length === 1 && initialized) {
        void refresh(); return;
      }
      if (processing) return socket.close(1008, "INVALID_CONTROL_MESSAGE");
      if (Object.keys(message).length !== 5 || message.type !== "health" ||
        !Number.isSafeInteger(message.policy_revision) || Number(message.policy_revision) < 0 ||
        typeof message.ready !== "boolean" || typeof message.busy !== "boolean") return socket.close(1008, "INVALID_CONTROL_MESSAGE");
      const validated = validateRunnerHeartbeatRequest({ runner: message.runner });
      if (!validated.ok || (id !== null && id !== validated.value.id)) return socket.close(1008, "INVALID_RUNNER");
      if (!id) {
        if (ids.has(validated.value.id)) return socket.close(1008, "DUPLICATE_RUNNER");
        id = validated.value.id; ids.set(id, socket);
      }
      processing = true;
      void (async () => {
        try {
          const timestamp = new Date().toISOString();
          await persistenceCall(querySignal(), (signal) => options.heartbeat.upsertHeartbeat({ ...validated.value, last_seen_at: timestamp, updated_at: timestamp }, signal));
          await persistenceCall(querySignal(), (signal) => options.heartbeat.expireStaleTrafficSessions(validated.value.id, signal));
          healthyAt = Date.now();
          if (signal.signal.aborted) return;
          if (!initialized) { initialized = true; options.runtime.connection(1); }
          reports.set(socket, { ready: message.ready === true, busy: message.busy === true, revision: Number(message.policy_revision) }); evidence();
          await refresh(); // Reconcile before READY; jobs still require atomic HTTP claims.
          send(socket, runtimeMessage("ready"));
        } catch { socket.close(1011, "CONTROL_UNAVAILABLE"); }
        finally { processing = false; }
      })();
    });
    socket.once("close", () => {
      signal.abort(); clearInterval(tick); clearTimeout(helloDeadline); refreshers.delete(socket); reports.delete(socket);
      clearTimeout(trailing);
      if (id && ids.get(id) === socket) ids.delete(id);
      if (initialized) options.runtime.connection(-1);
      evidence();
    });
  });
  server.addHook("preClose", async () => {
    shutdown.abort(); clearInterval(maintenance); clearTimeout(busyTrailing); unsubscribeWake(); unsubscribeRuntime();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
  });
}
