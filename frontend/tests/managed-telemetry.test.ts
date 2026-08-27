import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  credentialProfileStatus,
  formatDateTime,
  formatRate,
  formatUptime,
  formatUtil,
  ifNameLabel,
  interfaceSummary,
  interfaceWarnings,
  managedSystemIdentityFields,
  validateManagedTelemetryForm,
} from "../lib/managed-telemetry.ts";

const baseInterface = {
  target_id: "t",
  if_index: 1,
  name: "Gi0/1",
  description: null,
  if_type: 6,
  is_physical: true,
  admin_status: "up" as const,
  oper_status: "up" as const,
  speed_bps: 1_000_000_000,
  rx_rate_bps: null,
  tx_rate_bps: null,
  rx_util_percent: null,
  tx_util_percent: null,
  rx_errors_cumulative: null,
  tx_errors_cumulative: null,
  in_discards_cumulative: null,
  out_discards_cumulative: null,
  rx_errors_delta: null,
  tx_errors_delta: null,
  in_discards_delta: null,
  out_discards_delta: null,
  last_polled_at: null,
  updated_at: "2026-01-01T00:00:00Z",
};

const baseDevice = {
  target_id: "target-1",
  status: "connected" as const,
  sys_name: "kali-snmp-lab",
  sys_descr: "Linux lab host",
  sys_object_id: "1.3.6.1.4.1.8072.3.2.10",
  uptime_seconds: 90061,
  manufacturer: null,
  model: null,
  serial_number: null,
  last_polled_at: "2026-01-01T00:00:00Z",
  last_success_at: "2026-01-01T00:00:00Z",
  consecutive_poll_failures: 0,
  error_category: null,
  updated_at: "2026-01-01T00:00:00Z",
};

test("managed system identity renders the persisted System Object ID", () => {
  assert.deepEqual(managedSystemIdentityFields(baseDevice), [
    { label: "sysName", value: "kali-snmp-lab", data: true },
    { label: "sysDescr", value: "Linux lab host", data: false },
    {
      label: "System Object ID",
      value: "1.3.6.1.4.1.8072.3.2.10",
      data: true,
    },
  ]);
});

test("managed system identity renders a safe unavailable value for a null System Object ID", () => {
  const fields = managedSystemIdentityFields({
    ...baseDevice,
    sys_object_id: null,
  });
  assert.deepEqual(fields.find((field) => field.label === "System Object ID"), {
    label: "System Object ID",
    value: "—",
    data: true,
  });
  assert.equal(fields.find((field) => field.label === "sysName")?.value, baseDevice.sys_name);
  assert.equal(fields.find((field) => field.label === "sysDescr")?.value, baseDevice.sys_descr);
});

test("managed system identity keeps the existing responsive Device Profile layout", () => {
  const component = readFileSync(
    new URL(
      "../components/device-profile/managed-telemetry-section.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(component, /<details className="mt-3 rounded-control border border-border bg-bg-base p-3 text-meta">/);
  assert.match(component, /<dl className="mt-3 grid gap-2 sm:grid-cols-2">/);
  assert.match(component, /managedSystemIdentityFields\(device\)\.map/);
});

test("interfaceSummary distinguishes likely physical ports from logical interfaces", () => {
  const logical = { ...baseInterface, if_index: 4096, name: "Vlan10", is_physical: false };
  const summary = interfaceSummary([
    { ...baseInterface, if_index: 1, oper_status: "up" },
    { ...baseInterface, if_index: 2, oper_status: "down" },
    { ...baseInterface, if_index: 3, oper_status: "up", rx_errors_delta: 2 },
    { ...baseInterface, if_index: 4, oper_status: "up", in_discards_delta: 5 },
    logical,
  ]);
  assert.equal(summary.total, 5);
  assert.equal(summary.physical, 4);
  assert.equal(summary.logical, 1);
  assert.equal(summary.physical_up, 3);
  assert.equal(summary.physical_down, 1);
  assert.equal(summary.physical_errors, 1);
  assert.equal(summary.physical_discards, 1);
});

test("interfaceWarnings emits cautious wording only", () => {
  const thresholds = { oper_error_threshold: 5, discard_threshold: 10, util_warning_percent: 80, util_critical_percent: 95, util_sustained_seconds: 300 };
  const down = { ...baseInterface, admin_status: "up" as const, oper_status: "down" as const };
  assert.deepEqual(interfaceWarnings(down, thresholds, []), ["Possible link issue"]);
  const errors = { ...baseInterface, rx_errors_delta: 1 };
  assert.deepEqual(interfaceWarnings(errors, thresholds, []), ["Increasing errors"]);
  const discards = { ...baseInterface, in_discards_delta: 1 };
  assert.deepEqual(interfaceWarnings(discards, thresholds, []), ["Increasing discards"]);
  const hot = { ...baseInterface, rx_util_percent: 97 };
  assert.deepEqual(interfaceWarnings(hot, thresholds, []), ["High utilization"]);
  const quiet = interfaceWarnings(baseInterface, thresholds, []);
  assert.deepEqual(quiet, []);
  assert.equal(interfaceWarnings(baseInterface, null, []).length, 0);
});

test("interfaceWarnings shows Speed changed only from a matching event", () => {
  const thresholds = { oper_error_threshold: 5, discard_threshold: 10, util_warning_percent: 80, util_critical_percent: 95, util_sustained_seconds: 300 };
  const event = { id: "e1", created_at: "2026-01-01T00:00:00Z", severity: "medium" as const, title: "Speed changed", description: null, source_ref: "t", resolved_at: null, raw_context: { kind: "speed_changed", if_index: 1 } };
  assert.deepEqual(interfaceWarnings(baseInterface, thresholds, [event]), ["Speed changed"]);
  const otherIndex = { ...event, raw_context: { kind: "speed_changed", if_index: 2 } };
  assert.deepEqual(interfaceWarnings(baseInterface, thresholds, [otherIndex]), []);
});

test("formatRate renders Gbps/Mbps/kbps/bps and a dash for null or negative", () => {
  assert.equal(formatRate(null), "—");
  assert.equal(formatRate(-1), "—");
  assert.equal(formatRate(1_500_000_000), "1.5 Gbps");
  assert.equal(formatRate(1_000_000), "1 Mbps");
  assert.equal(formatRate(1500), "1.5 kbps");
  assert.equal(formatRate(42), "42 bps");
});

test("formatUtil renders a dash for null and never a misleading 0%", () => {
  assert.equal(formatUtil(null), "—");
  assert.equal(formatUtil(0), "0%");
  assert.equal(formatUtil(12.5), "12.5%");
});

test("formatUptime renders days/hours/minutes and a dash for null", () => {
  assert.equal(formatUptime(null), "—");
  assert.equal(formatUptime(90), "1m");
  assert.equal(formatUptime(3725), "1h 2m");
  assert.equal(formatUptime(90061), "1d 1h 1m");
});

test("formatDateTime renders a dash for null and invalid dates", () => {
  assert.equal(formatDateTime(null), "—");
  assert.equal(formatDateTime("not-a-date"), "—");
  assert.match(formatDateTime("2026-01-02T03:04:05Z"), /2026|2025|Jan/i);
});

test("ifNameLabel prefers the interface name and falls back to ifIndex", () => {
  assert.equal(ifNameLabel(baseInterface), "Gi0/1");
  assert.equal(ifNameLabel({ ...baseInterface, name: null }), "ifIndex 1");
});

test("credentialProfileStatus reflects only profile availability, never secrets", () => {
  assert.equal(credentialProfileStatus(undefined, undefined), "unknown");
  assert.equal(credentialProfileStatus(["a", "b"], "c"), "unavailable");
  assert.equal(credentialProfileStatus(["a", "b"], "a"), "available");
});

test("validateManagedTelemetryForm accepts a valid form", () => {
  assert.equal(validateManagedTelemetryForm(validForm()), null);
});

test("validateManagedTelemetryForm rejects bad nodes, runners, profiles, version, port, and interval", () => {
  assert.match(validateManagedTelemetryForm({ ...validForm(), node_id: "not-a-uuid" }) ?? "", /node/i);
  assert.match(validateManagedTelemetryForm({ ...validForm(), runner_id: "BAD RUNNER!" }) ?? "", /runner/i);
  assert.match(validateManagedTelemetryForm({ ...validForm(), credential_profile_ref: "bad profile!" }) ?? "", /profile/i);
  assert.match(validateManagedTelemetryForm({ ...validForm(), snmp_version: "1" }) ?? "", /version/i);
  assert.match(validateManagedTelemetryForm({ ...validForm(), snmp_port: 0 }) ?? "", /port/i);
  assert.match(validateManagedTelemetryForm({ ...validForm(), poll_interval_seconds: 90 }) ?? "", /interval/i);
});

test("validateManagedTelemetryForm bounds thresholds and requires critical > warning", () => {
  assert.match(validateManagedTelemetryForm({ ...validForm(), oper_error_threshold: 0 }) ?? "", /threshold/i);
  assert.match(validateManagedTelemetryForm({ ...validForm(), discard_threshold: 999 }) ?? "", /threshold/i);
  assert.match(validateManagedTelemetryForm({ ...validForm(), util_warning_percent: 0 }) ?? "", /warning/i);
  assert.match(validateManagedTelemetryForm({ ...validForm(), util_critical_percent: 101 }) ?? "", /critical/i);
  assert.match(validateManagedTelemetryForm({ ...validForm(), util_sustained_seconds: 30 }) ?? "", /sustained/i);
  assert.match(validateManagedTelemetryForm({ ...validForm(), util_critical_percent: 50, util_warning_percent: 80 }) ?? "", /warning/i);
});

function validForm() {
  return {
    node_id: "a1b2c3d4-e5f6-4789-8abc-def012345678",
    runner_id: "local-runner",
    credential_profile_ref: "monitoring-readonly",
    snmp_version: "3",
    snmp_port: 161,
    poll_interval_seconds: 60,
    oper_error_threshold: 5,
    discard_threshold: 10,
    util_warning_percent: 80,
    util_critical_percent: 95,
    util_sustained_seconds: 300,
  };
}
