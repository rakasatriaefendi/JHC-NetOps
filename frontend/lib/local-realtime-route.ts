export type LocalRealtimeProxyDependencies = Readonly<{
  authenticate: () => Promise<boolean>;
  backend: () => { origin: string; token: string } | null;
  fetchImpl?: typeof fetch;
}>;

export function createLocalRealtimeProxy(dependencies: LocalRealtimeProxyDependencies) {
  return async (request: Request): Promise<Response> => {
    if (!await dependencies.authenticate().catch(() => false)) return errorResponse(401, "UNAUTHORIZED");
    const backend = dependencies.backend();
    if (!backend) return errorResponse(503, "LOCAL_REALTIME_UNAVAILABLE");

    const upstreamController = new AbortController();
    const abortUpstream = () => upstreamController.abort();
    if (request.signal.aborted) abortUpstream();
    else request.signal.addEventListener("abort", abortUpstream, { once: true });

    let upstream: Response;
    try {
      upstream = await (dependencies.fetchImpl ?? fetch)(new URL("/api/realtime/events", backend.origin), {
        method: "GET",
        headers: {
          authorization: `Bearer ${backend.token}`,
          accept: "text/event-stream",
        },
        cache: "no-store",
        signal: upstreamController.signal,
      });
    } catch {
      request.signal.removeEventListener("abort", abortUpstream);
      return errorResponse(503, "LOCAL_REALTIME_UNAVAILABLE");
    }
    const contentType = upstream.headers.get("content-type")?.toLowerCase() ?? "";
    if (!upstream.ok || !upstream.body || !contentType.startsWith("text/event-stream")) {
      request.signal.removeEventListener("abort", abortUpstream);
      await upstream.body?.cancel().catch(() => undefined);
      return errorResponse(503, "LOCAL_REALTIME_UNAVAILABLE");
    }

    const reader = upstream.body.getReader();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await reader.read();
          if (result.done) {
            request.signal.removeEventListener("abort", abortUpstream);
            controller.close();
          } else {
            controller.enqueue(result.value);
          }
        } catch {
          request.signal.removeEventListener("abort", abortUpstream);
          abortUpstream();
          await reader.cancel().catch(() => undefined);
          if (!cancelled) controller.error(new Error("Realtime upstream stream failed"));
        }
      },
      async cancel(reason) {
        cancelled = true;
        request.signal.removeEventListener("abort", abortUpstream);
        abortUpstream();
        await reader.cancel(reason).catch(() => undefined);
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "private, no-cache, no-store, no-transform",
        "x-content-type-options": "nosniff",
        "x-accel-buffering": "no",
      },
    });
  };
}

function errorResponse(status: number, code: "UNAUTHORIZED" | "LOCAL_REALTIME_UNAVAILABLE"): Response {
  return Response.json({ error: { code, message: status === 401 ? "Unauthorized" : "Realtime stream unavailable" } }, {
    status,
    headers: { "cache-control": "private, no-store" },
  });
}
