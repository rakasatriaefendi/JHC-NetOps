import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadRunnerConfig } from "../src/config.mjs";
import { buildSnmpInvocation } from "../src/wsl.mjs";

function loadConfig(overrides = {}) {
  const example = JSON.parse(readFileSync(new URL("../config.example.json", import.meta.url), "utf8"));
  const directory = mkdtempSync(path.join(os.tmpdir(), "runner-config-"));
  const configPath = path.join(directory, "config.json");
  writeFileSync(configPath, JSON.stringify({ ...example, wsl_project_root: "/mnt/c/project", ...overrides }));
  return loadRunnerConfig(configPath, "win32");
}

test("active SNMP timeout accepts bounded seconds", () => {
  assert.equal(loadConfig({ snmp_timeout_seconds: 3 }).snmp_timeout_seconds, 3);
  assert.equal(loadConfig({ snmp_timeout_seconds: 60 }).snmp_timeout_seconds, 60);
});

test("active SNMP timeout rejects invalid types and out-of-range values", () => {
  for (const snmp_timeout_seconds of ["3", 0, -1, 61]) {
    assert.throws(() => loadConfig({ snmp_timeout_seconds }), /snmp_timeout_seconds is invalid/);
  }
});

test("missing SNMP timeout preserves the existing three-second invocation default", () => {
  const config = loadConfig({ snmp_timeout_seconds: undefined });
  const target = {
    id: "11111111-1111-4111-8111-111111111111",
    node_id: "22222222-2222-4222-8222-222222222222",
    ip_address: "192.168.10.20",
    credential_profile_ref: "monitoring-readonly-v3",
    snmp_version: "3",
    snmp_port: 161,
  };
  const args = buildSnmpInvocation(config, target, { version: "3" });
  assert.equal(args[args.indexOf("--timeout") + 1], "3");
});

test("existing Windows config remains valid without native-only fields", () => {
  const config = loadConfig({ native_project_root: undefined, data_directory: undefined, log_directory: undefined });
  assert.equal(config.runtime_platform, "win32");
  assert.equal(config.agent_path, "/mnt/c/project/agent/.venv/bin/network-monitor");
});

test("SNMP configuration accepts every monitoring preset and preserves legacy lists", () => {
  for (const intervals of [[15, 30, 60, 900, 1800], [30, 60], [900], [1800]]) {
    assert.deepEqual(loadConfig({ snmp_poll_intervals_seconds: intervals }).snmp_poll_intervals_seconds, intervals);
  }
  for (const intervals of [[90], [900, 900], ["900"], [], [15, 30, 60, 900, 1800, 3600]]) {
    assert.throws(() => loadConfig({ snmp_poll_intervals_seconds: intervals }), /snmp_poll_intervals_seconds is invalid/);
  }
});

test("control-plane idle wait is capped independently of heartbeat and monitoring presets", () => {
  for (const file of ["../config.example.json", "../../deploy/runner-config.example.json"]) {
    const example = JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"));
    assert.equal(example.poll_interval_ms, 60000);
    assert.equal(example.heartbeat_interval_ms, 60000);
    assert.deepEqual(example.snmp_poll_intervals_seconds, [15, 30, 60, 900, 1800]);
  }
  for (const field of ["poll_interval_ms", "heartbeat_interval_ms"]) {
    for (const value of [1000, 60000]) assert.equal(loadConfig({ [field]: value })[field], value);
    for (const value of [999, 60001, 900000, 1800000]) assert.throws(() => loadConfig({ [field]: value }), new RegExp(`${field} is invalid`));
  }
  const main = readFileSync(new URL("../src/main.mjs", import.meta.url), "utf8");
  assert.equal(loadConfig({ poll_interval_ms: 60000 }).control_poll_interval_ms, 2000);
  assert.equal(loadConfig({ poll_interval_ms: 1000 }).control_poll_interval_ms, 1000);
  assert.equal(loadConfig({ poll_interval_ms: 60000, heartbeat_interval_ms: 60000 }).heartbeat_interval_ms, 60000);
  assert.match(main, /legacyIntervalMs: config\.control_poll_interval_ms/);
  assert.match(main, /await runControlPlane\(/);
  const control = readFileSync(new URL("../src/control-plane.mjs", import.meta.url), "utf8");
  assert.match(control, /await execute\[kind\]\(claimed\)/, "long Traffic remains serial, not a parallel probe loop");
  assert.match(main, /config\.heartbeat_interval_ms/);
  assert.doesNotMatch(main, /monitoring-modes|monitoring-intervals|900_?000|1800_?000/);
});
