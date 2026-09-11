export type OperationalStatus = "active" | "in_maintenance" | "out_of_service" | "retired";
export type CalibrationStatus = "not_required" | "not_recorded" | "valid" | "due_soon" | "overdue";
export type MaintenanceStatus = "not_scheduled" | "ok" | "due_soon" | "overdue";
export type RecordSource = "manual" | "import" | "integration";

export type NetworkAssetOption = Readonly<{ id: string; name: string; hostname: string | null; ip_address: string | null; mac_address: string | null; device_type: string; vendor: string | null; status: "online" | "offline" | "changed" | "unknown" }>;
export type MedicalEquipmentInput = Readonly<{
  equipment_code: string; name: string; manufacturer: string | null; model: string | null; serial_number: string | null;
  department: string | null; location: string | null; operational_status: OperationalStatus; network_asset_id: string | null;
  calibration_required: boolean; calibration_interval_months: number | null; maintenance_interval_months: number | null; notes: string | null;
}>;
export type MedicalEquipmentRecord = MedicalEquipmentInput & Readonly<{
  id: string; created_at: string; updated_at: string; calibration_status: CalibrationStatus; maintenance_status: MaintenanceStatus;
  latest_calibration_on: string | null; calibration_due_on: string | null; latest_service_on: string | null; maintenance_due_on: string | null;
  network_asset: NetworkAssetOption | null;
}>;
export type CalibrationRecord = Readonly<{
  id: string; record_number: string; performed_on: string; due_on: string | null; provider: string | null;
  certificate_number: string | null; result: "passed" | "conditional" | "failed"; notes: string | null; source: RecordSource; created_at: string; updated_at: string;
}>;
export type ServiceRecord = Readonly<{
  id: string; record_number: string; service_type: "preventive_maintenance" | "corrective_maintenance" | "inspection" | "repair" | "other";
  performed_on: string; next_due_on: string | null; provider: string | null; technician: string | null; result: "completed" | "follow_up_required" | "failed";
  notes: string | null; source: RecordSource; created_at: string; updated_at: string;
}>;
export type MedicalEquipmentDetail = Readonly<{ equipment: MedicalEquipmentRecord; calibrations: readonly CalibrationRecord[]; services: readonly ServiceRecord[] }>;
export type MedicalListData = Readonly<{
  items: readonly MedicalEquipmentRecord[];
  summary: Readonly<{ total: number; calibration_overdue: number; calibration_due_soon: number; maintenance_overdue: number; maintenance_due_soon: number; network_linked: number }>;
  filters: Readonly<{ departments: readonly string[]; locations: readonly string[] }>;
  pagination: Readonly<{ page: number; page_size: number; total: number; pages: number }>;
}>;
export type MedicalListParams = Readonly<Record<"q" | "department" | "location" | "operational_status" | "calibration_status" | "maintenance_status" | "network_link" | "page" | "page_size", string | undefined>>;

export function addCalendarMonths(date: string, months: number): string {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day || !Number.isSafeInteger(months) || months < 1 || months > 120) return "";
  const target = year * 12 + month - 1 + months;
  const targetYear = Math.floor(target / 12);
  const targetMonth = target % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return `${targetYear.toString().padStart(4, "0")}-${(targetMonth + 1).toString().padStart(2, "0")}-${Math.min(day, lastDay).toString().padStart(2, "0")}`;
}

export function splitCertificateReference(value: string): { prefix: string; year: string; sequence: string } | null {
  const match = value.trim().match(/^(.{1,180}\/)(\d{4})\/(\d{1,40})$/);
  return match ? { prefix: match[1] ?? "", year: match[2] ?? "", sequence: match[3] ?? "" } : null;
}

export function splitGuidedCertificateReference(value: string): { code: string; unit: string; year: string; reference: string } | null {
  const match = value.trim().match(/^([^/]{1,80})\/([^/]{1,80})\/(\d{4})\/([^/]{1,60})$/);
  return match ? { code: match[1] ?? "", unit: match[2] ?? "", year: match[3] ?? "", reference: match[4] ?? "" } : null;
}

export function joinCertificateReference(prefix: string, year: string, sequence: string): string {
  const normalizedPrefix = prefix.trim().replace(/\/+$/, "");
  return [normalizedPrefix, year.trim(), sequence.trim()].filter(Boolean).join("/").slice(0, 240);
}
