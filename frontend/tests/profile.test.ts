import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { normalizeProfileName, profileDisplayLabel, profileInitials } from "../lib/profile-display.ts";
import { hasUnexpectedFormFields } from "../lib/form-security.ts";
import { MutationGate } from "../lib/mutation-feedback.ts";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const UUID = "6750244b-d909-4463-8bf9-c73a969aebd0";

test("self-profile requires an authenticated approved user and exposes only name as an editable form field", () => {
  const page = source("../app/(protected)/profile/page.tsx");
  const auth = source("../lib/auth.ts");
  assert.match(page, /await requireApprovedProfile\(\)/);
  assert.match(auth, /normalizedProfile\(await localAuthenticatedProfile\(\)\)/);
  assert.match(auth, /if \(!profile\) redirect\("\/login"\)/);
  assert.match(auth, /!isActiveUser\(auth\.profile\.status\)/);
  assert.match(page, /profile\.full_name[\s\S]*<dl/);
  for (const field of ["email", "id", "created_at", "role"]) assert.ok(page.includes(`profile.${field}`));
  assert.deepEqual([...page.matchAll(/<input\b[^>]*\bname="([^"]+)"/g)].map((match) => match[1]), ["full_name"]);
  assert.match(page, /maxLength=\{200\}/);
  assert.match(page, /<MutationForm action=\{saveOwnProfileNameAction\} kind="update"/);
  assert.match(page, /<PendingSubmit>/);
  assert.doesNotMatch(page, /requireAdminProfile|password|<select|type="hidden"|dangerouslySetInnerHTML/);
});

test("self-profile action derives identity from Local Auth, validates exact fields, verifies authoritative name before success", () => {
  const action = source("../app/actions/profile.ts");
  assert.match(action, /const \{ userId \} = await requireApprovedProfile\(\)/);
  assert.match(action, /NAME_FIELDS = new Set\(\["full_name"\]\)/);
  assert.match(action, /hasUnexpectedFormFields\(form, NAME_FIELDS\)/);
  assert.match(action, /form\.getAll\("full_name"\)\.length !== 1/);
  assert.match(action, /normalizeProfileName\(form\.get\("full_name"\)\)/);
  assert.match(action, /localApplicationRequest\("PATCH", "\/api\/application\/profiles\/self\/name", \{\s*actor_id: userId, full_name: name,\s*\}\)/);
  assert.doesNotMatch(action, /form\.get\("(?:id|user_id|actor_id|target_id|email|role|status)"\)|Object\.fromEntries|\.\.\.form|console\.|\.message|redirect\(|administrative-audit/);
  assert.ok(action.indexOf("await localProfile(userId)") < action.indexOf("return { ok: true"));
  assert.match(action, /verified\.id !== userId \|\| verified\.status !== "approved" \|\| verified\.full_name !== name/);
  assert.match(action, /typeof result\.changed !== "boolean"/);
  assert.match(action, /revalidatePath\("\/", "layout"\)/);
  assert.match(action, /revalidatePath\("\/admin"\)/);
  assert.match(action, /return \{ ok: true, changed: result\.changed \}/);
  const allowed = new Set(["full_name"]);
  for (const field of ["user_id", "actor_id", "target_id", "email", "role", "status"]) {
    const form = new FormData(); form.set("full_name", "Name"); form.set(field, UUID);
    assert.equal(hasUnexpectedFormFields(form, allowed), true);
  }
});

test("profile names trim spaces, require a value, and reject overlong, control-character and markup input", () => {
  assert.equal(normalizeProfileName("  Raka Satria Efendi  "), "Raka Satria Efendi");
  assert.equal(normalizeProfileName(` ${"a".repeat(200)} `), "a".repeat(200));
  for (const input of [null, undefined, 123, "", "   ", "a".repeat(201), "Name\n", "na\u0000me", "na\u0085me", "<b>Name</b>"]) {
    assert.equal(normalizeProfileName(input), null);
  }
});

test("profile uses the existing single-terminal feedback gate: success once, no-op silent, failure once and input retained", async () => {
  const notifications: boolean[] = [];
  const notify = (ok: boolean) => { notifications.push(ok); };
  const gate = new MutationGate();
  await gate.run(async () => ({ ok: true, changed: true }), notify);
  assert.deepEqual(notifications, [true]);
  await gate.run(async () => ({ ok: true, changed: false }), notify);
  assert.deepEqual(notifications, [true]);
  await gate.run(async () => ({ ok: false, code: "LOCAL_APPLICATION_UNAVAILABLE" }), notify);
  assert.deepEqual(notifications, [true, false]);
  const form = source("../components/ui/mutation-form.tsx");
  assert.match(form, /aria-busy=\{pending\}/);
  assert.match(form, /gate\.current\.run\(\(\) => action\(data\)/);
  assert.doesNotMatch(form, /\.reset\(/);
});

test("audit people display current name then email then canonical UUID, including blank and deleted identities", () => {
  assert.equal(profileDisplayLabel(" Raka ", "raka@example.com", UUID), "Raka");
  for (const name of [null, "", "   "]) assert.equal(profileDisplayLabel(name, "raka@example.com", UUID), "raka@example.com");
  for (const name of [null, "", "  "]) {
    for (const email of [null, "", "  "]) assert.equal(profileDisplayLabel(name, email, UUID), UUID);
  }
  assert.equal(profileDisplayLabel(null, null, null, "Unavailable"), "Unavailable");
  assert.equal(profileDisplayLabel("password=private-fixture", "raka@example.com", UUID), "raka@example.com");
  assert.equal(profileDisplayLabel(null, "Bearer private-fixture", UUID), UUID);
  assert.equal(profileDisplayLabel("Secret Garden", null, UUID), "Secret Garden");
  const audit = source("../components/admin/administrative-audit.tsx");
  assert.match(audit, /profileDisplayLabel\(entry\.actor_name, entry\.actor_email, entry\.actor_id/);
  assert.match(audit, /profileDisplayLabel\(entry\.target_name, entry\.target_email, entry\.resource_key/);
  assert.match(audit, /title=\{entry\.actor_id\}/);
  assert.match(audit, /title=\{entry\.resource_key\}/);
});

test("minimal profile navigation uses name/email initials and a generic icon, with no avatar or new sidebar group", () => {
  assert.equal(profileInitials("Raka Satria Efendi", "other@example.com"), "RE");
  assert.equal(profileInitials("raka", "other@example.com"), "R");
  assert.equal(profileInitials(" ", "raka@example.com"), "R");
  assert.equal(profileInitials(null, null), null);
  const navigation = source("../components/app-navigation.tsx");
  assert.match(navigation, /<Link href="\/profile"/);
  assert.match(navigation, /aria-current=\{pathname === "\/profile" \? "page" : undefined\}/);
  assert.match(navigation, /initials \?\? <svg/);
  assert.doesNotMatch(navigation, /avatar|type="file"/);
});

test("profile EN/ID copy is paired and shares existing localized mutation pending/success/error feedback", () => {
  type Copy = { profile: Record<string, string>; mutation: { pending: { update: string }; success: { update: string }; failed: string } };
  const en: Copy = JSON.parse(source("../i18n/en/common.json"));
  const id: Copy = JSON.parse(source("../i18n/id/common.json"));
  assert.deepEqual(Object.keys(en.profile).sort(), Object.keys(id.profile).sort());
  for (const copy of [en, id]) {
    for (const key of ["title", "description", "name", "email", "uid", "createdAt", "role", "saveName"]) assert.ok(copy.profile[key]);
    assert.ok(copy.mutation.pending.update); assert.ok(copy.mutation.success.update); assert.ok(copy.mutation.failed);
  }
});
