import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { validateSnmpTelemetryCapability } from "../../supabase/functions/diagnostic-jobs/capabilities.ts";

const valid = () => ({
  enabled: true,
  max_concurrent: 2,
  poll_intervals_seconds: [30, 60],
  versions: ["3", "2c"],
  credential_profiles: ["monitoring-readonly-v3"],
});

test("diagnostic-jobs accepts and normalizes the runner SNMP telemetry capability", () => {
  assert.deepEqual(validateSnmpTelemetryCapability(valid()), { ok: true, value: valid() });
  assert.equal(validateSnmpTelemetryCapability({ ...valid(), credential_profiles: [] }).ok, true);
  assert.deepEqual(validateSnmpTelemetryCapability({ enabled: false }), { ok: true, value: { enabled: false } });
});

test("diagnostic-jobs keeps missing SNMP telemetry backward compatible", () => {
  assert.deepEqual(validateSnmpTelemetryCapability(undefined), { ok: true, value: undefined });
});

test("diagnostic-jobs rejects a non-boolean enabled flag", () => {
  assert.equal(validateSnmpTelemetryCapability({ ...valid(), enabled: "true" }).ok, false);
});

test("diagnostic-jobs rejects invalid SNMP concurrency bounds", () => {
  for (const max of [0, 6, 1.5, "2"]) {
    assert.equal(validateSnmpTelemetryCapability({ ...valid(), max_concurrent: max }).ok, false);
  }
});

test("diagnostic-jobs rejects unsupported or duplicate polling intervals", () => {
  assert.equal(validateSnmpTelemetryCapability({ ...valid(), poll_intervals_seconds: [15] }).ok, false);
  assert.equal(validateSnmpTelemetryCapability({ ...valid(), poll_intervals_seconds: [30, 30] }).ok, false);
});

test("diagnostic-jobs rejects unsupported or duplicate SNMP versions", () => {
  assert.equal(validateSnmpTelemetryCapability({ ...valid(), versions: ["1"] }).ok, false);
  assert.equal(validateSnmpTelemetryCapability({ ...valid(), versions: ["3", "3"] }).ok, false);
});

test("diagnostic-jobs rejects unsafe or oversized credential profile references", () => {
  assert.equal(validateSnmpTelemetryCapability({ ...valid(), credential_profiles: ["contains spaces"] }).ok, false);
  assert.equal(validateSnmpTelemetryCapability({ ...valid(), credential_profiles: [`a${"b".repeat(64)}`] }).ok, false);
  assert.equal(validateSnmpTelemetryCapability({ ...valid(), credential_profiles: ["same", "same"] }).ok, false);
});

test("diagnostic-jobs rejects secret-shaped and arbitrary capability keys", () => {
  assert.equal(validateSnmpTelemetryCapability({ ...valid(), community: "public" }).ok, false);
  assert.equal(validateSnmpTelemetryCapability({ enabled: false, auth_password: "secret" }).ok, false);
  assert.equal(validateSnmpTelemetryCapability({ ...valid(), credentials: { username: "operator" } }).ok, false);
});

test("missing SNMP telemetry does not change existing normalized capabilities", () => {
  const existing = { source_locations: ["Office"], operations: ["bandwidth_and_path"] };
  const result = validateSnmpTelemetryCapability(undefined);
  assert.equal(result.ok, true);
  const normalized = { ...existing, ...(result.ok && result.value ? { snmp_telemetry: result.value } : {}) };
  assert.deepEqual(normalized, existing);
});

test("diagnostic-jobs persists only the normalized SNMP telemetry capability", () => {
  const source = readFileSync(new URL("../../supabase/functions/diagnostic-jobs/index.ts", import.meta.url), "utf8");
  assert.match(source, /const snmpTelemetry = validateSnmpTelemetryCapability\(value\.snmp_telemetry\)/);
  assert.match(source, /\.\.\.\(snmpTelemetry\.value \? \{ snmp_telemetry: snmpTelemetry\.value \} : \{\}\)/);
});
