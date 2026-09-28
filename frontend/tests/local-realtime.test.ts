import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const { createLocalRealtimeProxy } = await import("../lib/local-realtime-route.ts");

test("same-origin realtime proxy rejects an unauthenticated browser before backend access", async () => {
  let backendCalls = 0;
  const handler = createLocalRealtimeProxy({
    authenticate: async () => false,
    backend: () => ({ origin: "http://127.0.0.1:3402", token: "s".repeat(32) }),
    fetchImpl: async () => { backendCalls += 1; throw new Error("must not run"); },
  });
  const response = await handler(new Request("https://netops.example.test/api/realtime/events"));
  assert.equal(response.status, 401);
  assert.equal(backendCalls, 0);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
});

test("proxy keeps loopback credentials server-side and returns only bounded SSE output", async () => {
  const token = "secret-backend-token-never-exposed";
  let requestedUrl = "";
  let authorization = "";
  const handler = createLocalRealtimeProxy({
    authenticate: async () => true,
    backend: () => ({ origin: "http://127.0.0.1:3402", token }),
    fetchImpl: async (input, init) => {
      requestedUrl = String(input);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return new Response('event: invalidation\ndata: {"version":1,"topic":"sync"}\n\n', {
        headers: { "content-type": "text/event-stream; charset=utf-8", "x-backend-secret": token },
      });
    },
  });
  const response = await handler(new Request("https://netops.example.test/api/realtime/events"));
  assert.equal(response.status, 200);
  assert.equal(requestedUrl, "http://127.0.0.1:3402/api/realtime/events");
  assert.equal(authorization, `Bearer ${token}`);
  const browserOutput = `${[...response.headers].flat().join(" ")} ${await response.text()}`;
  assert.doesNotMatch(browserOutput, /127\.0\.0\.1|secret-backend-token|x-backend-secret|Bearer/i);
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
});

test("proxy cancellation aborts and releases the upstream SSE reader", async () => {
  let upstreamAborted = false;
  let upstreamCancelled = false;
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('event: invalidation\ndata: {"topic":"sync"}\n\n'));
    },
    cancel() { upstreamCancelled = true; },
  });
  const handler = createLocalRealtimeProxy({
    authenticate: async () => true,
    backend: () => ({ origin: "http://127.0.0.1:3402", token: "s".repeat(32) }),
    fetchImpl: async (_input, init) => {
      init?.signal?.addEventListener("abort", () => { upstreamAborted = true; }, { once: true });
      return new Response(upstream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  const response = await handler(new Request("https://netops.example.test/api/realtime/events"));
  assert.ok(response.body);
  const reader = response.body.getReader();
  assert.equal((await reader.read()).done, false);
  await reader.cancel("browser disconnected");
  assert.equal(upstreamAborted, true);
  assert.equal(upstreamCancelled, true);
});

test("proxy terminates the downstream stream on a genuine upstream failure", async () => {
  let upstreamAborted = false;
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) { controller.error(new Error("private upstream failure")); },
  });
  const handler = createLocalRealtimeProxy({
    authenticate: async () => true,
    backend: () => ({ origin: "http://127.0.0.1:3402", token: "s".repeat(32) }),
    fetchImpl: async (_input, init) => {
      init?.signal?.addEventListener("abort", () => { upstreamAborted = true; }, { once: true });
      return new Response(upstream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  const response = await handler(new Request("https://netops.example.test/api/realtime/events"));
  assert.ok(response.body);
  await assert.rejects(() => response.body!.getReader().read(), /Realtime upstream stream failed/);
  assert.equal(upstreamAborted, true);
});

test("Next realtime route uses existing approved profile auth and server-only backend configuration", () => {
  const route = readFileSync(new URL("../app/api/realtime/events/route.ts", import.meta.url), "utf8");
  assert.match(route, /normalizedProfile\(await localAuthenticatedProfile\(\)\)/);
  assert.doesNotMatch(route, /supabase\.auth\.|getClaims\(\)/);
  assert.match(route, /profile\?\.status === "approved"/);
  assert.match(route, /applicationAuthority\(\) === "local_postgres"/);
  assert.match(route, /localBackendConfig\(\)/);
  assert.doesNotMatch(route, /LOCAL_BACKEND_(?:URL|TOKEN)|127\.0\.0\.1|Bearer /);
});
