import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Admin audit UI is protected, authoritative, newest-first bounded and retains deleted lifecycle UUIDs", () => {
  const page = source("../app/(protected)/admin/page.tsx");
  assert.ok(page.indexOf("await requireAdminProfile()") < page.indexOf("loadAdministrativeAudit(userId, auditPage)"));
  assert.match(page, /Math\.min\(200, Number\(params.audit_page\)\)/);
  assert.match(page, /<AdministrativeAuditCompact entries=\{audit\.entries\} page=\{auditPage\} more=\{audit\.more\} error=\{audit\.error\}/);
  const helper = source("../lib/administrative-audit.ts");
  assert.match(helper, /^import "server-only"/);
  assert.match(helper, /localApplicationRequest\("GET", `\/api\/application\/administrative-audit\?actor_id=/);
  assert.match(helper, /result\.data\.length > 51/);
  assert.match(helper, /result\.data\.slice\(0, 50\)/);
  assert.match(helper, /error: true/);
  const ui = source("../components/admin/administrative-audit-compact.tsx");
  assert.match(ui, /profileDisplayLabel\(entry\.actor_name, entry\.actor_email, entry\.actor_id/);
  assert.match(ui, /profileDisplayLabel\(entry\.target_name, entry\.target_email, entry\.resource_key/);
  assert.match(ui, /error[\s\S]*audit\.error[\s\S]*audit\.empty/);
  assert.match(ui, /entry\.source === "account"/);
  assert.match(ui, /safeIdentity\(state.institution_name\)/);
  assert.doesNotMatch(ui, /JSON\.stringify|dangerouslySetInnerHTML|\.error\.message|DATABASE_URL|Bearer/);
});

test("branding mutations forward explicit authenticated actor and allowlisted payload, never caller admin claims", () => {
  for (const path of ["../app/(protected)/admin/report-branding/route.ts", "../app/(protected)/admin/report-branding/logo/route.ts"]) {
    const route = source(path);
    assert.match(route, /const \{ userId \} = await requireAdminProfile\(\)/);
    assert.match(route, /(?:saveReportBranding|saveReportLogo|removeReportLogo)\(userId/);
    assert.match(route, /cache-control.*no-store/);
    assert.doesNotMatch(route, /actor_id.*form\.get|actor_id.*request\.json/);
  }
  const helper = source("../lib/report-branding.ts");
  assert.match(helper, /^import "server-only"/);
  assert.match(helper, /actor_id: actorId, input: value/);
  assert.match(helper, /changed: result\.payload\.changed === true/);
  assert.match(helper, /\["INVALID_REPORT_BRANDING", "INVALID_REPORT_LOGO", "REPORT_BRANDING_UNAVAILABLE", "ADMIN_ACCESS_REQUIRED"\]/);
  assert.doesNotMatch(helper.slice(helper.indexOf("function safeErrorCode")), /\.message|\.test\(value\.error\.code\)/);
});

test("audit copy is paired EN/ID for every preserved lifecycle and branding action", () => {
  type Catalog = { audit: { actions: Record<string, string>; empty: string; error: string; title: string } };
  const en: Catalog = JSON.parse(source("../i18n/en/admin.json"));
  const id: Catalog = JSON.parse(source("../i18n/id/admin.json"));
  assert.deepEqual(Object.keys(en.audit).sort(), Object.keys(id.audit).sort());
  assert.deepEqual(Object.keys(en.audit.actions).sort(), Object.keys(id.audit.actions).sort());
  for (const action of ["access_changed", "account_disabled", "account_reenabled", "account_deleted",
    "branding_identity_updated", "branding_logo_updated", "branding_logo_removed"]) {
    assert.ok(en.audit.actions[action]); assert.ok(id.audit.actions[action]);
  }
  for (const copy of [en, id]) { assert.ok(copy.audit.empty); assert.ok(copy.audit.error); }
});
