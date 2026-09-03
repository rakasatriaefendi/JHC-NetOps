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
