import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { accountLifecycleAction, accessStatusFromProfile, isAccessStatus, isActiveUser,
  canAdministerUsers, canOperateNetwork, type ProfileStatus } from "../lib/authorization.ts";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Disabled is distinct from suspended/rejected and never an active access option", () => {
  assert.equal(accessStatusFromProfile("disabled"), "disabled");
  assert.equal(accessStatusFromProfile("rejected"), "suspended");
  assert.equal(accessStatusFromProfile("pending"), "pending");
  assert.equal(accessStatusFromProfile("approved"), "active");
  assert.equal(isAccessStatus("disabled"), false);
  assert.equal(isActiveUser("disabled"), false);
  const badge = source("../components/ui/status-badge.tsx");
  assert.match(badge, /disabled: "border border-border bg-bg-base text-text-muted"/);
  assert.match(badge, /t\(`status\.\$\{status\}`\)/);
  const parser = source("../lib/auth.ts");
  assert.match(parser, /\["pending", "approved", "rejected", "disabled"\]/);
  assert.match(parser, /disabled_at: typeof value\.disabled_at === "string"/);
});

test("current account never exposes destructive actions; other accounts follow the exact lifecycle matrix", () => {
  const statuses: ProfileStatus[] = ["pending", "approved", "rejected", "disabled"];
  for (const status of statuses) assert.equal(accountLifecycleAction(status, true), null);
  assert.equal(accountLifecycleAction("approved", false), "disable");
  assert.equal(accountLifecycleAction("disabled", false), "reenable");
  assert.equal(accountLifecycleAction("pending", false), "delete");
  assert.equal(accountLifecycleAction("rejected", false), null);
  const ui = source("../components/admin/user-access-control.tsx");
  assert.match(ui, /const lifecycle = accountLifecycleAction\(status, isCurrentUser\)/);
  for (const [kind, action] of [["disable", "disableUserAction"], ["reenable", "reenableUserAction"], ["delete", "deleteUserAction"]]) {
    assert.match(ui, new RegExp(`lifecycle === "${kind}"[\\s\\S]*?<MutationForm action=\\{${action}\\} kind="${kind}"`));
  }
  assert.match(ui, /status === "disabled"[\s\S]*?lifecycle\.disabledHelp[\s\S]*?: \([\s\S]*?MutationForm action=\{setUserAccessAction\}/);
});

test("permanent delete uses explicit accessible confirmation, exact DELETE USER and a separate destructive submit", () => {
  const ui = source("../components/admin/user-access-control.tsx");
  assert.match(ui, /<details[\s\S]*?<summary[\s\S]*?lifecycle\.delete/);
  assert.match(ui, /lifecycle\.deleteWarning/);
  assert.match(ui, /<label htmlFor=\{confirmationId\}/);
  assert.match(ui, /id=\{confirmationId\} name="confirmation"/);
  assert.match(ui, /label="delete" variant="destructive" disabled=\{confirmation !== "DELETE USER"\}/);
  assert.match(ui, /disabled=\{disabled \|\| pending\}/);
  assert.doesNotMatch(ui, /window\.confirm|\bconfirm\(/);
});

test("lifecycle actions authenticate server-side and forward only allowlisted validated fields", () => {
  const actions = source("../app/actions/admin.ts");
  for (const name of ["disableUserAction", "reenableUserAction", "deleteUserAction"]) {
    const block = actions.split(`export async function ${name}(`)[1]!.split("\n}")[0]!;
    assert.match(block, /await requireAdminProfile\(\)/);
    assert.match(block, /lifecycleTarget\(formData, USER_(?:LIFECYCLE|DELETE)_FIELDS\)/);
    assert.doesNotMatch(block, /Object\.fromEntries|JSON\.stringify\(formData/);
  }
  assert.match(actions, /USER_LIFECYCLE_FIELDS = new Set\(\["user_id"\]\)/);
  assert.match(actions, /USER_DELETE_FIELDS = new Set\(\["user_id", "confirmation"\]\)/);
  assert.match(actions, /hasUnexpectedFormFields\(formData, allowed\)/);
  assert.match(actions, /formData\.getAll\(key\)\.length !== 1/);
  assert.match(actions, /UUID_PATTERN\.test\(targetId\)/);
  assert.match(actions, /confirmation !== "DELETE USER"/);
  assert.match(actions, /deleteAccountLocal\(userId, targetId, confirmation\)/);
  assert.match(actions, /revalidatePath\("\/admin"\)/);
});

test("server-only lifecycle helpers preserve new bounded errors without exposing credentials", () => {
  const persistence = source("../lib/application-persistence.ts");
  assert.match(persistence, /^import "server-only"/);
  for (const code of ["SELF_DELETE_BLOCKED", "SELF_DISABLE_BLOCKED", "LAST_LOGIN_CAPABLE_ADMIN_BLOCKED",
    "ACCOUNT_HAS_HISTORY", "ACCOUNT_NOT_DISABLEABLE", "ACCOUNT_NOT_REENABLEABLE", "ACCOUNT_NOT_DELETABLE"])
    assert.ok(persistence.slice(persistence.indexOf("function safeCode")).includes(`"${code}"`));
  assert.match(persistence, /localApplicationRequest\("POST", `\/api\/application\/profiles\/\$\{targetId\}\/disable`, \{ actor_id: actorId \}\)/);
  assert.match(persistence, /localApplicationRequest\("POST", `\/api\/application\/profiles\/\$\{targetId\}\/reenable`, \{ actor_id: actorId \}\)/);
  assert.match(persistence, /localApplicationRequest\("DELETE", `\/api\/application\/profiles\/\$\{targetId\}`, \{ actor_id: actorId, confirmation \}\)/);
  assert.match(source("../lib/local-auth.ts"), /"ACCOUNT_DISABLED"\].includes\(code\)/);
  const ui = source("../components/admin/user-access-control.tsx");
  assert.doesNotMatch(ui, /FRONTEND_API_TOKEN|DATABASE_URL|localBackendConfig|fetch\(/);
});

test("lifecycle copy is paired EN/ID and disabled labels do not alias Suspended", () => {
  type Catalog = { lifecycle: { disable: string; reenable: string; delete: string; confirmation: string; deleteWarning: string; errors: Record<string, string> } };
  const en: Catalog = JSON.parse(source("../i18n/en/admin.json"));
  const id: Catalog = JSON.parse(source("../i18n/id/admin.json"));
  assert.equal(en.lifecycle.disable, "Disable Account");
  assert.equal(en.lifecycle.reenable, "Re-enable Account");
  assert.equal(en.lifecycle.delete, "Permanent Delete");
  assert.equal(id.lifecycle.disable, "Nonaktifkan Akun");
  assert.equal(id.lifecycle.reenable, "Aktifkan Kembali Akun");
  assert.equal(id.lifecycle.delete, "Hapus Permanen");
  assert.deepEqual(Object.keys(en.lifecycle).sort(), Object.keys(id.lifecycle).sort());
  assert.deepEqual(Object.keys(en.lifecycle.errors).sort(), Object.keys(id.lifecycle.errors).sort());
  for (const catalog of [en, id]) {
    assert.ok(catalog.lifecycle.confirmation.includes("DELETE USER"));
    assert.ok(catalog.lifecycle.deleteWarning.length > 40);
  }
  type Common = { status: { disabled: string; rejected: string } };
  for (const language of ["en", "id"]) {
    const common: Common = JSON.parse(source(`../i18n/${language}/common.json`));
    assert.notEqual(common.status.disabled, common.status.rejected);
  }
});

test("existing role and approved-status authorization remains unchanged", () => {
  assert.equal(canAdministerUsers("admin"), true);
  assert.equal(canAdministerUsers("operator"), false);
  assert.equal(canAdministerUsers("viewer"), false);
  assert.equal(canOperateNetwork("operator"), true);
  assert.equal(canOperateNetwork("viewer"), false);
  for (const status of ["pending", "rejected", "disabled"] as const) assert.equal(isActiveUser(status), false);
  assert.equal(isActiveUser("approved"), true);
  const ui = source("../components/admin/user-access-control.tsx");
  for (const value of ["admin", "operator", "viewer", "pending", "active", "suspended"]) assert.ok(ui.includes(`value="${value}"`));
});
