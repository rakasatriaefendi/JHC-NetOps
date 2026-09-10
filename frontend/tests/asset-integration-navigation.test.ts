import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("SNMP asset navigation selects only a target present in the existing workspace", () => {
  const page = source("../app/(protected)/snmp/page.tsx");
  const detail = source("../components/snmp/managed-telemetry-detail.tsx");
  assert.match(page, /target\?: string/);
  assert.match(page, /params\.target \? \{ initialTargetId: params\.target \} : \{\}/);
  assert.match(detail, /targets\.some\(\(target\) => target\.id === initialTargetId\)/);
  assert.match(detail, /id="managed-telemetry-workspace"/);
  assert.match(detail, /targets\.find\(\(target\) => target\.id === selectedId\) \?\? targets\[0\]/);
});

test("Health Watch asset navigation opens only an existing enabled dashboard target", () => {
  const page = source("../app/(protected)/dashboard/page.tsx");
  const dashboard = source("../components/dashboard/network-health-dashboard.tsx");
  assert.match(page, /searchParams: Promise<\{ target\?: string \}>/);
  assert.match(page, /params\.target \? \{ initialTargetId: params\.target \} : \{\}/);
  assert.match(dashboard, /targets\.some\(\(target\) => target\.id === initialTargetId\)/);
  assert.match(dashboard, /const selected = targets\.find\(\(target\) => target\.id === selectedId\) \?\? null/);
});

test("Asset integration links are UUID-gated, existence-checked, and never render SNMP credentials", () => {
  const component = source("../components/assets/asset-inventory.tsx");
  assert.match(component, /function validLinkedRef/);
  assert.match(component, /function verifiedLinkedRef/);
  assert.match(component, /availableIds\.includes\(valid\)/);
  assert.match(component, /\^\[0-9a-f\]\{8\}/);
  assert.doesNotMatch(component, /community|auth_password|priv_password|credential_profile/i);
});
