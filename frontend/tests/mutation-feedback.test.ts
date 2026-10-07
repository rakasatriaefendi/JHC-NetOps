import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { MutationGate } from "../lib/mutation-feedback.ts";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("synchronous mutation gate rejects same-tick duplicates; exactly one success after authoritative refresh", async () => {
  const gate = new MutationGate();
  let finish!: () => void;
  const refreshed = new Promise<void>((resolve) => { finish = resolve; });
  let invocations = 0;
  const notifications: boolean[] = [];
  const first = gate.run(async () => { invocations += 1; await refreshed; return { ok: true }; }, (ok) => notifications.push(ok));
  assert.equal(await gate.run(async () => { invocations += 1; return { ok: true }; }, (ok) => notifications.push(ok)), false);
  assert.equal(invocations, 1);
  assert.deepEqual(notifications, []);
  finish();
  assert.equal(await first, true);
  assert.deepEqual(notifications, [true]);
});

test("mutation or required refresh failure gives one error, no success; guard is released; no-op stays silent", async () => {
  const gate = new MutationGate();
  const notifications: boolean[] = [];
  const feedback = (ok: boolean) => { notifications.push(ok); };
  assert.equal(await gate.run(async () => ({ ok: false, code: "refresh-failed" }), feedback), false);
  assert.equal(await gate.run(async () => { throw new Error("private backend details must not escape"); }, feedback), false);
  assert.equal(await gate.run(async () => ({ ok: true, changed: false }), feedback), true);
  assert.deepEqual(notifications, [false, false]);
  assert.equal(await gate.run(async () => ({ ok: true }), feedback), true);
  assert.deepEqual(notifications, [false, false, true]);
});

test("mutation forms retain safe inputs on failure, confirm before invoking and expose accessible localized pending controls", () => {
  const form = source("../components/ui/mutation-form.tsx");
  assert.match(form, /if \(submitting\.current\)/);
  assert.match(form, /onSubmit\?\.\(event\)[\s\S]*event\.defaultPrevented[\s\S]*new FormData\(event\.currentTarget\)/);
  assert.match(form, /gate\.current\.run\(\(\) => action\(data\)/);
  assert.doesNotMatch(form, /\.reset\(|router\.push\(|redirect\(/);
  assert.match(form, /finally \{ submitting\.current = false; setPending\(false\); \}/);
  assert.match(form, /disabled=\{disabled \|\| pending\} aria-disabled=\{disabled \|\| pending\} aria-busy=\{pending\}/);
  assert.match(form, /LoadingSpinner[\s\S]*t\(`mutation\.pending\.\$\{kind\}`\)/);
  for (const path of ["../components/admin/user-access-control.tsx", "../components/devices/device-inventory.tsx", "../components/admin/managed-telemetry-targets.tsx"]) {
    const component = source(path);
    assert.match(component, /<MutationForm action=/);
    assert.match(component, /PendingSubmit/);
    assert.doesNotMatch(component, /<form action=/);
  }
  const admin = source("../components/admin/user-access-control.tsx");
  assert.match(admin, /confirmation !== "DELETE USER"/);
  assert.match(admin, /<details[\s\S]*lifecycle\.deleteWarning/);
  for (const path of ["../components/devices/device-inventory.tsx", "../components/admin/managed-telemetry-targets.tsx"]) assert.match(source(path), /window\.confirm\(/);
});

test("notifications are app-wired, bounded, accessible, allowlisted and not emitted on routine updates", () => {
  const feedback = source("../components/ui/action-feedback.tsx");
  assert.match(source("../app/layout.tsx"), /<AppI18nProvider[^>]*><ActionFeedbackProvider>/);
  assert.match(feedback, /current\.slice\(-3\)/);
  assert.match(feedback, /role=\{item\.success \? "status" : "alert"\} aria-atomic="true"/);
  assert.match(feedback, /lifecycleErrors\.has\(code\)/);
  assert.match(feedback, /"mutation\.failed"/);
  assert.doesNotMatch(feedback, /JSON\.stringify|\.message|console\.|fetch\(|setInterval|useEffect/);
  const traffic = source("../components/traffic/traffic-live-page.tsx");
  const beforeActions = traffic.slice(0, traffic.indexOf("async function runAction"));
  assert.doesNotMatch(beforeActions, /notify\(/);
  const action = traffic.slice(traffic.indexOf("async function runAction"), traffic.indexOf("\n  return ("));
  assert.match(action, /inFlight\.current/);
  assert.ok(action.indexOf("await getTrafficStateAction()") < action.indexOf("notify(kind, true)"));
  assert.match(action, /if \(!latest\.ok \|\| !latest\.data\) throw/);
  assert.match(action, /catch \{ notify\(kind, false\); \}/);
  const discovery = source("../components/dashboard/network-discovery-drawer.tsx");
  assert.match(discovery, /if \(action === "start_session"\) notify\("start", true\)/);
  assert.match(discovery, /if \(!refreshed\.ok \|\| !refreshed\.data/);
  assert.match(discovery, /inFlight\.current = false; setBusy\(false\)/);
  const ping = source("../components/dashboard/manual-ping-provider.tsx");
  assert.match(ping, /inFlight\.current\.has\(targetId\)/);
  assert.ok(ping.indexOf("await waitForManualPingLocal(pingId)") < ping.indexOf('notify("ping", outcome.phase === "success")'));
  assert.match(ping, /!isAdmin \|\| !target\?\.manual_ping_available/);
});

test("configuration success returns only after local verification/revalidation; failed inputs are not redirected away", () => {
  for (const path of ["../app/actions/admin.ts", "../app/actions/devices.ts", "../app/actions/snmp.ts"]) {
    const actions = source(path);
    assert.doesNotMatch(actions, /redirect\(/);
    assert.match(actions, /revalidatePath\(/);
    assert.match(actions, /await local(?:Profiles|NetworkNodes|HealthTargets|ManagedTargets)\(/);
    assert.match(actions, /return \{ ok: false/);
  }
  const branding = source("../components/admin/report-branding-settings.tsx");
  assert.match(branding, /if \(inFlight\.current\) return false/);
  assert.match(branding, /if \(saved && fileRef\.current\) fileRef\.current\.value = ""/);
  assert.match(branding, /if \(payload\.changed === true\) notify\(kind, true\)/);
  assert.ok(branding.indexOf("setBranding(payload.data)") < branding.indexOf("notify(kind, true)"));
  assert.match(branding, /catch \{ notify\(kind, false\); return false; \}/);
  assert.match(source("../app/(protected)/admin/page.tsx"), /params.notice === "saved" && !params.error/);
  assert.match(source("../components/devices/device-inventory.tsx"), /const message = error \? null/);
  assert.match(source("../components/admin/managed-telemetry-targets.tsx"), /!error && \(notice === "saved" \|\| notice === "deleted"\)/);
});

test("paired notification/pending copy covers each important explicit mutation", () => {
  type Copy = { mutation: { failed: string; pending: Record<string, string>; success: Record<string, string> } };
  const en: Copy = JSON.parse(source("../i18n/en/common.json"));
  const id: Copy = JSON.parse(source("../i18n/id/common.json"));
  for (const kind of ["save", "create", "update", "disable", "reenable", "delete", "upload", "remove", "start", "stop", "ping"]) {
    for (const copy of [en, id]) { assert.ok(copy.mutation.pending[kind]); assert.ok(copy.mutation.success[kind]); }
  }
  assert.deepEqual(Object.keys(en.mutation.pending).sort(), Object.keys(id.mutation.pending).sort());
  assert.deepEqual(Object.keys(en.mutation.success).sort(), Object.keys(id.mutation.success).sort());
});
