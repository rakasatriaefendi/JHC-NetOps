import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { addCalendarMonths, joinCertificateReference, splitCertificateReference, splitGuidedCertificateReference } from "../lib/medical-equipment-contract.ts";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Medical Equipment is a localized protected asset workspace with detail route", () => {
  const navigation = source("../components/app-navigation.tsx");
  const listPage = source("../app/(protected)/medical-equipment/page.tsx");
  const detailPage = source("../app/(protected)/medical-equipment/[id]/page.tsx");
  assert.match(navigation, /href: "\/medical-equipment"/);
  assert.match(navigation, /pathname\.startsWith\(`\$\{link\.href\}\//);
  assert.match(listPage, /requireApprovedProfile\(\)/);
  assert.match(listPage, /canOperateNetwork\(profile\.role\)/);
  assert.match(detailPage, /loadMedicalEquipmentDetail\(id\)/);
  assert.match(detailPage, /notFound\(\)/);
});

test("medical writes are server-side and independently enforce operator authorization", () => {
  const actions = source("../app/actions/medical-equipment.ts");
  const loader = source("../lib/medical-equipment.ts");
  assert.equal((actions.match(/requireOperatorProfile\(\)/g) ?? []).length, 4);
  assert.match(actions, /requireApprovedProfile\(\)/);
  assert.match(loader, /localBackendConfig\(\)/);
  assert.match(loader, /authorization: `Bearer \$\{config\.token\}`/);
  assert.doesNotMatch(loader, /NEXT_PUBLIC|DATABASE_URL|SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(actions, /role\s*[:=]|profile\.role/);
  for (const serviceType of ["preventive_maintenance", "corrective_maintenance", "inspection", "repair", "other"]) assert.match(loader, new RegExp(`"${serviceType}"`));
  assert.doesNotMatch(loader, /"installation"/);
});

test("registry provides summary, bounded filters, pagination and responsive table/cards", () => {
  const component = source("../components/medical-equipment/medical-equipment-registry.tsx");
  for (const key of ["summary.total", "summary.calibrationOverdue", "summary.maintenanceOverdue", "summary.networkLinked", "calibration_status", "maintenance_status", "network_link"]) assert.match(component, new RegExp(key.replace(".", "\\.")));
  assert.match(component, /hidden overflow-hidden[\s\S]*lg:block/);
  assert.match(component, /lg:hidden/);
  assert.match(component, /pagination\.pages/);
  assert.doesNotMatch(component, /overflow-x-auto|min-w-\[/);
});

test("detail keeps operational, calibration, maintenance and network states separate", () => {
  const component = source("../components/medical-equipment/medical-equipment-detail.tsx");
  assert.match(component, /"overview" \| "network" \| "calibration" \| "maintenance"/);
  assert.match(component, /equipment\.operational_status/);
  assert.match(component, /equipment\.calibration_status/);
  assert.match(component, /equipment\.maintenance_status/);
  assert.match(component, /network_asset/);
  assert.match(component, /\/assets\?q=/);
  assert.doesNotMatch(component, /ping|nmap|snmpget|snmpwalk|device-inspect/i);
});

test("calibration certificate helper preserves arbitrary prefixes and leading zeros", () => {
  assert.deepEqual(splitCertificateReference("CAL/JKT/2026/008812"), { prefix: "CAL/JKT/", year: "2026", sequence: "008812" });
  assert.equal(joinCertificateReference("CAL/JKT/", "2026", "008812"), "CAL/JKT/2026/008812");
  assert.deepEqual(splitCertificateReference("VENDOR-X/REGION/2027/000001"), { prefix: "VENDOR-X/REGION/", year: "2027", sequence: "000001" });
  assert.deepEqual(splitGuidedCertificateReference("CAL/JKT/2026/008812"), { code: "CAL", unit: "JKT", year: "2026", reference: "008812" });
  assert.equal(splitGuidedCertificateReference("free-form-certificate"), null);
});

test("date assistance performs calendar month math and remains user-overridable", () => {
  assert.equal(addCalendarMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(addCalendarMonths("2024-01-31", 1), "2024-02-29");
  const component = source("../components/medical-equipment/medical-equipment-detail.tsx");
  assert.match(component, /value=\{due\} onChange=\{\(event\) => setDue/);
  assert.match(component, /addCalendarMonths\(performed/);
});

test("Asset Detail reverse-link is batched and does not copy network identity into medical records", () => {
  const page = source("../app/(protected)/assets/page.tsx");
  const asset = source("../components/assets/asset-inventory.tsx");
  const loader = source("../lib/medical-equipment.ts");
  assert.match(page, /loadMedicalNetworkLinks\(result\.data\.items\.map/);
  assert.match(asset, /medicalLinks\.find\(\(link\) => link\.network_asset_id === asset\.id\)/);
  assert.match(asset, /\/medical-equipment\/\$\{medicalLink\.medical_equipment_id\}/);
  assert.match(loader, /asset_ids=/);
  assert.doesNotMatch(asset, /Register.*Medical|createMedicalEquipmentAction/);
});

test("English and Indonesian medical catalogs remain paired", () => {
  const en = JSON.parse(source("../i18n/en/medical.json"));
  const id = JSON.parse(source("../i18n/id/medical.json"));
  for (const path of ["title", "summary.calibrationOverdue", "status.due_soon", "tabs.maintenance", "calibration.guided", "network.linkHelp", "errors.NETWORK_ASSET_ALREADY_LINKED"]) {
    const keys = path.split(".");
    let left: unknown = en; let right: unknown = id;
    for (const key of keys) { left = (left as Record<string, unknown>)[key]; right = (right as Record<string, unknown>)[key]; }
    assert.equal(typeof left, "string"); assert.equal(typeof right, "string");
  }
});
