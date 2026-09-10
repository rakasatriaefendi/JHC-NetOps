export const ASSET_CHANGE_FIELDS = ["name", "hostname", "ip_address", "mac_address", "vendor", "platform", "device_type", "status", "open_ports", "detected_services"] as const;
export type AssetChangeField = (typeof ASSET_CHANGE_FIELDS)[number];
export type AssetChangeEventType = "created" | "changed";

export type AssetChangeSnapshot = Readonly<{
  name: string;
  hostname: string | null;
  ip_address: string | null;
  mac_address: string | null;
  vendor: string | null;
  platform: string | null;
  device_type: string;
  status: "online" | "offline" | "changed" | "unknown";
  open_ports: readonly number[];
  detected_services: readonly Readonly<{ protocol: "tcp" | "udp"; port: number; name: string; product?: string; version?: string; extra_info?: string; tunnel?: string }>[];
}>;

export type AssetChangeEvent = Readonly<{
  id: string;
  asset_id: string | null;
  scan_run_id: string | null;
  asset_stable_key: string;
  event_type: AssetChangeEventType;
  source: "manual" | "discovery" | "observed_host" | "device_inspector" | "managed_telemetry" | "active_scan" | "import";
  observed_at: string;
  recorded_at: string;
  changed_fields: readonly AssetChangeField[];
  before_state: AssetChangeSnapshot | null;
  after_state: AssetChangeSnapshot;
}>;

export type AssetChangeData = Readonly<{
  events: readonly AssetChangeEvent[];
  server_time: string;
  pagination: Readonly<{ page: number; page_size: number; total: number; pages: number }>;
}>;

export type AssetChangeHistoryQuery = Readonly<{
  q?: string;
  event_type?: string;
  source?: string;
  changed_field?: string;
  page?: string;
  page_size?: string;
  tab?: string;
}>;

export function validAssetChangePayload(value: unknown): value is { data: AssetChangeData } {
  if (!record(value) || !record(value.data)) return false;
  const data = value.data;
  return typeof data.server_time === "string" && Number.isFinite(Date.parse(data.server_time))
    && Array.isArray(data.events) && data.events.length <= 50 && data.events.every(validEvent)
    && record(data.pagination)
    && [data.pagination.page, data.pagination.page_size, data.pagination.total, data.pagination.pages]
      .every((item) => Number.isSafeInteger(item) && Number(item) >= 0);
}

export function isNewNetworkAsset(asset: Readonly<{ source: string; first_seen_at: string | null }>, serverTime: string): boolean {
  if (!isNetworkDiscoveredSource(asset.source) || !asset.first_seen_at) return false;
  const firstSeen = Date.parse(asset.first_seen_at);
  const now = Date.parse(serverTime);
  if (!Number.isFinite(firstSeen) || !Number.isFinite(now)) return false;
  const age = now - firstSeen;
  return age >= 0 && age <= 24 * 60 * 60 * 1_000;
}

export function isNetworkDiscoveredSource(source: string): boolean {
  return ["active_scan", "discovery", "observed_host"].includes(source);
}

function validEvent(value: unknown): boolean {
  return record(value) && typeof value.id === "string"
    && (value.asset_id === null || typeof value.asset_id === "string")
    && (value.scan_run_id === null || typeof value.scan_run_id === "string")
    && typeof value.asset_stable_key === "string" && value.asset_stable_key.length <= 300
    && (value.event_type === "created" || value.event_type === "changed")
    && ["manual", "discovery", "observed_host", "device_inspector", "managed_telemetry", "active_scan", "import"].includes(String(value.source))
    && typeof value.observed_at === "string" && Number.isFinite(Date.parse(value.observed_at))
    && typeof value.recorded_at === "string" && Number.isFinite(Date.parse(value.recorded_at))
    && Array.isArray(value.changed_fields) && value.changed_fields.length <= ASSET_CHANGE_FIELDS.length
    && value.changed_fields.every((field) => ASSET_CHANGE_FIELDS.includes(field as AssetChangeField))
    && (value.before_state === null || validSnapshot(value.before_state)) && validSnapshot(value.after_state);
}

function validSnapshot(value: unknown): boolean {
  return record(value) && typeof value.name === "string" && value.name.length <= 200
    && optionalString(value.hostname, 255) && optionalString(value.ip_address, 64)
    && optionalString(value.mac_address, 17) && optionalString(value.vendor, 200)
    && optionalString(value.platform, 200) && typeof value.device_type === "string" && value.device_type.length <= 64
    && ["online", "offline", "changed", "unknown"].includes(String(value.status))
    && Array.isArray(value.open_ports) && value.open_ports.length <= 32
    && value.open_ports.every((port) => Number.isSafeInteger(port) && Number(port) >= 1 && Number(port) <= 65_535)
    && Array.isArray(value.detected_services) && value.detected_services.length <= 32
    && value.detected_services.every(validService);
}

function validService(value: unknown): boolean {
  return record(value) && (value.protocol === "tcp" || value.protocol === "udp")
    && Number.isSafeInteger(value.port) && Number(value.port) >= 1 && Number(value.port) <= 65_535
    && typeof value.name === "string" && value.name.length <= 100
    && optionalUndefinedString(value.product, 160) && optionalUndefinedString(value.version, 100)
    && optionalUndefinedString(value.extra_info, 160) && optionalUndefinedString(value.tunnel, 32);
}

function optionalString(value: unknown, maximum: number): boolean {
  return value === null || typeof value === "string" && value.length <= maximum;
}

function optionalUndefinedString(value: unknown, maximum: number): boolean {
  return value === undefined || typeof value === "string" && value.length <= maximum;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
