import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  validateCalibrationInput,
  validateMedicalEquipmentInput,
  validateMedicalListQuery,
  validateServiceInput,
  type CalibrationInput,
  type CalibrationRecord,
  type MedicalEquipmentDetail,
  type MedicalEquipmentInput,
  type MedicalEquipmentRecord,
  type MedicalListQuery,
  type MedicalListResponse,
  type NetworkAssetOption,
  type ServiceInput,
  type ServiceRecord,
} from "../src/medical-equipment/contract.js";
import { addCalendarMonths, calibrationDueStatus, maintenanceDueStatus } from "../src/medical-equipment/domain.js";
import { MedicalRepositoryError, type MedicalEquipmentRepository } from "../src/medical-equipment/repository.js";
import { buildServer } from "../src/server.js";

const TOKEN = "m".repeat(32);
const ID = "11111111-1111-4111-8111-111111111111";
const ASSET_ID = "22222222-2222-4222-8222-222222222222";
const INPUT: MedicalEquipmentInput = {
  equipment_code: "MED-0001", name: "Patient Monitor", manufacturer: "Acme", model: "M1", serial_number: "SN-01",
  department: "ICU", location: "Floor 2", operational_status: "active", network_asset_id: ASSET_ID,
  calibration_required: true, calibration_interval_months: 12, maintenance_interval_months: 6, notes: null,
};
const EQUIPMENT: MedicalEquipmentRecord = {
  ...INPUT, id: ID, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-09-11T00:00:00.000Z",
  calibration_status: "due_soon", maintenance_status: "ok", latest_calibration_on: "2025-10-01",
  calibration_due_on: "2026-10-01", latest_service_on: "2026-08-01", maintenance_due_on: "2027-02-01",
  network_asset: { id: ASSET_ID, name: "Monitor LAN", hostname: "monitor-1", ip_address: "192.0.2.20", mac_address: null, device_type: "medical_device", vendor: "Acme", status: "online" },
};

class FakeMedicalRepository implements MedicalEquipmentRepository {
  listQueries: MedicalListQuery[] = [];
  listTodays: string[] = [];
  created: MedicalEquipmentInput[] = [];
  async list(query: MedicalListQuery, today: string): Promise<MedicalListResponse> {
    this.listQueries.push(query);
    this.listTodays.push(today);
    return { items: [EQUIPMENT], summary: { total: 1, calibration_overdue: 0, calibration_due_soon: 1, maintenance_overdue: 0, maintenance_due_soon: 0, network_linked: 1 }, filters: { departments: ["ICU"], locations: ["Floor 2"] }, pagination: { page: 1, page_size: 10, total: 1, pages: 1 } };
  }
  async detail(id: string): Promise<MedicalEquipmentDetail | null> { return id === ID ? { equipment: EQUIPMENT, calibrations: [], services: [] } : null; }
  async create(input: MedicalEquipmentInput): Promise<MedicalEquipmentRecord> { this.created.push(input); return { ...EQUIPMENT, ...input }; }
  async update(id: string, input: MedicalEquipmentInput): Promise<MedicalEquipmentRecord | null> { return id === ID ? { ...EQUIPMENT, ...input } : null; }
  async addCalibration(id: string, input: CalibrationInput): Promise<CalibrationRecord | null> { return id === ID ? { ...input, id: ASSET_ID, record_number: "CAL-2026-000001", created_at: EQUIPMENT.updated_at, updated_at: EQUIPMENT.updated_at } : null; }
  async addService(id: string, input: ServiceInput): Promise<ServiceRecord | null> { return id === ID ? { ...input, id: ASSET_ID, record_number: "SRV-2026-000001", created_at: EQUIPMENT.updated_at, updated_at: EQUIPMENT.updated_at } : null; }
  async networkAssets(): Promise<readonly NetworkAssetOption[]> { return EQUIPMENT.network_asset ? [EQUIPMENT.network_asset] : []; }
  async networkLinks() { return [{ network_asset_id: ASSET_ID, medical_equipment_id: ID, equipment_code: INPUT.equipment_code, name: INPUT.name, department: INPUT.department, location: INPUT.location }]; }
}

test("medical list, equipment, calibration and service contracts are strict and bounded", () => {
  assert.deepEqual(validateMedicalListQuery({}), { ok: true, value: { search: "", department: null, location: null, operationalStatus: null, calibrationStatus: null, maintenanceStatus: null, networkLink: null, page: 1, pageSize: 10 } });
  assert.equal(validateMedicalListQuery({ page_size: "100" }).ok, false);
  assert.equal(validateMedicalListQuery({ surprise: "x" }).ok, false);
  assert.deepEqual(validateMedicalEquipmentInput(INPUT), { ok: true, value: INPUT });
  assert.equal(validateMedicalEquipmentInput({ ...INPUT, credential: "secret" }).ok, false);
  assert.equal(validateMedicalEquipmentInput({ ...INPUT, calibration_interval_months: 121 }).ok, false);
  assert.equal(validateCalibrationInput({ performed_on: "2026-09-01", due_on: "2026-08-01", provider: null, certificate_number: null, result: "passed", notes: null, source: "manual" }).ok, false);
  assert.equal(validateServiceInput({ service_type: "arbitrary", performed_on: "2026-09-01", next_due_on: null, provider: null, technician: null, result: "completed", notes: null, source: "manual" }).ok, false);
  for (const serviceType of ["preventive_maintenance", "corrective_maintenance", "inspection", "repair", "other"]) {
    assert.equal(validateServiceInput({ service_type: serviceType, performed_on: "2026-09-01", next_due_on: null, provider: null, technician: null, result: "completed", notes: null, source: "manual" }).ok, true);
  }
  assert.equal(validateCalibrationInput({ performed_on: "2026-09-01", due_on: null, provider: null, certificate_number: null, result: "passed", notes: null, source: "manual" }).ok, true);
});

test("calendar month assistance clamps month ends without hardcoded intervals", () => {
  assert.equal(addCalendarMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(addCalendarMonths("2024-01-31", 1), "2024-02-29");
  assert.equal(addCalendarMonths("2026-08-15", 12), "2027-08-15");
});

test("calibration and maintenance due states use SQL DATE semantics and configured threshold", () => {
  assert.equal(calibrationDueStatus(false, null, "2026-09-11", 30), "not_required");
  assert.equal(calibrationDueStatus(true, null, "2026-09-11", 30), "not_recorded");
  assert.equal(calibrationDueStatus(true, "2026-09-10", "2026-09-11", 30), "overdue");
  assert.equal(calibrationDueStatus(true, "2026-09-11", "2026-09-11", 30), "due_soon");
  assert.equal(calibrationDueStatus(true, "2026-10-12", "2026-09-11", 30), "valid");
  assert.equal(maintenanceDueStatus(null, "2026-09-11", 30), "not_scheduled");
  assert.equal(maintenanceDueStatus("2026-09-20", "2026-09-11", 30), "due_soon");
});

test("medical routes require backend bearer auth and preserve read-only viewer transport", async () => {
  const repository = new FakeMedicalRepository();
  const server = buildServer({ logger: false, medicalEquipment: { token: TOKEN, repository, now: () => new Date("2026-09-11T00:00:00Z") } });
  assert.equal((await server.inject({ method: "GET", url: "/api/medical-equipment" })).statusCode, 401);
  const list = await server.inject({ method: "GET", url: "/api/medical-equipment?department=ICU&calibration_status=due_soon", headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().data.items[0].equipment_code, "MED-0001");
  assert.equal(repository.listQueries[0]?.calibrationStatus, "due_soon");
  const detail = await server.inject({ method: "GET", url: `/api/medical-equipment/${ID}`, headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().data.equipment.network_asset.ip_address, "192.0.2.20");
  await server.close();
});

test("medical routes derive today from local calendar date without UTC rollover", async () => {
  const repository = new FakeMedicalRepository();
  const server = buildServer({
    logger: false,
    medicalEquipment: {
      token: TOKEN,
      repository,
      now: () => new Date(2026, 8, 11, 0, 30, 0),
    },
  });

  const response = await server.inject({
    method: "GET",
    url: "/api/medical-equipment",
    headers: { authorization: `Bearer ${TOKEN}` },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(repository.listTodays[0], "2026-09-11");
  await server.close();
});

test("medical mutations accept only normalized payloads and generated record numbers", async () => {
  const repository = new FakeMedicalRepository();
  const server = buildServer({ logger: false, medicalEquipment: { token: TOKEN, repository } });
  const create = await server.inject({ method: "POST", url: "/api/medical-equipment", headers: { authorization: `Bearer ${TOKEN}` }, payload: INPUT });
  assert.equal(create.statusCode, 201);
  assert.equal(repository.created.length, 1);
  const calibration = await server.inject({ method: "POST", url: `/api/medical-equipment/${ID}/calibrations`, headers: { authorization: `Bearer ${TOKEN}` }, payload: { performed_on: "2026-09-01", due_on: "2027-09-01", provider: "Vendor", certificate_number: "CAL/JKT/2026/008812", result: "passed", notes: null, source: "manual" } });
  assert.equal(calibration.statusCode, 201);
  assert.equal(calibration.json().data.record_number, "CAL-2026-000001");
  const service = await server.inject({ method: "POST", url: `/api/medical-equipment/${ID}/services`, headers: { authorization: `Bearer ${TOKEN}` }, payload: { service_type: "preventive_maintenance", performed_on: "2026-09-01", next_due_on: "2027-03-01", provider: null, technician: null, result: "completed", notes: null, source: "manual" } });
  assert.equal(service.statusCode, 201);
  assert.equal(service.json().data.record_number, "SRV-2026-000001");
  await server.close();
});

test("duplicate and linked asset conflicts are safely normalized without database details", async () => {
  const repository = new FakeMedicalRepository();
  repository.create = async () => { throw new MedicalRepositoryError("NETWORK_ASSET_ALREADY_LINKED"); };
  const server = buildServer({ logger: false, medicalEquipment: { token: TOKEN, repository } });
  const response = await server.inject({ method: "POST", url: "/api/medical-equipment", headers: { authorization: `Bearer ${TOKEN}` }, payload: INPUT });
  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.json(), { error: { code: "NETWORK_ASSET_ALREADY_LINKED", message: "Network asset is already linked to medical equipment" } });
  assert.doesNotMatch(response.body, /postgres|constraint|secret/i);
  await server.close();
});

test("P10F migration is additive, bounded, linked safely and uses concurrency-safe sequences", () => {
  const sql = readFileSync(new URL("../migrations/006_medical_equipment.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS asset\.medical_equipment/);
  assert.match(sql, /network_asset_id uuid REFERENCES asset\.assets\(id\) ON DELETE SET NULL/);
  assert.match(sql, /medical_equipment_network_asset_unique_idx[\s\S]*WHERE network_asset_id IS NOT NULL/);
  assert.match(sql, /CREATE SEQUENCE IF NOT EXISTS asset\.medical_calibration_record_number_seq/);
  assert.match(sql, /performed_on date NOT NULL/);
  assert.match(sql, /CHECK \(due_on IS NULL OR due_on >= performed_on\)/);
  assert.doesNotMatch(sql, /DROP\s+(?:TABLE|SCHEMA|DATABASE)|TRUNCATE|REFERENCES\s+(?:public|auth)\./i);
});

test("repository uses lateral latest records, bounded histories, batched links and fixed generated identifiers", () => {
  const source = readFileSync(new URL("../src/medical-equipment/repository.ts", import.meta.url), "utf8");
  assert.match(source, /LEFT JOIN LATERAL/);
  assert.match(source, /medical_calibration_record_number_seq/);
  assert.match(source, /medical_service_record_number_seq/);
  assert.match(source, /lpad\(nextval/);
  assert.match(source, /network_asset_id = ANY\(\$1::uuid\[\]\) LIMIT 50/);
  assert.match(source, /LIMIT \$\{MEDICAL_HISTORY_LIMIT\}/);
  assert.match(
    source,
    /FROM medical_view WHERE id = \$3::text/,
  );

  assert.doesNotMatch(
    source,
    /FROM medical_view WHERE id = \$3::uuid/,
  );

  // Latest service can be any service type, but the maintenance schedule
  // must remain driven by the latest preventive-maintenance record only.
  assert.match(source, /service\.performed_on::text AS latest_service_on/);
  assert.match(source, /maintenance\.next_due_on::text AS maintenance_due_on/);
  assert.match(source, /s\.service_type = 'preventive_maintenance'/);
  assert.match(source, /WHEN maintenance\.id IS NULL[\s\S]*maintenance\.next_due_on/);
  assert.doesNotMatch(source, /service\.next_due_on::text AS maintenance_due_on/);
  assert.doesNotMatch(source, /WHEN service\.id IS NULL[\s\S]*AS maintenance_status/);

  assert.doesNotMatch(source, /SELECT max\(|SELECT count\(\*\).*record_number/i);
});
