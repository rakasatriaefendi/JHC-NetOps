export const OPERATIONAL_STATUSES = ["active", "in_maintenance", "out_of_service", "retired"] as const;
export const CALIBRATION_RESULTS = ["passed", "conditional", "failed"] as const;
export const SERVICE_TYPES = ["preventive_maintenance", "corrective_maintenance", "inspection", "repair", "other"] as const;
export const SERVICE_RESULTS = ["completed", "follow_up_required", "failed"] as const;
export const RECORD_SOURCES = ["manual", "import", "integration"] as const;

export type OperationalStatus = (typeof OPERATIONAL_STATUSES)[number];
export type CalibrationResult = (typeof CALIBRATION_RESULTS)[number];
export type ServiceType = (typeof SERVICE_TYPES)[number];
export type ServiceResult = (typeof SERVICE_RESULTS)[number];
export type RecordSource = (typeof RECORD_SOURCES)[number];
export type DueStatus = "not_required" | "not_recorded" | "valid" | "due_soon" | "overdue";
export type MaintenanceStatus = "not_scheduled" | "ok" | "due_soon" | "overdue";

export function addCalendarMonths(isoDate: string, months: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  if (!validDateParts(year, month, day) || !Number.isSafeInteger(months) || months < 1 || months > 120) {
    throw new Error("INVALID_MEDICAL_DATE");
  }
  const targetMonth = (year as number) * 12 + (month as number) - 1 + months;
  const targetYear = Math.floor(targetMonth / 12);
  const targetMonthIndex = targetMonth % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonthIndex + 1, 0)).getUTCDate();
  return `${targetYear.toString().padStart(4, "0")}-${(targetMonthIndex + 1).toString().padStart(2, "0")}-${Math.min(day as number, lastDay).toString().padStart(2, "0")}`;
}

export function calibrationDueStatus(required: boolean, dueOn: string | null, today: string, thresholdDays: number): DueStatus {
  if (!required) return "not_required";
  if (!dueOn) return "not_recorded";
  return datedStatus(dueOn, today, thresholdDays, "valid");
}

export function maintenanceDueStatus(dueOn: string | null, today: string, thresholdDays: number): MaintenanceStatus {
  if (!dueOn) return "not_scheduled";
  return datedStatus(dueOn, today, thresholdDays, "ok");
}

function datedStatus<T extends "valid" | "ok">(dueOn: string, today: string, thresholdDays: number, future: T): T | "due_soon" | "overdue" {
  const due = Date.parse(`${dueOn}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(due) || !Number.isFinite(now)) return "overdue";
  if (due < now) return "overdue";
  return due <= now + thresholdDays * 86_400_000 ? "due_soon" : future;
}

function validDateParts(year: number | undefined, month: number | undefined, day: number | undefined): boolean {
  if (!Number.isSafeInteger(year) || !Number.isSafeInteger(month) || !Number.isSafeInteger(day) ||
      (year as number) < 2000 || (year as number) > 2200 || (month as number) < 1 || (month as number) > 12 ||
      (day as number) < 1 || (day as number) > 31) return false;
  const parsed = new Date(Date.UTC(year as number, (month as number) - 1, day as number));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === (month as number) - 1 && parsed.getUTCDate() === day;
}
