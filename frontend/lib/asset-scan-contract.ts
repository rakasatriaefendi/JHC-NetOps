export type AssetScanMode = "quick" | "deep";
export type AssetScanStatus = "running" | "completed" | "failed" | "cancelled";

export type AssetScanRecord = Readonly<{
  id: string;
  mode: AssetScanMode;
  network: string;
  status: AssetScanStatus;
  discovered_count: number;
  fingerprinted_count: number;
  failed_count: number;
  current_target: string | null;
  started_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
  error_code: string | null;
}>;

export type AssetScanState = Readonly<{
  available: boolean;
  networks: readonly string[];
  network_options?: readonly Readonly<{ name: string | null; cidr: string; route_kind: "direct" | "routed" }>[];
  current: AssetScanRecord | null;
  last: AssetScanRecord | null;
}>;

export function validAssetScanState(value: unknown): value is AssetScanState {
  return record(value) && typeof value.available === "boolean"
    && Array.isArray(value.networks) && value.networks.length <= 8 && value.networks.every((item) => typeof item === "string")
    && (value.network_options === undefined || Array.isArray(value.network_options) && value.network_options.length <= 8
      && value.network_options.every((item) => record(item) && (item.name === null || typeof item.name === "string")
        && typeof item.cidr === "string" && (item.route_kind === "direct" || item.route_kind === "routed")))
    && (value.current === null || validScan(value.current)) && (value.last === null || validScan(value.last));
}

function validScan(value: unknown): value is AssetScanRecord {
  return record(value) && typeof value.id === "string" && (value.mode === "quick" || value.mode === "deep")
    && typeof value.network === "string" && ["running", "completed", "failed", "cancelled"].includes(String(value.status))
    && [value.discovered_count, value.fingerprinted_count, value.failed_count].every(validCount)
    && (value.current_target === null || typeof value.current_target === "string")
    && validDate(value.started_at) && (value.completed_at === null || validDate(value.completed_at))
    && (value.cancelled_at === null || validDate(value.cancelled_at))
    && (value.error_code === null || typeof value.error_code === "string" && value.error_code.length <= 64);
}

function validCount(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1_024;
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
