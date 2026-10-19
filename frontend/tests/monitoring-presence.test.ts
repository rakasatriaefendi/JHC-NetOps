import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { isMonitoringLive, parseMonitoringRuntime } from "../lib/monitoring-runtime.ts";
import { createLocalRealtimeProxy } from "../lib/local-realtime-route.ts";

test("presence proxy forwards HttpOnly session only upstream, preserves cancellation and never exposes secrets", async () => {
  const sessionToken = "p".repeat(43); const token = "backend-private-test";
  const handler = createLocalRealtimeProxy({ authenticate: async () => true,
    backend: () => ({ origin: "http://127.0.0.1:3402", token }),
    upstream: async () => ({ path: "/api/application/presence", sessionToken }),
    fetchImpl: async (url, init) => {
      assert.equal(String(url), "http://127.0.0.1:3402/api/application/presence");
      assert.equal(new Headers(init?.headers).get("x-netops-session"), sessionToken);
      return new Response('event: runtime\ndata: {"state":"STANDBY","monitoring":false,"control":"websocket"}\n\n', { headers: { "content-type": "text/event-stream" } });
    },
  });
  const response = await handler(new Request("https://netops.example/api/realtime/presence"));
  const text = await response.text();
  assert.doesNotMatch(text + [...response.headers].join(), /127\.0\.0\.1|Bearer|backend-private|ppppppp/);
  assert.match(text, /STANDBY/);
});
test("presence refuses missing approved session before upstream connection", async () => {
  let called = false;
  const handler = createLocalRealtimeProxy({ authenticate: async () => true,
    backend: () => ({ origin: "http://127.0.0.1:3402", token: "test" }), upstream: async () => null,
    fetchImpl: async () => { called = true; throw new Error("unexpected"); } });
  assert.equal((await handler(new Request("https://netops.example/api/realtime/presence"))).status, 401);
  assert.equal(called, false);
});
test("runtime metadata is bounded invalidation/policy only, paused states cannot be presented as live", () => {
  assert.equal(parseMonitoringRuntime("invalid"), null);
  assert.equal(parseMonitoringRuntime("x".repeat(513)), null);
  assert.equal(parseMonitoringRuntime(JSON.stringify({ state: "STANDBY", monitoring: false, control: "websocket", token: "forbidden" })), null);
  for (const state of ["STANDBY", "ACTIVATING", "ACTIVE", "DRAINING", "DEGRADED"]) {
    const runtime = parseMonitoringRuntime(JSON.stringify({ state, monitoring: state === "ACTIVE", control: "websocket" }));
    assert.equal(runtime?.state, state);
    assert.equal(isMonitoringLive(runtime), state === "ACTIVE");
  }
  assert.equal(isMonitoringLive(null), false);
  assert.equal(isMonitoringLive({ state: "ACTIVE", monitoring: false, control: "websocket" }), false);
  assert.equal(isMonitoringLive({ state: "ACTIVE", monitoring: true, control: "degraded" }), false);
  const source = readFileSync(new URL("../components/monitoring-presence.tsx", import.meta.url), "utf8");
  assert.match(source, /isMonitoringLive\(state\)/);
  assert.match(source, /visibilitychange/); assert.match(source, /stream\?\.close\(\)/);
  assert.match(source, /disposed \|\| stream !== source/);
  assert.doesNotMatch(source, /setInterval|router\.refresh|fetch\(/);
  const layout = readFileSync(new URL("../app/(protected)/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /requireApprovedProfile/); assert.equal((layout.match(/<MonitoringPresence/g) ?? []).length, 1);
  assert.match(layout, /<MonitoringPresence>\{children\}<\/MonitoringPresence>/);
  for (const path of ["../components/dashboard/network-health-dashboard.tsx", "../components/device-profile/managed-telemetry-section.tsx"]) {
    const component = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(component, /useMonitoringRuntime\(\)/);
    assert.match(component, /isMonitoringLive\(runtime\)/);
    assert.match(component, /monitoringRuntime\.notLive/);
    assert.match(component, /monitoringRuntime\.lastObservation/);
  }
  const discovery = readFileSync(new URL("../components/dashboard/network-discovery-drawer.tsx", import.meta.url), "utf8");
  const scan = readFileSync(new URL("../components/assets/asset-scan-control.tsx", import.meta.url), "utf8");
  const diagnostics = readFileSync(new URL("../components/diagnostics/one-click-diagnostics.tsx", import.meta.url), "utf8");
  assert.match(discovery, /if \(!open \|\| !visible\) return/);
  assert.match(discovery, /if \(!open \|\| !visible \|\| runnerAuthority/);
  assert.match(scan, /if \(!running \|\| !visible\) return/);
  assert.match(diagnostics, /if \(!visible \|\| !canOperateNetwork\(role\)/);
});
