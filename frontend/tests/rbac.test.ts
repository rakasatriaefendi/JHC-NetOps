import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  accessStatusFromProfile,
  canAdministerUsers,
  canOperateNetwork,
  isAccessStatus,
  isActiveUser,
  isProfileRole,
} from "../lib/authorization.ts";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("role and access predicates keep authorization independent", () => {
  assert.equal(canOperateNetwork("admin"), true);
  assert.equal(canOperateNetwork("operator"), true);
  assert.equal(canOperateNetwork("viewer"), false);
  assert.equal(canAdministerUsers("admin"), true);
  assert.equal(canAdministerUsers("operator"), false);
  assert.equal(canAdministerUsers("viewer"), false);
  assert.equal(isActiveUser("approved"), true);
  assert.equal(isActiveUser("pending"), false);
  assert.equal(isActiveUser("rejected"), false);
  assert.equal(accessStatusFromProfile("approved"), "active");
});

test("network actions require both approved status and an operational role", () => {
  const networkActionAllowed = (status: unknown, role: unknown) =>
    status === "approved" && typeof role === "string" && isProfileRole(role) && canOperateNetwork(role);

  assert.equal(networkActionAllowed("approved", "operator"), true);
  assert.equal(networkActionAllowed("pending", "operator"), false);
  assert.equal(networkActionAllowed("rejected", "operator"), false);
  assert.equal(networkActionAllowed("approved", "viewer"), false);
});

test("unknown roles and access statuses are rejected", () => {
  assert.equal(isProfileRole("operator"), true);
  assert.equal(isProfileRole("owner"), false);
  assert.equal(isAccessStatus("suspended"), true);
  assert.equal(isAccessStatus("disabled"), false);
});

test("Admin route and user administration remain directly Admin-only", () => {
  const auth = source("../lib/auth.ts");
  const adminPage = source("../app/(protected)/admin/page.tsx");
  const action = source("../app/actions/admin.ts");
  assert.match(adminPage, /requireAdminProfile/);
  assert.match(auth, /requireAdminProfile[\s\S]*canAdministerUsers/);
  assert.match(action, /requireAdminProfile/);
  assert.match(action, /isProfileRole\(role\)[\s\S]*isAccessStatus\(accessStatus\)/);
  assert.ok(auth.indexOf("requireApprovedProfile()") < auth.indexOf("canAdministerUsers(auth.profile.role)"));
});

test("operational server actions use active Operator authorization", () => {
  const devices = source("../app/actions/devices.ts");
  const snmp = source("../app/actions/snmp.ts");
  const assets = source("../app/actions/assets.ts");
  assert.match(devices, /requireOperatorProfile/);
  assert.doesNotMatch(devices, /requireAdminProfile/);
  assert.match(snmp, /requireOperatorProfile/);
  assert.doesNotMatch(snmp, /requireAdminProfile/);
  assert.match(assets, /requireOperatorProfile/);
  assert.match(assets, /requireApprovedProfile/);
  assert.doesNotMatch(assets, /requireAdminProfile/);
});

test("Admin UI exposes independent role and access selectors", () => {
  const control = source("../components/admin/user-access-control.tsx");
  for (const value of ["admin", "operator", "viewer"]) assert.match(control, new RegExp(`value="${value}"`));
  for (const value of ["pending", "active", "suspended"]) assert.match(control, new RegExp(`value="${value}"`));
  assert.match(control, /t\("common:status\.pending"\)/);
  assert.match(control, /t\("common:status\.approved"\)/);
  assert.match(control, /t\("common:status\.rejected"\)/);
  assert.match(control, /t\("access\.saving"\)/);
  assert.doesNotMatch(control, /Menyimpan…/);
});

test("database migration enforces Operator policies and last-admin safety", () => {
  const migration = source("../../supabase/migrations/202609040001_operator_rbac.sql");
  assert.match(migration, /role in \('admin', 'operator', 'viewer'\)/);
  assert.match(migration, /status = 'approved'[\s\S]*role in \('admin', 'operator'\)/);
  assert.match(migration, /actor_id = p_target_id/);
  assert.match(migration, /last active admin cannot be changed/i);
  assert.match(migration, /revoke update on public\.profiles from authenticated/);
  assert.match(migration, /when 'active' then 'approved'/);
  assert.match(migration, /when 'suspended' then 'rejected'/);
  assert.match(migration, /else 'pending'/);
  assert.match(
    migration,
    /approved_at = case\s+when next_status = 'approved' and target_status = 'approved' then approved_at\s+when next_status = 'approved' then now\(\)/,
  );
  assert.match(
    migration,
    /approved_by = case\s+when next_status = 'approved' and target_status = 'approved' then approved_by\s+when next_status = 'approved' then actor_id/,
  );
});
