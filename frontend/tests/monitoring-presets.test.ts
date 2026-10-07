import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DEFAULT_MONITORING_INTERVAL, intervalForMode, isMonitoringInterval, monitoringMode,
  MONITORING_INTERVALS } from "../lib/monitoring-modes.ts";
import { MutationGate } from "../lib/mutation-feedback.ts";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("monitoring modes derive only from existing interval; new targets default Moderate", () => {
  assert.deepEqual(MONITORING_INTERVALS, [15, 30, 60, 900, 1800]);
  assert.equal(DEFAULT_MONITORING_INTERVAL, 900);
  for (const interval of [15, 30, 60]) assert.equal(monitoringMode(interval), "aggressive");
  assert.equal(monitoringMode(900), "moderate");
  assert.equal(monitoringMode(1800), "resource_saver");
  assert.equal(monitoringMode(45), null); // Legacy Health records are not relabelled or rewritten.
  assert.equal(intervalForMode("moderate"), 900);
  assert.equal(intervalForMode("resource_saver"), 1800);
  assert.equal(intervalForMode("aggressive"), 60);
  assert.equal(intervalForMode("aggressive", 15), 15);
  assert.equal(intervalForMode("aggressive", 30), 30);
  assert.equal(intervalForMode("aggressive", 900), 60);
  for (const value of ["900", 45, 90, null]) assert.equal(isMonitoringInterval(value), false);
});

test("shared accessible selector offers three modes, only aggressive has 15/30/60 choices", () => {
  const ui = source("../components/monitoring-mode-selector.tsx");
  assert.match(ui, /currentInterval = DEFAULT_MONITORING_INTERVAL/);
  assert.match(ui, /if \(!editable\) return <MonitoringModeLabel interval=\{currentInterval\}/);
  assert.match(ui, /fieldset disabled=\{pending\}/);
  assert.match(ui, /\["aggressive", "moderate", "resource_saver"\]/);
  assert.match(ui, /type="button" aria-pressed=\{mode === value\}/);
  assert.match(ui, /intervalForMode\(value, aggressive\)/);
  assert.match(ui, /mode === "aggressive" \?[\s\S]*<label htmlFor=\{id\}[\s\S]*<select id=\{id\}/);
  assert.match(ui, /\[15, 30, 60\]\.map/);
  assert.match(ui, /<input type="hidden" name=\{name\} value=\{interval\}/);
  assert.doesNotMatch(ui, /name="(?:mode|monitoring_mode)"/);
  assert.match(ui, /monitoring\.legacyHelp/);
});

test("presets stay on existing Devices and SNMP target forms, with readonly mode labels", () => {
  const health = source("../components/devices/device-inventory.tsx");
  const snmp = source("../components/admin/managed-telemetry-targets.tsx");
  const page = source("../app/(protected)/snmp/page.tsx");
  assert.match(health, /MonitoringModeSelector currentInterval=\{target\?\.probe_interval_seconds \?\? 900\} name="probe_interval_seconds"/);
  assert.match(health, /MonitoringModeLabel interval=\{target\.probe_interval_seconds\}/);
  assert.match(snmp, /MonitoringModeSelector currentInterval=\{target\?\.poll_interval_seconds \?\? 900\} name="poll_interval_seconds"/);
  assert.match(snmp, /MonitoringModeLabel interval=\{target\.poll_interval_seconds\}/);
  assert.match(page, /canManage=\{!portable\.enabled && profile\.role === "admin"\}/);
  assert.match(page, /canChangeInterval=\{!portable\.enabled && canOperateNetwork\(profile\.role\)\}/);
  assert.match(snmp, /canChangeInterval && intervalTarget[\s\S]*MutationForm key=\{intervalTarget\.id\} action=\{setManagedTelemetryIntervalAction\} kind="update"/);
  const intervalForm = snmp.slice(snmp.indexOf("<MutationForm key={intervalTarget.id}"), snmp.indexOf("{canManage && editingTarget"));
  assert.match(intervalForm, /name="target_id"[\s\S]*name="poll_interval_seconds"[\s\S]*PendingSubmit/);
  assert.doesNotMatch(intervalForm, /credential_profile_ref|snmp_version|snmp_port|name="enabled"/);
  assert.match(snmp, /canManage \? <>[\s\S]*deleteManagedTelemetryTargetAction/);
  assert.doesNotMatch(source("../app/(protected)/admin/page.tsx"), /MonitoringModeSelector|ManagedTelemetryTargets/);
});

test("SNMP interval server action allows no sensitive fields and verifies authoritative value before success", () => {
  const actions = source("../app/actions/snmp.ts");
  assert.match(actions, /POLLING_FIELDS = new Set\(\["target_id", "poll_interval_seconds"\]\)/);
  const action = actions.slice(actions.indexOf("export async function setManagedTelemetryIntervalAction"), actions.indexOf("function runnerCredentialProfiles"));
  const write = action.indexOf('localApplicationRequest("PATCH"');
  const verify = action.indexOf("await localManagedTarget(targetId)");
  const success = action.indexOf("return { ok: true, changed: result.changed }");
  assert.ok(write > 0 && verify > write && success > verify);
  assert.ok(action.indexOf("await requireOperatorProfile()") < write);
  assert.ok(action.indexOf("hasUnexpectedFormFields(formData, POLLING_FIELDS)") < write);
  assert.match(action, /formData\.getAll\(field\)\.length !== 1/);
  assert.match(action, /UUID_PATTERN\.test\(targetId\).*isMonitoringInterval\(interval\)/);
  assert.match(action, /actor_id: userId, poll_interval_seconds: interval/);
  assert.match(action, /current\.id !== targetId \|\| Number\(current\.poll_interval_seconds\) !== interval/);
  assert.match(action, /typeof result\.changed !== "boolean"/);
  assert.doesNotMatch(action, /credential_profile_ref|community|password|snmp_port|\.\.\.formData/);
  const fullSave = actions.slice(actions.indexOf("export async function saveManagedTelemetryTargetAction"), actions.indexOf("export async function deleteManagedTelemetryTargetAction"));
  const fullDelete = actions.slice(actions.indexOf("export async function deleteManagedTelemetryTargetAction"), actions.indexOf("export async function setManagedTelemetryIntervalAction"));
  assert.match(fullSave, /await requireAdminProfile\(\)/);
  assert.match(fullDelete, /await requireAdminProfile\(\)/);
  const health = source("../app/actions/devices.ts");
  assert.match(health, /isMonitoringInterval\(values\.probe_interval_seconds\)/);
  assert.match(health, /await localHealthTargets\(\)[\s\S]*return \{ ok: true, changed: data\.changed \}/);
});

test("preset forms reuse the mutation gate: duplicate blocked, one terminal notice, no-op silent", async () => {
  const gate = new MutationGate();
  const notifications: { success: boolean; code?: string }[] = [];
  const notify = (success: boolean, code?: string) => notifications.push({ success, ...(code ? { code } : {}) });
  let finish!: () => void;
  const verification = new Promise<void>((resolve) => { finish = resolve; });
  let calls = 0;
  const first = gate.run(async () => { calls += 1; await verification; return { ok: true, changed: true }; }, notify);
  assert.equal(await gate.run(async () => { calls += 1; return { ok: true }; }, notify), false);
  assert.equal(calls, 1);
  assert.equal(notifications.length, 0); // Includes waiting for authoritative verification.
  finish();
  assert.equal(await first, true);
  assert.deepEqual(notifications, [{ success: true }]);
  await gate.run(async () => ({ ok: true, changed: false }), notify);
  assert.equal(notifications.length, 1);
  await gate.run(async () => ({ ok: false, code: "refresh-failed" }), notify);
  assert.deepEqual(notifications, [{ success: true }, { success: false, code: "refresh-failed" }]);
  await gate.run(async () => ({ ok: true, changed: true }), notify);
  assert.equal(notifications.length, 3); // Failed attempt released pending state.
});

test("EN and ID monitoring copy is paired, including fixed intervals and operational warnings", () => {
  const en = JSON.parse(source("../i18n/en/common.json")).monitoring;
  const id = JSON.parse(source("../i18n/id/common.json")).monitoring;
  assert.deepEqual(Object.keys(en).sort(), Object.keys(id).sort());
  for (const key of ["modes", "intervals", "help"]) assert.deepEqual(Object.keys(en[key]).sort(), Object.keys(id[key]).sort());
  assert.deepEqual(Object.keys(en.intervals).sort(), ["15", "30", "60", "900", "1800"].sort());
  assert.equal(en.intervals[900], "15 minutes");
  assert.equal(id.intervals[1800], "30 menit");
  assert.match(en.help.aggressive, /temporarily/i);
  assert.match(id.help.aggressive, /sementara/i);
});
