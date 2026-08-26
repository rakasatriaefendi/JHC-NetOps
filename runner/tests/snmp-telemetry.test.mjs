import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { managedTelemetryPublishError } from "../src/backend.mjs";
import { counterDelta, ManagedTelemetryWatch, simpleDelta, validTelemetryTarget } from "../src/snmp-telemetry.mjs";
import { buildSnmpInvocation, validateTelemetryEvent, validateTelemetryPayload } from "../src/wsl.mjs";

const TARGET_ID = "11111111-1111-4111-8111-111111111111";
const NODE_ID = "22222222-2222-4222-8222-222222222222";

function config(overrides = {}) {
  return {
    runner_id: "runner-test",
    snmp_timeout_seconds: 3,
    snmp_credential_profiles: {
      "monitoring-readonly-v3": { version: "3", username: "monitor", auth_protocol: "SHA256", auth_password: "auth-secret", priv_protocol: "AES128", priv_password: "priv-secret" },
      "monitoring-readonly-v2c": { version: "2c", community: "readonly-community" },
    },
    ...overrides,
  };
}

function target(overrides = {}) {
  return {
    id: TARGET_ID,
    node_id: NODE_ID,
    runner_id: "runner-test",
    enabled: true,
    credential_profile_ref: "monitoring-readonly-v3",
    snmp_version: "3",
    snmp_port: 161,
    poll_interval_seconds: 60,
    ip_address: "192.168.10.20",
    oper_error_threshold: 5,
    discard_threshold: 10,
    util_warning_percent: 80,
    util_critical_percent: 95,
    util_sustained_seconds: 300,
    ...overrides,
  };
}

function interfaceSample(overrides = {}) {
  return { if_index: 1, name: "Gi1/0/1", description: "uplink", if_type: 6, is_physical: true,
    admin_status: "up", oper_status: "up", speed_bps: 1_000_000_000, if_high_speed_mbps: 1000,
    in_octets: 0, out_octets: 0, in_discards: 0, out_discards: 0, in_errors: 0, out_errors: 0, ...overrides };
}

function payload(device = {}, interfaces = [interfaceSample()]) {
  return {
    type: "managed_telemetry", target_id: TARGET_ID, runner_id: "runner-test", node_id: NODE_ID,
    ip_address: "192.168.10.20", credential_profile_ref: "monitoring-readonly-v3", snmp_version: "3",
    device: { status: "connected", sys_name: "switch-01", sys_descr: "Vendor Switch", sys_object_id: "1.3.6.1.4.1.9",
      uptime_seconds: 100, manufacturer: "Vendor", model: "S300", serial_number: "ABC123", last_polled_at: null,
      error: null, error_category: null, ...device },
    interfaces,
  };
}

function watch(overrides = {}) {
  const defaults = { runnerId: "runner-test", backend: {
    managedTelemetryTargets: async () => ({ targets: [] }), publishManagedTelemetry: async () => ({}),
  }, config: config(), cachePath: path.join(mkdtempSync(path.join(os.tmpdir(), "snmp-telemetry-")), "state.json"), now: () => 1_000 };
  return new ManagedTelemetryWatch({ ...defaults, ...overrides });
}

test("counterDelta returns deltas, null on reset, and supports 32-bit wrap", () => {
  assert.equal(counterDelta(100, 500), 400);
  assert.equal(counterDelta(null, 500), null);
  assert.equal(counterDelta(500, null), null);
  assert.equal(counterDelta(500, 400), null);
  assert.equal(counterDelta(0xFFFFFFF0, 5), 21);
  assert.equal(counterDelta(-1, 5), null);
  assert.equal(counterDelta(5, -1), null);
});

test("simpleDelta returns deltas and null when the counter decreases", () => {
  assert.equal(simpleDelta(10, 25), 15);
  assert.equal(simpleDelta(25, 10), null);
  assert.equal(simpleDelta(null, 10), null);
  assert.equal(simpleDelta(10, null), null);
});

test("validTelemetryTarget enforces the local execution authority", () => {
  const good = target();
  assert.equal(validTelemetryTarget(good, config()), true);
  assert.equal(validTelemetryTarget({ ...good, id: "not-a-uuid" }, config()), false);
  assert.equal(validTelemetryTarget({ ...good, runner_id: "other-runner" }, config()), false);
  assert.equal(validTelemetryTarget({ ...good, enabled: false }, config()), false);
  assert.equal(validTelemetryTarget({ ...good, ip_address: "8.8.8.8" }, config()), false);
  assert.equal(validTelemetryTarget({ ...good, ip_address: "hostname" }, config()), false);
  assert.equal(validTelemetryTarget({ ...good, node_id: "bad" }, config()), false);
  assert.equal(validTelemetryTarget({ ...good, snmp_version: "1" }, config()), false);
  assert.equal(validTelemetryTarget({ ...good, snmp_port: 99999 }, config()), false);
  assert.equal(validTelemetryTarget({ ...good, poll_interval_seconds: 120 }, config()), false);
  assert.equal(validTelemetryTarget({ ...good, util_sustained_seconds: 30 }, config()), false);
  assert.equal(validTelemetryTarget({ ...good, credential_profile_ref: "missing-profile" }, config()), false);
  assert.equal(validTelemetryTarget({ ...good, snmp_version: "2c", credential_profile_ref: "monitoring-readonly-v2c" }, config()), true);
});

test("first sample produces no rates or deltas", () => {
  const service = watch();
  const item = target();
  service.targets.set(item.id, item);
  const first = payload({ uptime_seconds: 100 }, [interfaceSample({ in_octets: 1_000_000_000, out_octets: 2_000_000_000 })]);
  service.applyResult(item, first, 1_000);
  const row = service.states[item.id].interfaces[0];
  assert.equal(row.rx_rate_bps, null);
  assert.equal(row.tx_rate_bps, null);
  assert.equal(row.rx_util_percent, null);
  assert.equal(row.rx_errors_delta, null);
  assert.equal(row.rx_errors_cumulative, 0);
});

test("two valid samples compute bps and utilization correctly", () => {
  const service = watch();
  const item = target();
  service.targets.set(item.id, item);
  const first = payload({ uptime_seconds: 100 }, [interfaceSample({ in_octets: 100_000_000, out_octets: 0 })]);
  service.applyResult(item, first, 1_000);
  const second = payload({ uptime_seconds: 200 }, [interfaceSample({ in_octets: 100_000_000 + 125_000_000, out_octets: 0 })]);
  service.applyResult(item, second, 2_000);
  const row = service.states[item.id].interfaces[0];
  assert.equal(row.rx_rate_bps, 1_000_000_000);
  assert.equal(row.rx_util_percent, 100);
  assert.equal(row.tx_rate_bps, 0);
  assert.equal(row.rx_errors_delta, 0);
});

test("speed change raises a speed_changed event", () => {
  const service = watch();
  const item = target();
  service.targets.set(item.id, item);
  service.applyResult(item, payload({ uptime_seconds: 100 }, [interfaceSample({ speed_bps: 1_000_000_000, in_octets: 0 })]), 1_000);
  service.applyResult(item, payload({ uptime_seconds: 200 }, [interfaceSample({ speed_bps: 100_000_000, in_octets: 1_000 })]), 2_000);
  const events = service.pendingEvents.map((event) => event.kind);
  assert.deepEqual(events, ["speed_changed"]);
  assert.equal(service.pendingEvents[0].source_ref, item.id);
});

test("oper status down and recovery raise interface events", () => {
  const service = watch();
  const item = target();
  service.targets.set(item.id, item);
  service.applyResult(item, payload({ uptime_seconds: 100 }, [interfaceSample({ oper_status: "up", in_octets: 0 })]), 1_000);
  service.applyResult(item, payload({ uptime_seconds: 200 }, [interfaceSample({ oper_status: "down", in_octets: 0 })]), 2_000);
  service.applyResult(item, payload({ uptime_seconds: 300 }, [interfaceSample({ oper_status: "up", in_octets: 0 })]), 3_000);
  assert.deepEqual(service.pendingEvents.map((event) => event.kind), ["interface_down", "interface_up"]);
  assert.deepEqual(service.pendingEvents.map((event) => event.severity), ["high", "low"]);
});

test("error and discard deltas above threshold raise events", () => {
  const service = watch();
  const item = target();
  service.targets.set(item.id, item);
  service.applyResult(item, payload({ uptime_seconds: 100 }, [interfaceSample({ in_errors: 0, out_discards: 0, in_octets: 0 })]), 1_000);
  service.applyResult(item, payload({ uptime_seconds: 200 }, [interfaceSample({ in_errors: 12, out_discards: 30, in_octets: 0 })]), 2_000);
  const kinds = service.pendingEvents.map((event) => event.kind).sort();
  assert.deepEqual(kinds, ["discards_threshold", "errors_threshold"]);
  const row = service.states[item.id].interfaces[0];
  assert.equal(row.rx_errors_delta, 12);
  assert.equal(row.out_discards_delta, 30);
});

test("device reboot invalidates deltas and re-establishes the baseline", () => {
  const service = watch();
  const item = target();
  service.targets.set(item.id, item);
  service.applyResult(item, payload({ uptime_seconds: 100 }, [interfaceSample({ in_octets: 100_000_000 })]), 1_000);
  service.applyResult(item, payload({ uptime_seconds: 30, status: "connected" }, [interfaceSample({ in_octets: 500_000_000 })]), 2_000);
  const row = service.states[item.id].interfaces[0];
  assert.equal(row.rx_rate_bps, null);
  assert.equal(row.rx_util_percent, null);
  assert.equal(row.rx_errors_delta, null);
});

test("counter reset invalidates the rate but the next sample uses the new baseline", () => {
  const service = watch();
  const item = target();
  service.targets.set(item.id, item);
  service.applyResult(item, payload({ uptime_seconds: 100 }, [interfaceSample({ in_octets: 1_000_000_000, out_octets: 0 })]), 1_000);
  service.applyResult(item, payload({ uptime_seconds: 200 }, [interfaceSample({ in_octets: 10, out_octets: 0 })]), 2_000);
  assert.equal(service.states[item.id].interfaces[0].rx_rate_bps, null);
  service.applyResult(item, payload({ uptime_seconds: 300 }, [interfaceSample({ in_octets: 10 + 125_000_000, out_octets: 0 })]), 3_000);
  assert.equal(service.states[item.id].interfaces[0].rx_rate_bps, 1_000_000_000);
});

test("sustained high utilization raises an event after the hysteresis window", () => {
  const service = watch();
  const item = target({ util_critical_percent: 90, util_warning_percent: 80, util_sustained_seconds: 60 });
  service.targets.set(item.id, item);
  const octets = [0, 3_600_000_000, 7_200_000_000, 10_800_000_000, 14_400_000_000];
  for (let i = 0; i < octets.length; i += 1) {
    service.applyResult(item, payload({ uptime_seconds: 100 + i * 30 }, [interfaceSample({ in_octets: octets[i], out_octets: 0 })]), i * 30_000);
  }
  const kinds = service.pendingEvents.map((event) => event.kind);
  assert.equal(kinds.includes("utilization_high"), true);
  assert.deepEqual(kinds.filter((kind) => kind !== "utilization_high"), []);
});

test("failed publish retains latest state and events with backoff", async () => {
  let attempts = 0;
  const logs = [];
  const service = watch({
    backend: { managedTelemetryTargets: async () => ({ targets: [] }),
      publishManagedTelemetry: async () => {
        attempts += 1;
        throw managedTelemetryPublishError(400, { code: "PAYLOAD_INVALID", error: "Managed telemetry payload is invalid", raw: "community=do-not-log" });
      } },
    log: (message) => logs.push(message),
  });
  const item = target();
  service.targets.set(item.id, item);
  service.applyResult(item, payload({ uptime_seconds: 100 }, [interfaceSample({ in_octets: 0 })]), 1_000);
  await service.publish(2_000);
  assert.equal(attempts, 1);
  assert.equal(service.states[item.id].dirty, true);
  assert.equal(service.retryAt, 7_000);
  assert.equal(service.publishBackoffMs, 10_000);
  assert.match(logs[0], /code=MANAGED_TELEMETRY_PUBLISH_FAILED status=400 backend_code=PAYLOAD_INVALID/);
  assert.match(logs[0], /backend_message="Managed telemetry payload is invalid"/);
  assert.doesNotMatch(logs[0], /community|do-not-log/i);
});

test("auth failure produces auth_failed device state and category", () => {
  const service = watch();
  const item = target();
  service.targets.set(item.id, item);
  service.applyResult(item, payload({ status: "auth_failed", error: "Authentication failed", error_category: "auth_failure" }, []), 1_000);
  const state = service.states[item.id].device;
  assert.equal(state.status, "auth_failed");
  assert.equal(state.error_category, "auth_failure");
  assert.equal(state.consecutive_poll_failures, 1);
  service.applyResult(item, payload({}, []), 2_000);
  assert.equal(service.states[item.id].device.consecutive_poll_failures, 0);
});

test("cached approved targets survive restart during backend outage", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "snmp-telemetry-"));
  const cachePath = path.join(directory, "state.json");
  const first = new ManagedTelemetryWatch({ runnerId: "runner-test", backend: {
    managedTelemetryTargets: async () => ({ targets: [target()] }), publishManagedTelemetry: async () => ({}),
  }, config: config(), cachePath });
  await first.refreshTargets(1_000);
  const restarted = new ManagedTelemetryWatch({ runnerId: "runner-test", backend: {
    managedTelemetryTargets: async () => { throw new Error("offline"); }, publishManagedTelemetry: async () => ({}),
  }, config: config(), cachePath });
  assert.deepEqual([...restarted.targets.keys()], [target().id]);
  await restarted.refreshTargets(2_000);
  assert.deepEqual([...restarted.targets.keys()], [target().id]);
});

test("agent timeout maps to timeout status, protocol error to poll_failed", async () => {
  const service = watch({ runAgent: async () => { throw Object.assign(new Error("timeout"), { code: "SNMP_TIMEOUT" }); } });
  const item = target();
  service.targets.set(item.id, item);
  await service.poll(item);
  assert.equal(service.states[item.id].device.status, "timeout");
  const service2 = watch({ runAgent: async () => { throw Object.assign(new Error("protocol"), { code: "AGENT_PROTOCOL_ERROR" }); } });
  service2.targets.set(item.id, item);
  await service2.poll(item);
  assert.equal(service2.states[item.id].device.status, "poll_failed");
});

test("missing credential profile marks the target not_configured without invoking the agent", async () => {
  let calls = 0;
  const service = watch({ runAgent: async () => { calls += 1; throw new Error("must not run"); } });
  const item = target({ credential_profile_ref: "missing-profile" });
  service.targets.set(item.id, item);
  await service.poll(item);
  assert.equal(calls, 0);
  assert.equal(service.states[item.id].device.status, "not_configured");
  assert.equal(service.states[item.id].device.error_category, "agent_error");
});

test("publish payload never contains credential values", async () => {
  let published = null;
  const service = watch({ backend: {
    managedTelemetryTargets: async () => ({ targets: [] }),
    publishManagedTelemetry: async (runnerId, device, interfaces) => { published = { device, interfaces }; },
  } });
  const item = target();
  service.targets.set(item.id, item);
  service.applyResult(item, payload({ uptime_seconds: 100 }, [interfaceSample({ in_octets: 0 })]), 1_000);
  await service.publish(2_000);
  const encoded = JSON.stringify(published);
  assert.doesNotMatch(encoded, /auth-secret/, "secret should NOT appear");
  assert.doesNotMatch(encoded, /priv-secret/, "secret should NOT appear");
  assert.equal(encoded.includes("community"), false);
  assert.equal(encoded.includes("password"), false);
  assert.equal(published.device.target_id, item.id);
  assert.equal(published.interfaces[0].target_id, item.id);
});

test("snmp invocation is fixed, bounded, and carries only expected args", () => {
  const cfg = { wsl_distro: "Ubuntu-22.04", agent_path: "agent/.venv/bin/network-monitor", runner_id: "runner-test", snmp_timeout_seconds: 3 };
  const item = target();
  const v3 = buildSnmpInvocation(cfg, item, { version: "3", username: "monitor", auth_protocol: "SHA256", auth_password: "auth-secret", priv_protocol: "AES128", priv_password: "priv-secret" });
  assert.deepEqual(v3.slice(0, 4), ["-d", "Ubuntu-22.04", "--exec", "agent/.venv/bin/network-monitor"]);
  assert.equal(v3[4], "managed-telemetry-poll");
  assert.ok(v3.includes("--target-id"));
  assert.ok(v3.includes("--snmp-version"));
  assert.ok(v3.includes("--username"));
  assert.ok(v3.includes("--auth-password"));
  assert.ok(v3.includes("auth-secret"));
  const v2c = buildSnmpInvocation(cfg, { ...item, snmp_version: "2c", credential_profile_ref: "monitoring-readonly-v2c" }, { version: "2c", community: "readonly-community" });
  assert.ok(v2c.includes("--community"));
  assert.ok(v2c.includes("readonly-community"));
  assert.equal(v2c.includes("--username"), false);
  assert.equal(v2c.includes("--auth-password"), false);
});

test("telemetry payload validation enforces a strict schema and rejects oversize", () => {
  const good = payload();
  assert.equal(validateTelemetryPayload(good).device.status, "connected");
  assert.throws(() => validateTelemetryPayload({ ...good, target_id: "bad" }));
  assert.throws(() => validateTelemetryPayload({ ...good, device: { ...good.device, status: "weird" } }));
  assert.throws(() => validateTelemetryPayload({ ...good, interfaces: [interfaceSample({ if_index: -1 })] }));
  assert.throws(() => validateTelemetryPayload({ ...good, interfaces: [interfaceSample({ speed_bps: -1 })] }));
  const tooMany = { ...good, interfaces: Array.from({ length: 201 }, () => interfaceSample()) };
  assert.throws(() => validateTelemetryPayload(tooMany));
});

test("telemetry event validation accepts poll lifecycle events", () => {
  assert.deepEqual(validateTelemetryEvent({ type: "poll_start", host: "192.168.10.20" }), { type: "poll_start" });
  assert.deepEqual(validateTelemetryEvent({ type: "poll_complete", interface_count: 24 }), { type: "poll_complete", interface_count: 24 });
  assert.deepEqual(validateTelemetryEvent({ type: "poll_error", category: "auth_failure", message: "nope" }), { type: "poll_error", category: "auth_failure" });
  assert.throws(() => validateTelemetryEvent({ type: "poll_start" }));
  assert.throws(() => validateTelemetryEvent({ type: "arbitrary" }));
  assert.throws(() => validateTelemetryEvent({ type: "error" }));
});
