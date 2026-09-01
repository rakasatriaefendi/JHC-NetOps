import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { managedTelemetryPublishError } from "../src/backend.mjs";
import { counterDelta, ManagedTelemetryWatch, nextNetbiosCursor, simpleDelta, validTelemetryTarget } from "../src/snmp-telemetry.mjs";
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
    name: "Core Switch",
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
    in_octets: 0, out_octets: 0, in_discards: 0, out_discards: 0, in_errors: 0, out_errors: 0,
    in_octets_bits: 64, out_octets_bits: 64, in_discards_bits: 32, out_discards_bits: 32,
    in_errors_bits: 32, out_errors_bits: 32, ...overrides };
}

function payload(device = {}, interfaces = [interfaceSample()]) {
  return {
    type: "managed_telemetry", target_id: TARGET_ID, runner_id: "runner-test", node_id: NODE_ID,
    ip_address: "192.168.10.20", credential_profile_ref: "monitoring-readonly-v3", snmp_version: "3",
    device: { status: "connected", sys_name: "switch-01", sys_descr: "Vendor Switch", sys_object_id: "1.3.6.1.4.1.9",
      uptime_seconds: 100, manufacturer: "Vendor", model: "S300", serial_number: "ABC123", last_polled_at: null,
      error: null, error_category: null, observed_hosts_status: "empty", ...device },
    interfaces,
    observed_hosts: [],
  };
}

function watch(overrides = {}) {
  const defaults = { runnerId: "runner-test", backend: {
    managedTelemetryTargets: async () => ({ targets: [] }), publishManagedTelemetry: async () => ({}),
  }, config: config(), cachePath: path.join(mkdtempSync(path.join(os.tmpdir(), "snmp-telemetry-")), "state.json"), now: () => 1_000 };
  return new ManagedTelemetryWatch({ ...defaults, ...overrides });
}

test("counterDelta returns deltas, null on reset, and supports 32-bit wrap", () => {
  assert.equal(counterDelta(100, 500, 64), 400);
  assert.equal(counterDelta(100, 500, 32), 400);
  assert.equal(counterDelta(null, 500, 32), null);
  assert.equal(counterDelta(500, null, 32), null);
  assert.equal(counterDelta(500, 400, 32), null);
  assert.equal(counterDelta(0xFFFFFFF0, 5, 32), 21);
  assert.equal(counterDelta(0xFFFFFFF0, 5, 64), null);
  assert.equal(counterDelta(0xEFFFFFFF, 5, 32), null);
  assert.equal(counterDelta(-1, 5, 32), null);
  assert.equal(counterDelta(5, -1, 32), null);
});

test("simpleDelta returns deltas and null when the counter decreases", () => {
  assert.equal(simpleDelta(10, 25), 15);
  assert.equal(simpleDelta(25, 10), null);
  assert.equal(simpleDelta(null, 10), null);
  assert.equal(simpleDelta(10, null), null);
});

test("NetBIOS cursor advances by one bounded batch and adapts to list changes", () => {
  const hosts = Array.from({ length: 40 }, (_, index) => ({ ip_address: `192.168.10.${index + 1}` }));
  assert.equal(nextNetbiosCursor(0, hosts), 16);
  assert.equal(nextNetbiosCursor(16, hosts), 32);
  assert.equal(nextNetbiosCursor(32, hosts), 8);
  assert.equal(nextNetbiosCursor(32, hosts.slice(0, 18)), 12);
  assert.equal(nextNetbiosCursor(99, []), 0);
});

test("NetBIOS cursor is persisted per target in the existing bounded runner cache", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "snmp-telemetry-"));
  const cachePath = path.join(directory, "state.json");
  const service = watch({ cachePath });
  const item = target();
  const result = payload({ observed_hosts_status: "partial" });
  result.observed_hosts = Array.from({ length: 40 }, (_, index) => ({
    ip_address: `192.168.10.${index + 1}`,
    mac_address: null,
    netbios_name: null,
    observation_source: "ip_net_to_physical",
    enrichment_status: index < 16 ? "unavailable" : "not_attempted",
  }));
  service.targets.set(item.id, item);
  service.applyResult(item, result, 1_000, 0);
  assert.equal(service.states[item.id].netbiosCursor, 16);

  const restarted = watch({ cachePath });
  assert.equal(restarted.states[item.id].netbiosCursor, 16);
});

test("subsequent managed telemetry polls pass the advanced NetBIOS offset to the agent", async () => {
  const offsets = [];
  const service = watch({
    runAgent: async (_config, _target, _creds, onEvent, _timeoutMs, netbiosOffset) => {
      offsets.push(netbiosOffset);
      const result = payload({ observed_hosts_status: "partial" });
      result.observed_hosts = Array.from({ length: 40 }, (_, index) => ({
        ip_address: `192.168.10.${index + 1}`,
        mac_address: null,
        netbios_name: null,
        observation_source: "ip_net_to_physical",
        enrichment_status: "not_attempted",
      }));
      onEvent({ type: "telemetry_result", payload: result });
    },
  });
  const item = target();
  service.targets.set(item.id, item);

  await service.poll(item);
  await service.poll(item);

  assert.deepEqual(offsets, [0, 16]);
  assert.equal(service.states[item.id].netbiosCursor, 32);
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
  assert.equal(validTelemetryTarget({ ...good, snmp_version: "3", credential_profile_ref: "monitoring-readonly-v2c" }, config()), true);
  assert.equal(validTelemetryTarget({ ...good, snmp_version: "2c", credential_profile_ref: "monitoring-readonly-v3" }, config()), true);
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

test("Counter32 octets calculate normally and a plausible wrap stays bounded", () => {
  const service = watch();
  const item = target();
  service.targets.set(item.id, item);
  const sample = (in_octets) => interfaceSample({ in_octets, out_octets: 0, in_octets_bits: 32, out_octets_bits: 32 });
  service.applyResult(item, payload({ uptime_seconds: 100 }, [sample(1_000)]), 1_000);
  service.applyResult(item, payload({ uptime_seconds: 101 }, [sample(2_000)]), 2_000);
  assert.equal(service.states[item.id].interfaces[0].rx_rate_bps, 8_000);
  service.applyResult(item, payload({ uptime_seconds: 102 }, [sample(0xFFFFFFF0)]), 3_000);
  assert.equal(service.states[item.id].interfaces[0].rx_rate_bps, null);
  service.applyResult(item, payload({ uptime_seconds: 103 }, [sample(5)]), 4_000);
  assert.equal(service.states[item.id].interfaces[0].rx_rate_bps, 168);
});

test("Counter64 decrease is a reset and the following compatible sample uses the fresh baseline", () => {
  const service = watch();
  const item = target();
  service.targets.set(item.id, item);
  service.applyResult(item, payload({ uptime_seconds: 100 }, [interfaceSample({ in_octets: 9_000_000_000 })]), 1_000);
  service.applyResult(item, payload({ uptime_seconds: 101 }, [interfaceSample({ in_octets: 50 })]), 2_000);
  assert.equal(service.states[item.id].interfaces[0].rx_rate_bps, null);
  service.applyResult(item, payload({ uptime_seconds: 102 }, [interfaceSample({ in_octets: 1_050 })]), 3_000);
  assert.equal(service.states[item.id].interfaces[0].rx_rate_bps, 8_000);
});

test("clearly impossible speed-relative rate is unavailable instead of clamped", () => {
  const service = watch();
  const item = target();
  service.targets.set(item.id, item);
  service.applyResult(item, payload({ uptime_seconds: 100 }, [interfaceSample({ speed_bps: 100_000_000, in_octets: 0 })]), 1_000);
  service.applyResult(item, payload({ uptime_seconds: 101 }, [interfaceSample({ speed_bps: 100_000_000, in_octets: 30_000_000 })]), 2_000);
  const row = service.states[item.id].interfaces[0];
  assert.equal(row.rx_rate_bps, null);
  assert.equal(row.rx_util_percent, null);
});

test("minor speed mismatch preserves rate but leaves invalid utilization unavailable", () => {
  const service = watch();
  const item = target();
  service.targets.set(item.id, item);
  service.applyResult(item, payload({ uptime_seconds: 100 }, [interfaceSample({ speed_bps: 100_000_000, in_octets: 0 })]), 1_000);
  service.applyResult(item, payload({ uptime_seconds: 101 }, [interfaceSample({ speed_bps: 100_000_000, in_octets: 13_750_000 })]), 2_000);
  const row = service.states[item.id].interfaces[0];
  assert.equal(row.rx_rate_bps, 110_000_000);
  assert.equal(row.rx_util_percent, null);
});

test("missing speed preserves a valid rate but leaves utilization unavailable", () => {
  const service = watch();
  const item = target();
  service.targets.set(item.id, item);
  service.applyResult(item, payload({ uptime_seconds: 100 }, [interfaceSample({ speed_bps: null, in_octets: 100 })]), 1_000);
  service.applyResult(item, payload({ uptime_seconds: 101 }, [interfaceSample({ speed_bps: null, in_octets: 1_100 })]), 2_000);
  const row = service.states[item.id].interfaces[0];
  assert.equal(row.rx_rate_bps, 8_000);
  assert.equal(row.rx_util_percent, null);
});

test("stale baseline and old cache shape are conservatively replaced", () => {
  const service = watch();
  const item = target({ poll_interval_seconds: 30 });
  service.targets.set(item.id, item);
  service.applyResult(item, payload({ uptime_seconds: 100 }, [interfaceSample({ in_octets: 100 })]), 1_000);
  service.applyResult(item, payload({ uptime_seconds: 200 }, [interfaceSample({ in_octets: 1_100 })]), 92_000);
  assert.equal(service.states[item.id].interfaces[0].rx_rate_bps, null);
  service.states[item.id].counters[1] = { in_octets: 1_100, out_octets: 0, ts: 92_000 };
  service.applyResult(item, payload({ uptime_seconds: 201 }, [interfaceSample({ in_octets: 2_100 })]), 93_000);
  assert.equal(service.states[item.id].interfaces[0].rx_rate_bps, null);
});

test("ifIndex reuse with changed identity does not reuse counters or create speed events", () => {
  const service = watch();
  const item = target();
  service.targets.set(item.id, item);
  service.applyResult(item, payload({ uptime_seconds: 100 }, [interfaceSample({ name: "Gi1/0/1", description: "uplink", in_octets: 100 })]), 1_000);
  service.applyResult(item, payload({ uptime_seconds: 101 }, [interfaceSample({ name: "Vlan20", description: "users", if_type: 53, is_physical: false, speed_bps: 100_000_000, in_octets: 10_000 })]), 2_000);
  const row = service.states[item.id].interfaces[0];
  assert.equal(row.rx_rate_bps, null);
  assert.equal(row.name, "Vlan20");
  assert.equal(row.is_physical, false);
  assert.equal(service.pendingEvents.some((event) => event.kind === "speed_changed"), false);
});

test("interface disappearance removes its baseline before reappearance", () => {
  const service = watch();
  const item = target();
  service.targets.set(item.id, item);
  service.applyResult(item, payload({ uptime_seconds: 100 }, [interfaceSample({ in_octets: 100 })]), 1_000);
  service.applyResult(item, payload({ uptime_seconds: 101 }, []), 2_000);
  assert.equal(service.states[item.id].counters[1], undefined);
  service.applyResult(item, payload({ uptime_seconds: 102 }, [interfaceSample({ in_octets: 100_000 })]), 3_000);
  assert.equal(service.states[item.id].interfaces[0].rx_rate_bps, null);
});

test("speed change raises a speed_changed event", () => {
  const service = watch();
  const item = target();
  service.targets.set(item.id, item);
  service.applyResult(item, payload({ uptime_seconds: 100 }, [interfaceSample({ speed_bps: 1_000_000_000, in_octets: 0 })]), 1_000);
  service.applyResult(item, payload({ uptime_seconds: 200 }, [interfaceSample({ speed_bps: 100_000_000, in_octets: 1_000 })]), 2_000);
  const events = service.pendingEvents.map((event) => event.kind);
  assert.deepEqual(events, ["speed_changed"]);
  assert.equal(service.pendingEvents[0].target_id, item.id);
  service.applyResult(item, payload({ uptime_seconds: 300 }, [interfaceSample({ speed_bps: 100_000_000, in_octets: 2_000 })]), 3_000);
  assert.deepEqual(service.pendingEvents.map((event) => event.kind), ["speed_changed"]);
});

test("reboot does not create speed_changed even when the reported speed changes", () => {
  const service = watch();
  const item = target();
  service.targets.set(item.id, item);
  service.applyResult(item, payload({ uptime_seconds: 100 }, [interfaceSample({ speed_bps: 1_000_000_000 })]), 1_000);
  service.applyResult(item, payload({ uptime_seconds: 10 }, [interfaceSample({ speed_bps: 100_000_000 })]), 2_000);
  assert.equal(service.pendingEvents.some((event) => event.kind === "speed_changed"), false);
});

test("interface down is debounced, deduplicated, and recovers only after becoming active", () => {
  const service = watch();
  const item = target();
  service.targets.set(item.id, item);
  service.applyResult(item, payload({ uptime_seconds: 100 }, [interfaceSample({ oper_status: "up", in_octets: 0 })]), 1_000);
  service.applyResult(item, payload({ uptime_seconds: 200 }, [interfaceSample({ oper_status: "down", in_octets: 0 })]), 2_000);
  assert.deepEqual(service.pendingEvents, []);
  service.applyResult(item, payload({ uptime_seconds: 300 }, [interfaceSample({ oper_status: "down", in_octets: 0 })]), 3_000);
  service.applyResult(item, payload({ uptime_seconds: 400 }, [interfaceSample({ oper_status: "down", in_octets: 0 })]), 4_000);
  service.applyResult(item, payload({ uptime_seconds: 500 }, [interfaceSample({ oper_status: "up", in_octets: 0 })]), 5_000);
  service.applyResult(item, payload({ uptime_seconds: 600 }, [interfaceSample({ oper_status: "up", in_octets: 0 })]), 6_000);
  assert.deepEqual(service.pendingEvents.map((event) => event.kind), ["interface_down", "interface_up"]);
  assert.deepEqual(service.pendingEvents.map((event) => event.severity), ["high", "low"]);
});

test("admin-down and transient operational-down interfaces create no down or recovery noise", () => {
  const service = watch();
  const item = target();
  service.targets.set(item.id, item);
  service.applyResult(item, payload({ uptime_seconds: 100 }, [interfaceSample({ admin_status: "down", oper_status: "down" })]), 1_000);
  service.applyResult(item, payload({ uptime_seconds: 101 }, [interfaceSample({ admin_status: "down", oper_status: "down" })]), 2_000);
  service.applyResult(item, payload({ uptime_seconds: 102 }, [interfaceSample({ admin_status: "up", oper_status: "down" })]), 3_000);
  service.applyResult(item, payload({ uptime_seconds: 103 }, [interfaceSample({ admin_status: "up", oper_status: "up" })]), 4_000);
  assert.deepEqual(service.pendingEvents, []);
});

test("interface_up is never emitted without a previously active down condition", () => {
  const service = watch();
  const item = target();
  service.targets.set(item.id, item);
  service.applyResult(item, payload({ uptime_seconds: 100 }, [interfaceSample({ oper_status: "up" })]), 1_000);
  service.applyResult(item, payload({ uptime_seconds: 101 }, [interfaceSample({ oper_status: "up" })]), 2_000);
  assert.equal(service.pendingEvents.some((event) => event.kind === "interface_up"), false);
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

test("threshold conditions alert once, clear below threshold, and may alert on a later crossing", () => {
  const service = watch();
  const item = target({ oper_error_threshold: 5, discard_threshold: 10 });
  service.targets.set(item.id, item);
  const sample = (inErrors, outDiscards) => interfaceSample({ in_errors: inErrors, out_discards: outDiscards });
  service.applyResult(item, payload({ uptime_seconds: 100 }, [sample(0, 0)]), 1_000);
  service.applyResult(item, payload({ uptime_seconds: 101 }, [sample(10, 20)]), 2_000);
  service.applyResult(item, payload({ uptime_seconds: 102 }, [sample(20, 40)]), 3_000);
  assert.deepEqual(service.pendingEvents.map((event) => event.kind).sort(), ["discards_threshold", "errors_threshold"]);
  service.applyResult(item, payload({ uptime_seconds: 103 }, [sample(21, 41)]), 4_000);
  service.applyResult(item, payload({ uptime_seconds: 104 }, [sample(31, 61)]), 5_000);
  assert.deepEqual(service.pendingEvents.map((event) => event.kind).sort(), [
    "discards_threshold", "discards_threshold", "errors_threshold", "errors_threshold",
  ]);
});

test("null, reset, reboot, and first-sample deltas never create threshold alerts", () => {
  const service = watch();
  const item = target();
  service.targets.set(item.id, item);
  service.applyResult(item, payload({ uptime_seconds: 100 }, [interfaceSample({ in_errors: 4_000_000_000, out_discards: 4_000_000_000 })]), 1_000);
  service.applyResult(item, payload({ uptime_seconds: 101 }, [interfaceSample({ in_errors: 1, out_discards: null, out_discards_bits: null })]), 2_000);
  service.applyResult(item, payload({ uptime_seconds: 10 }, [interfaceSample({ in_errors: 1_000, out_discards: 1_000 })]), 3_000);
  assert.equal(service.pendingEvents.some((event) => ["errors_threshold", "discards_threshold"].includes(event.kind)), false);
});

test("oversized real-device discard delta becomes null while cumulative evidence is preserved", () => {
  const service = watch();
  const item = target();
  service.targets.set(item.id, item);
  service.applyResult(item, payload({ uptime_seconds: 100 }, [interfaceSample({
    if_index: 7,
    name: "LAN6/WAN1",
    out_discards: 0,
  })]), 1_000);
  service.applyResult(item, payload({ uptime_seconds: 200 }, [interfaceSample({
    if_index: 7,
    name: "LAN6/WAN1",
    out_discards: 48_916_841_399,
  })]), 61_000);

  const row = service.states[item.id].interfaces[0];
  assert.equal(row.out_discards_cumulative, 48_916_841_399);
  assert.equal(row.out_discards_delta, null);
  assert.equal(row.rx_errors_delta, 0);
  assert.equal(row.name, "LAN6/WAN1");
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
  service.applyResult(item, payload({ uptime_seconds: 31 }, [interfaceSample({ in_octets: 500_001_000 })]), 3_000);
  assert.equal(service.states[item.id].interfaces[0].rx_rate_bps, 8_000);
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

test("counter reset and missing optional counters never create negative or synthetic deltas", () => {
  const service = watch();
  const item = target();
  service.targets.set(item.id, item);
  service.applyResult(item, payload({ uptime_seconds: 100 }, [interfaceSample({ in_errors: 100, out_discards: 200 })]), 1_000);
  service.applyResult(item, payload({ uptime_seconds: 101 }, [interfaceSample({ in_errors: 1, out_discards: null, out_discards_bits: null })]), 2_000);
  const row = service.states[item.id].interfaces[0];
  assert.equal(row.rx_errors_delta, null);
  assert.equal(row.out_discards_delta, null);
  assert.equal(row.rx_errors_cumulative, 1);
  assert.equal(row.out_discards_cumulative, null);
  assert.equal(service.pendingEvents.some((event) => ["errors_threshold", "discards_threshold"].includes(event.kind)), false);
});

test("large cumulative error and discard values alone do not generate events", () => {
  const service = watch();
  const item = target();
  service.targets.set(item.id, item);
  service.applyResult(item, payload({ uptime_seconds: 100 }, [interfaceSample({ in_errors: 4_000_000_000, out_discards: 4_000_000_000 })]), 1_000);
  assert.equal(service.states[item.id].interfaces[0].rx_errors_cumulative, 4_000_000_000);
  assert.equal(service.states[item.id].interfaces[0].out_discards_cumulative, 4_000_000_000);
  assert.deepEqual(service.pendingEvents, []);
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

test("utilization requires sustained valid samples, deduplicates, and recovers once", () => {
  const service = watch();
  const item = target({ util_critical_percent: 90, util_warning_percent: 80, util_sustained_seconds: 60 });
  service.targets.set(item.id, item);
  const octets = [0, 3_600_000_000, 7_200_000_000, 10_800_000_000, 14_400_000_000, 14_400_000_000, 14_400_000_000];
  for (let index = 0; index < octets.length; index += 1) {
    service.applyResult(item, payload({ uptime_seconds: 100 + index * 30 }, [interfaceSample({ in_octets: octets[index] })]), index * 30_000);
    if (index === 1) assert.equal(service.pendingEvents.length, 0);
  }
  assert.deepEqual(service.pendingEvents.map((event) => event.kind), ["utilization_high", "utilization_recovered"]);
});

test("null utilization never starts or recovers a utilization condition", () => {
  const service = watch();
  const item = target({ util_critical_percent: 90, util_warning_percent: 80, util_sustained_seconds: 60 });
  service.targets.set(item.id, item);
  for (let index = 0; index < 5; index += 1) {
    service.applyResult(item, payload({ uptime_seconds: 100 + index * 30 }, [interfaceSample({ speed_bps: null, in_octets: index * 4_000_000_000 })]), index * 30_000);
  }
  assert.equal(service.pendingEvents.some((event) => event.kind.startsWith("utilization_")), false);
});

test("logical telemetry remains visible but threshold alerts use physical interfaces only", () => {
  const service = watch();
  const item = target({ oper_error_threshold: 5, discard_threshold: 10, util_sustained_seconds: 60 });
  service.targets.set(item.id, item);
  const samples = (errors) => [
    interfaceSample({ if_index: 1, name: "Gi1/0/1", is_physical: true, in_errors: errors }),
    interfaceSample({ if_index: 100, name: "Vlan100", if_type: 53, is_physical: false, in_errors: errors }),
  ];
  service.applyResult(item, payload({ uptime_seconds: 100 }, samples(0)), 1_000);
  service.applyResult(item, payload({ uptime_seconds: 101 }, samples(10)), 2_000);
  assert.equal(service.states[item.id].interfaces.length, 2);
  assert.equal(service.states[item.id].interfaces.some((row) => row.if_index === 100 && !row.is_physical), true);
  const errors = service.pendingEvents.filter((event) => event.kind === "errors_threshold");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].raw_context.if_index, 1);
});

test("partial telemetry evaluates valid fields without inventing missing-field alerts", () => {
  const service = watch();
  const item = target({ oper_error_threshold: 5, discard_threshold: 10 });
  service.targets.set(item.id, item);
  service.applyResult(item, payload({ status: "partial", uptime_seconds: 100 }, [interfaceSample({ in_errors: 0, out_discards: null, out_discards_bits: null })]), 1_000);
  service.applyResult(item, payload({ status: "partial", uptime_seconds: 101 }, [interfaceSample({ in_errors: 10, out_discards: null, out_discards_bits: null })]), 2_000);
  assert.deepEqual(service.pendingEvents.map((event) => event.kind), ["errors_threshold"]);
  assert.equal(service.states[item.id].device.status, "partial");
});

test("alert context is bounded to device/interface measurements and contains no credential material", () => {
  const service = watch();
  const item = target({ name: "Core Switch" });
  service.targets.set(item.id, item);
  service.applyResult(item, payload({ uptime_seconds: 100 }, [interfaceSample({ in_errors: 0 })]), 1_000);
  service.applyResult(item, payload({ uptime_seconds: 101 }, [interfaceSample({ in_errors: 10 })]), 2_000);
  const encoded = JSON.stringify(service.pendingEvents[0]);
  assert.match(encoded, /Core Switch/);
  assert.match(encoded, /Gi1\/0\/1/);
  assert.doesNotMatch(encoded, /monitoring-readonly|auth-secret|priv-secret|readonly-community|credential_profile_ref|password|community/i);
  assert.deepEqual(Object.keys(service.pendingEvents[0].raw_context).sort(), [
    "device_name", "error_delta", "if_index", "name", "target_id", "threshold",
  ]);
});

test("old runner alert cache shape is migrated safely without a second state store", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "snmp-telemetry-"));
  const cachePath = path.join(directory, "state.json");
  writeFileSync(cachePath, JSON.stringify({ version: 1, states: {
    [TARGET_ID]: { counters: {}, highUtil: { 1: { highSince: 1234, flagged: true } }, observedHosts: [] },
  }, pendingEvents: [] }));
  const service = watch({ cachePath });
  const state = service.stateFor(TARGET_ID);
  assert.equal(state.alertConditions[1].utilization.active, true);
  assert.equal(state.alertConditions[1].utilization.highSince, 1234);
  assert.equal("highUtil" in state, false);
});

test("cached alert conditions and pending events remain bounded", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "snmp-telemetry-"));
  const cachePath = path.join(directory, "state.json");
  const alertConditions = Object.fromEntries(Array.from({ length: 250 }, (_, index) => [index + 1, {
    interfaceDown: { consecutive: 99, active: true }, unknown: "discarded",
  }]));
  const pendingEvents = Array.from({ length: 150 }, (_, index) => ({ event_id: String(index) }));
  writeFileSync(cachePath, JSON.stringify({ version: 1, states: {
    [TARGET_ID]: { counters: {}, alertConditions, observedHosts: [] },
  }, pendingEvents }));
  const service = watch({ cachePath });
  const state = service.stateFor(TARGET_ID);
  assert.equal(Object.keys(state.alertConditions).length, 200);
  assert.equal(service.pendingEvents.length, 100);
  assert.deepEqual(state.alertConditions[1].interfaceDown, { consecutive: 2, active: true });
  assert.equal("unknown" in state.alertConditions[1], false);
});

test("managed alerting source has no current-network CIDR or subnet-scanning assumption", () => {
  const source = readFileSync(new URL("../src/snmp-telemetry.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /192\.168\.1\.0\/24|192\.168\.188\.0\/24|current Wi-?Fi|subnet scan/i);
  assert.match(source, /target\.ip_address/);
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

test("normalized agent failure statuses remain distinguishable in runner state", () => {
  for (const [status, category] of [
    ["timeout", "timeout"],
    ["unreachable", "unreachable"],
    ["unsupported", "unsupported"],
    ["poll_failed", "agent_error"],
  ]) {
    const service = watch();
    const item = target();
    service.targets.set(item.id, item);
    service.applyResult(item, payload({ status, error: "safe failure", error_category: category }, []), 1_000);
    assert.equal(service.states[item.id].device.status, status);
    assert.equal(service.states[item.id].device.error_category, category);
  }
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

test("credential profile version mismatch fails safely without invoking the agent", async () => {
  for (const item of [
    target({ snmp_version: "3", credential_profile_ref: "monitoring-readonly-v2c" }),
    target({ snmp_version: "2c", credential_profile_ref: "monitoring-readonly-v3" }),
  ]) {
    let calls = 0;
    const service = watch({ runAgent: async () => { calls += 1; throw new Error("must not run"); } });
    service.targets.set(item.id, item);
    await service.poll(item);
    assert.equal(calls, 0);
    assert.equal(service.states[item.id].device.status, "not_configured");
    assert.equal(service.states[item.id].device.error, "Managed telemetry target and credential profile versions do not match");
    assert.doesNotMatch(service.states[item.id].device.error, /community|username|password|secret/i);
  }
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
  assert.equal(v3[v3.indexOf("--netbios-offset") + 1], "0");
  const rotated = buildSnmpInvocation(cfg, item, { version: "3" }, 48);
  assert.equal(rotated[rotated.indexOf("--netbios-offset") + 1], "48");
  const bounded = buildSnmpInvocation(cfg, item, { version: "3" }, 999);
  assert.equal(bounded[bounded.indexOf("--netbios-offset") + 1], "0");
  const v2c = buildSnmpInvocation(cfg, { ...item, snmp_version: "2c", credential_profile_ref: "monitoring-readonly-v2c" }, { version: "2c", community: "readonly-community" });
  assert.ok(v2c.includes("--community"));
  assert.ok(v2c.includes("readonly-community"));
  assert.equal(v2c.includes("--username"), false);
  assert.equal(v2c.includes("--auth-password"), false);
});

test("telemetry payload validation enforces a strict schema and rejects oversize", () => {
  const good = payload();
  const validated = validateTelemetryPayload(good);
  assert.equal(validated.device.status, "connected");
  assert.equal(validated.interfaces[0].in_octets_bits, 64);
  assert.equal(validated.interfaces[0].in_errors_bits, 32);
  assert.throws(() => validateTelemetryPayload({ ...good, target_id: "bad" }));
  assert.throws(() => validateTelemetryPayload({ ...good, device: { ...good.device, status: "weird" } }));
  assert.throws(() => validateTelemetryPayload({ ...good, interfaces: [interfaceSample({ if_index: -1 })] }));
  assert.throws(() => validateTelemetryPayload({ ...good, interfaces: [interfaceSample({ speed_bps: -1 })] }));
  assert.throws(() => validateTelemetryPayload({ ...good, interfaces: [interfaceSample({ in_octets_bits: 48 })] }));
  const tooMany = { ...good, interfaces: Array.from({ length: 201 }, () => interfaceSample()) };
  assert.throws(() => validateTelemetryPayload(tooMany));
  const withHost = { ...good, device: { ...good.device, observed_hosts_status: "partial" }, observed_hosts: [{
    ip_address: "192.168.10.25", mac_address: "00:11:22:33:44:55", netbios_name: "HOST-25",
    observation_source: "ip_net_to_physical", enrichment_status: "resolved",
  }] };
  assert.equal(validateTelemetryPayload(withHost).observed_hosts[0].netbios_name, "HOST-25");
  assert.throws(() => validateTelemetryPayload({ ...withHost, observed_hosts: [{ ...withHost.observed_hosts[0], ip_address: "8.8.8.8" }] }));
  assert.throws(() => validateTelemetryPayload({ ...withHost, observed_hosts: [{ ...withHost.observed_hosts[0], mac_address: "00:00:00:00:00:00" }] }));
});

test("observed hosts flow through the latest-state publish without credential material", async () => {
  let published = null;
  const service = watch({ backend: {
    managedTelemetryTargets: async () => ({ targets: [] }),
    publishManagedTelemetry: async (_runnerId, device, _interfaces, _events, observedHosts) => { published = { device, observedHosts }; },
  } });
  const item = target();
  const result = payload({ observed_hosts_status: "partial" });
  result.observed_hosts = [{ ip_address: "192.168.10.25", mac_address: "00:11:22:33:44:55", netbios_name: null,
    observation_source: "ip_net_to_physical", enrichment_status: "unavailable" }];
  service.targets.set(item.id, item);
  service.applyResult(item, result, 1_000);
  await service.publish(2_000);
  assert.equal(published.device.observed_hosts_status, "partial");
  assert.deepEqual(published.observedHosts, [{ ...result.observed_hosts[0], target_id: TARGET_ID }]);
  assert.doesNotMatch(JSON.stringify(published), /community|auth_password|priv_password/i);
});

test("telemetry event validation accepts poll lifecycle events", () => {
  assert.deepEqual(validateTelemetryEvent({ type: "poll_start", host: "192.168.10.20" }), { type: "poll_start" });
  assert.deepEqual(validateTelemetryEvent({ type: "poll_complete", interface_count: 24 }), { type: "poll_complete", interface_count: 24 });
  assert.deepEqual(validateTelemetryEvent({ type: "poll_error", category: "auth_failure", message: "nope" }), { type: "poll_error", category: "auth_failure" });
  assert.throws(() => validateTelemetryEvent({ type: "poll_start" }));
  assert.throws(() => validateTelemetryEvent({ type: "arbitrary" }));
  assert.throws(() => validateTelemetryEvent({ type: "error" }));
});
