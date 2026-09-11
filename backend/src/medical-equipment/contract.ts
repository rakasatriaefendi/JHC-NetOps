import {
  CALIBRATION_RESULTS,
  OPERATIONAL_STATUSES,
  RECORD_SOURCES,
  SERVICE_RESULTS,
  SERVICE_TYPES,
  type CalibrationResult,
  type DueStatus,
  type MaintenanceStatus,
  type OperationalStatus,
  type RecordSource,
  type ServiceResult,
  type ServiceType,
} from "./domain.js";

export const MEDICAL_PAGE_SIZES = [10, 25, 50] as const;
export const MEDICAL_MAX_PAGE_SIZE = 50;

export type MedicalEquipmentInput = Readonly<{
  equipment_code: string;
  name: string;
  manufacturer: string | null;
  model: string | null;
  serial_number: string | null;
  department: string | null;
  location: string | null;
  operational_status: OperationalStatus;
  network_asset_id: string | null;
  calibration_required: boolean;
  calibration_interval_months: number | null;
  maintenance_interval_months: number | null;
  notes: string | null;
}>;

export type CalibrationInput = Readonly<{
  performed_on: string;
  due_on: string | null;
  provider: string | null;
  certificate_number: string | null;
  result: CalibrationResult;
  notes: string | null;
  source: RecordSource;
}>;

export type ServiceInput = Readonly<{
  service_type: ServiceType;
  performed_on: string;
  next_due_on: string | null;
  provider: string | null;
  technician: string | null;
  result: ServiceResult;
  notes: string | null;
  source: RecordSource;
}>;

export type MedicalListQuery = Readonly<{
  search: string;
  department: string | null;
  location: string | null;
  operationalStatus: OperationalStatus | null;
  calibrationStatus: DueStatus | null;
  maintenanceStatus: MaintenanceStatus | null;
  networkLink: "linked" | "unlinked" | null;
  page: number;
  pageSize: (typeof MEDICAL_PAGE_SIZES)[number];
}>;

export type NetworkAssetOption = Readonly<{
  id: string;
  name: string;
  hostname: string | null;
  ip_address: string | null;
  mac_address: string | null;
  device_type: string;
  vendor: string | null;
  status: "online" | "offline" | "changed" | "unknown";
}>;

export type MedicalEquipmentRecord = MedicalEquipmentInput & Readonly<{
  id: string;
  created_at: string;
  updated_at: string;
  calibration_status: DueStatus;
  maintenance_status: MaintenanceStatus;
  latest_calibration_on: string | null;
  calibration_due_on: string | null;
  latest_service_on: string | null;
  maintenance_due_on: string | null;
  network_asset: NetworkAssetOption | null;
}>;

export type CalibrationRecord = CalibrationInput & Readonly<{
  id: string;
  record_number: string;
  created_at: string;
  updated_at: string;
}>;

export type ServiceRecord = ServiceInput & Readonly<{
  id: string;
  record_number: string;
  created_at: string;
  updated_at: string;
}>;

export type MedicalEquipmentDetail = Readonly<{
  equipment: MedicalEquipmentRecord;
  calibrations: readonly CalibrationRecord[];
  services: readonly ServiceRecord[];
}>;

export type MedicalListResponse = Readonly<{
  items: readonly MedicalEquipmentRecord[];
  summary: Readonly<{
    total: number;
    calibration_overdue: number;
    calibration_due_soon: number;
    maintenance_overdue: number;
    maintenance_due_soon: number;
    network_linked: number;
  }>;
  filters: Readonly<{ departments: readonly string[]; locations: readonly string[] }>;
  pagination: Readonly<{ page: number; page_size: number; total: number; pages: number }>;
}>;

export function validateMedicalListQuery(value: unknown): Result<MedicalListQuery> {
  if (!record(value)) return invalid("Medical equipment query is invalid");
  const allowed = new Set(["q", "department", "location", "operational_status", "calibration_status", "maintenance_status", "network_link", "page", "page_size"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return invalid("Medical equipment query contains unsupported fields");
  const search = queryText(value.q, 100);
  const department = queryText(value.department, 120);
  const location = queryText(value.location, 160);
  if (search === false || department === false || location === false) return invalid("Medical equipment filter is invalid");
  const operationalStatus = enumQuery(value.operational_status, OPERATIONAL_STATUSES);
  const calibrationStatus = enumQuery(value.calibration_status, ["not_required", "not_recorded", "valid", "due_soon", "overdue"] as const);
  const maintenanceStatus = enumQuery(value.maintenance_status, ["not_scheduled", "ok", "due_soon", "overdue"] as const);
  const networkLink = enumQuery(value.network_link, ["linked", "unlinked"] as const);
  if (operationalStatus === false || calibrationStatus === false || maintenanceStatus === false || networkLink === false) {
    return invalid("Medical equipment filter is invalid");
  }
  const page = positiveInteger(single(value.page), 1);
  const pageSize = positiveInteger(single(value.page_size), 10);
  if (!page || !MEDICAL_PAGE_SIZES.includes(pageSize as (typeof MEDICAL_PAGE_SIZES)[number])) return invalid("Medical equipment pagination is invalid");
  return { ok: true, value: {
    search: search || "", department: department || null, location: location || null,
    operationalStatus: operationalStatus || null, calibrationStatus: calibrationStatus || null,
    maintenanceStatus: maintenanceStatus || null, networkLink: networkLink || null,
    page, pageSize: pageSize as (typeof MEDICAL_PAGE_SIZES)[number],
  } };
}

export function validateMedicalEquipmentInput(value: unknown): Result<MedicalEquipmentInput> {
  if (!exactRecord(value, ["equipment_code", "name", "manufacturer", "model", "serial_number", "department", "location", "operational_status", "network_asset_id", "calibration_required", "calibration_interval_months", "maintenance_interval_months", "notes"])) {
    return invalid("Medical equipment payload is invalid");
  }
  const equipmentCode = requiredText(value.equipment_code, 80);
  const name = requiredText(value.name, 200);
  const manufacturer = nullableText(value.manufacturer, 160);
  const model = nullableText(value.model, 160);
  const serial = nullableText(value.serial_number, 160);
  const department = nullableText(value.department, 120);
  const location = nullableText(value.location, 160);
  const notes = nullableText(value.notes, 4_000, true);
  const status = enumValue(value.operational_status, OPERATIONAL_STATUSES);
  const networkAssetId = value.network_asset_id === null ? null : validUuid(value.network_asset_id) ? value.network_asset_id : false;
  const calibrationInterval = nullableInteger(value.calibration_interval_months, 1, 120);
  const maintenanceInterval = nullableInteger(value.maintenance_interval_months, 1, 120);
  if (!equipmentCode || !name || manufacturer === false || model === false || serial === false || department === false || location === false || notes === false ||
      !status || networkAssetId === false || typeof value.calibration_required !== "boolean" || calibrationInterval === false || maintenanceInterval === false) {
    return invalid("Medical equipment payload is invalid");
  }
  return { ok: true, value: {
    equipment_code: equipmentCode, name, manufacturer, model, serial_number: serial, department, location,
    operational_status: status, network_asset_id: networkAssetId,
    calibration_required: value.calibration_required, calibration_interval_months: calibrationInterval,
    maintenance_interval_months: maintenanceInterval, notes,
  } };
}

export function validateCalibrationInput(value: unknown): Result<CalibrationInput> {
  if (!exactRecord(value, ["performed_on", "due_on", "provider", "certificate_number", "result", "notes", "source"])) return invalid("Calibration payload is invalid");
  const performed = isoDate(value.performed_on);
  const due = value.due_on === null ? null : isoDate(value.due_on);
  const provider = nullableText(value.provider, 200);
  const certificate = nullableText(value.certificate_number, 240);
  const result = enumValue(value.result, CALIBRATION_RESULTS);
  const notes = nullableText(value.notes, 4_000, true);
  const source = enumValue(value.source, RECORD_SOURCES);
  if (!performed || due === false || provider === false || certificate === false || !result || notes === false || !source || (due && due < performed)) return invalid("Calibration payload is invalid");
  return { ok: true, value: { performed_on: performed, due_on: due, provider, certificate_number: certificate, result, notes, source } };
}

export function validateServiceInput(value: unknown): Result<ServiceInput> {
  if (!exactRecord(value, ["service_type", "performed_on", "next_due_on", "provider", "technician", "result", "notes", "source"])) return invalid("Service payload is invalid");
  const serviceType = enumValue(value.service_type, SERVICE_TYPES);
  const performed = isoDate(value.performed_on);
  const nextDue = value.next_due_on === null ? null : isoDate(value.next_due_on);
  const provider = nullableText(value.provider, 200);
  const technician = nullableText(value.technician, 200);
  const result = enumValue(value.result, SERVICE_RESULTS);
  const notes = nullableText(value.notes, 4_000, true);
  const source = enumValue(value.source, RECORD_SOURCES);
  if (!serviceType || !performed || nextDue === false || provider === false || technician === false || !result || notes === false || !source || (nextDue && nextDue < performed)) return invalid("Service payload is invalid");
  return { ok: true, value: { service_type: serviceType, performed_on: performed, next_due_on: nextDue, provider, technician, result, notes, source } };
}

export function validateMedicalId(value: unknown): value is string { return validUuid(value); }

type Result<T> = { ok: true; value: T } | { ok: false; message: string };
function invalid(message: string): { ok: false; message: string } { return { ok: false, message }; }
function exactRecord(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === allowed.length && Object.keys(value).every((key) => allowed.includes(key));
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function single(value: unknown): string | undefined { return typeof value === "string" ? value : Array.isArray(value) && value.length === 1 && typeof value[0] === "string" ? value[0] : undefined; }
function queryText(value: unknown, maximum: number): string | false {
  const text = single(value)?.trim() ?? "";
  return text.length <= maximum && !/[\u0000-\u001f\u007f]/.test(text) ? text : false;
}
function requiredText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= maximum && !/[\u0000-\u001f\u007f]/.test(text) ? text : null;
}
function nullableText(value: unknown, maximum: number, multiline = false): string | null | false {
  if (value === null || value === "") return null;
  if (typeof value !== "string") return false;
  const text = value.trim();
  const invalidControls = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  return text.length <= maximum && !invalidControls.test(text) ? text || null : false;
}
function enumValue<const T extends readonly string[]>(value: unknown, options: T): T[number] | null { return typeof value === "string" && options.includes(value as T[number]) ? value as T[number] : null; }
function enumQuery<const T extends readonly string[]>(value: unknown, options: T): T[number] | "" | false {
  const text = single(value)?.trim() ?? "";
  return !text || options.includes(text as T[number]) ? text as T[number] | "" : false;
}
function nullableInteger(value: unknown, minimum: number, maximum: number): number | null | false {
  return value === null ? null : Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum ? Number(value) : false;
}
function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return /^\d+$/.test(value) && Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 1_000_000 ? parsed : 0;
}
function isoDate(value: unknown): string | false {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value ? value : false;
}
function validUuid(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
