import assert from "node:assert/strict";
import test from "node:test";

import {
  BackendClient,
  managedTelemetryPublishDiagnostic,
  managedTelemetryPublishError,
} from "../src/backend.mjs";

const DEVICE = { target_id: "11111111-1111-4111-8111-111111111111", status: "connected" };

test("managed telemetry publish success remains unchanged", async (t) => {
  let request = null;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    request = JSON.parse(options.body);
    return new Response(JSON.stringify({ data: { devices: 1, interfaces: 0, events: 0 } }), { status: 200 });
  });
  const client = new BackendClient("https://example.invalid", "test-service-key");
  const result = await client.publishManagedTelemetry("runner-test", DEVICE, [], []);
  assert.deepEqual(result, { devices: 1, interfaces: 0, events: 0 });
  assert.deepEqual(request, { action: "publish", runner_id: "runner-test", device: DEVICE, interfaces: [], transitions: [] });
});

test("managed telemetry 4xx preserves bounded safe status and backend code", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    code: "INTERFACE_PAYLOAD_INVALID",
    error: "Managed telemetry interface payload is invalid",
  }), { status: 400 }));
  const client = new BackendClient("https://example.invalid", "test-service-key");
  await assert.rejects(
    client.publishManagedTelemetry("runner-test", DEVICE, [], []),
    (error) => {
      assert.equal(error.code, "MANAGED_TELEMETRY_PUBLISH_FAILED");
      assert.equal(error.status, 400);
      assert.equal(error.backendCode, "INTERFACE_PAYLOAD_INVALID");
      assert.equal(error.backendMessage, "Managed telemetry interface payload is invalid");
      return true;
    },
  );
});

test("managed telemetry 5xx preserves bounded safe status and category", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    category: "device_upsert_failed",
    error: "Latest managed device state could not be stored",
  }), { status: 500 }));
  const client = new BackendClient("https://example.invalid", "test-service-key");
  await assert.rejects(
    client.publishManagedTelemetry("runner-test", DEVICE, [], []),
    (error) => error.status === 500 && error.backendCode === "device_upsert_failed",
  );
});

test("arbitrary response content is not surfaced", () => {
  const error = managedTelemetryPublishError(400, {
    error: "arbitrary raw backend response",
    debug: { request_body: DEVICE, stack: "private internals" },
  });
  const diagnostic = managedTelemetryPublishDiagnostic(error);
  assert.equal(diagnostic, "code=MANAGED_TELEMETRY_PUBLISH_FAILED status=400");
  assert.doesNotMatch(error.message, /arbitrary|request_body|private internals/);
  assert.equal("payload" in error, false);
});

test("secret-shaped backend content is not surfaced", () => {
  const error = managedTelemetryPublishError(403, {
    code: "COMMUNITY_SECRET_INVALID",
    error: "community=private-value authorization=Bearer private-token",
  });
  const diagnostic = managedTelemetryPublishDiagnostic(error);
  assert.equal(diagnostic, "code=MANAGED_TELEMETRY_PUBLISH_FAILED status=403");
  assert.doesNotMatch(`${error.message} ${diagnostic}`, /private-value|private-token|community|authorization|bearer/i);
});
