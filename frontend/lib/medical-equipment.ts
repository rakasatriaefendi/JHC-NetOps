import "server-only";

import { localBackendConfig } from "@/lib/assets";
import type {
  CalibrationRecord,
  MedicalEquipmentDetail,
  MedicalEquipmentInput,
  MedicalEquipmentRecord,
  MedicalListData,
  MedicalListParams,
  NetworkAssetOption,
  ServiceRecord,
} from "@/lib/medical-equipment-contract";

export type MedicalBackendResult<T> = Readonly<{ data: T | null; error: string | null }>;

export async function loadMedicalEquipment(query: Partial<MedicalListParams>): Promise<MedicalBackendResult<MedicalListData>> {
  const params = new URLSearchParams();
  for (const key of ["q", "department", "location", "operational_status", "calibration_status", "maintenance_status", "network_link", "page", "page_size"] as const) {
    const value = query[key];
    if (value) params.set(key, value);
  }
  const result = await request("GET", `/api/medical-equipment${params.size ? `?${params}` : ""}`);
  return result.ok && validList(result.payload) ? { data: result.payload.data, error: null } : { data: null, error: result.error };
}

export async function loadMedicalEquipmentDetail(id: string): Promise<MedicalBackendResult<MedicalEquipmentDetail>> {
  if (!uuid(id)) return { data: null, error: "INVALID_MEDICAL_ID" };
  const result = await request("GET", `/api/medical-equipment/${id}`);
  return result.ok && record(result.payload) && validDetail(result.payload.data) ? { data: result.payload.data, error: null } : { data: null, error: result.error };
}

export async function createMedicalEquipment(input: MedicalEquipmentInput): Promise<MedicalBackendResult<MedicalEquipmentRecord>> {
  return mutation("POST", "/api/medical-equipment", input, validEquipment);
}
export async function updateMedicalEquipment(id: string, input: MedicalEquipmentInput): Promise<MedicalBackendResult<MedicalEquipmentRecord>> {
  return uuid(id) ? mutation("PATCH", `/api/medical-equipment/${id}`, input, validEquipment) : { data: null, error: "INVALID_MEDICAL_ID" };
}
export async function createCalibration(id: string, input: Omit<CalibrationRecord, "id" | "record_number" | "created_at" | "updated_at">): Promise<MedicalBackendResult<CalibrationRecord>> {
  return uuid(id) ? mutation("POST", `/api/medical-equipment/${id}/calibrations`, input, validCalibration) : { data: null, error: "INVALID_MEDICAL_ID" };
}
export async function createService(id: string, input: Omit<ServiceRecord, "id" | "record_number" | "created_at" | "updated_at">): Promise<MedicalBackendResult<ServiceRecord>> {
  return uuid(id) ? mutation("POST", `/api/medical-equipment/${id}/services`, input, validService) : { data: null, error: "INVALID_MEDICAL_ID" };
}
export async function searchMedicalNetworkAssets(search: string): Promise<MedicalBackendResult<readonly NetworkAssetOption[]>> {
  if (search.length > 100) return { data: null, error: "INVALID_MEDICAL_QUERY" };
  const result = await request("GET", `/api/medical-equipment/network-assets?q=${encodeURIComponent(search)}`);
  return result.ok && record(result.payload) && record(result.payload.data) && Array.isArray(result.payload.data.items) && result.payload.data.items.length <= 25 && result.payload.data.items.every(validNetworkAsset)
    ? { data: result.payload.data.items, error: null } : { data: null, error: result.error };
}
export async function loadMedicalNetworkLinks(assetIds: readonly string[]) {
  const ids = assetIds.filter(uuid).slice(0, 50);
  if (!ids.length) return { data: [] as readonly Readonly<{ network_asset_id: string; medical_equipment_id: string; equipment_code: string; name: string; department: string | null; location: string | null }>[], error: null };
  const result = await request("GET", `/api/medical-equipment/network-links?asset_ids=${encodeURIComponent(ids.join(","))}`);
  const items = record(result.payload) && record(result.payload.data) ? result.payload.data.items : null;
  return result.ok && Array.isArray(items) && items.length <= 50 && items.every(validLink) ? { data: items, error: null } : { data: null, error: result.error };
}

async function mutation<T>(method: "POST" | "PATCH", path: string, body: object, validator: (value: unknown) => value is T): Promise<MedicalBackendResult<T>> {
  const result = await request(method, path, body);
  return result.ok && record(result.payload) && validator(result.payload.data) ? { data: result.payload.data, error: null } : { data: null, error: result.error };
}
async function request(method: "GET" | "POST" | "PATCH", path: string, body?: object): Promise<{ ok: boolean; payload: unknown; error: string }> {
  const config = localBackendConfig();
  if (!config) return { ok: false, payload: null, error: "MEDICAL_EQUIPMENT_UNCONFIGURED" };
  try {
    const response = await fetch(new URL(path, config.origin), { method, headers: { authorization: `Bearer ${config.token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), cache: "no-store", signal: AbortSignal.timeout(12_000) });
    const payload: unknown = await response.json();
    return { ok: response.ok, payload, error: response.ok ? "" : safeCode(payload) };
  } catch { return { ok: false, payload: null, error: "MEDICAL_EQUIPMENT_UNAVAILABLE" }; }
}
function safeCode(value: unknown): string {
  const code = record(value) && record(value.error) && typeof value.error.code === "string" ? value.error.code : "";
  return ["INVALID_MEDICAL_QUERY", "INVALID_MEDICAL_ID", "INVALID_MEDICAL_EQUIPMENT", "INVALID_CALIBRATION", "INVALID_SERVICE", "MEDICAL_EQUIPMENT_NOT_FOUND", "MEDICAL_EQUIPMENT_DUPLICATE", "NETWORK_ASSET_ALREADY_LINKED", "NETWORK_ASSET_NOT_FOUND"].includes(code) ? code : "MEDICAL_EQUIPMENT_UNAVAILABLE";
}
function validList(value: unknown): value is { data: MedicalListData } { return record(value) && record(value.data) && Array.isArray(value.data.items) && value.data.items.length <= 50 && value.data.items.every(validEquipment) && record(value.data.summary) && record(value.data.filters) && record(value.data.pagination); }
function validDetail(value: unknown): value is MedicalEquipmentDetail { return record(value) && validEquipment(value.equipment) && Array.isArray(value.calibrations) && value.calibrations.length <= 200 && value.calibrations.every(validCalibration) && Array.isArray(value.services) && value.services.length <= 200 && value.services.every(validService); }
function validEquipment(value: unknown): value is MedicalEquipmentRecord { return record(value) && uuid(value.id) && typeof value.equipment_code === "string" && typeof value.name === "string" && ["active", "in_maintenance", "out_of_service", "retired"].includes(String(value.operational_status)) && ["not_required", "not_recorded", "valid", "due_soon", "overdue"].includes(String(value.calibration_status)) && ["not_scheduled", "ok", "due_soon", "overdue"].includes(String(value.maintenance_status)) && (value.network_asset === null || validNetworkAsset(value.network_asset)); }
function validNetworkAsset(value: unknown): value is NetworkAssetOption { return record(value) && uuid(value.id) && typeof value.name === "string" && typeof value.device_type === "string" && (value.vendor === null || typeof value.vendor === "string") && ["online", "offline", "changed", "unknown"].includes(String(value.status)); }
function validCalibration(value: unknown): value is CalibrationRecord { return record(value) && uuid(value.id) && typeof value.record_number === "string" && typeof value.performed_on === "string" && ["passed", "conditional", "failed"].includes(String(value.result)); }
function validService(value: unknown): value is ServiceRecord { return record(value) && uuid(value.id) && typeof value.record_number === "string" && typeof value.performed_on === "string" && ["preventive_maintenance", "corrective_maintenance", "inspection", "repair", "other"].includes(String(value.service_type)) && ["completed", "follow_up_required", "failed"].includes(String(value.result)); }
function validLink(value: unknown): boolean { return record(value) && uuid(value.network_asset_id) && uuid(value.medical_equipment_id) && typeof value.equipment_code === "string" && typeof value.name === "string" && (value.department === null || typeof value.department === "string") && (value.location === null || typeof value.location === "string"); }
function uuid(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
