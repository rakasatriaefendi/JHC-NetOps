export const ASSET_PAGE_SIZES = [10, 25, 50] as const;
export const ASSET_STATUSES = ["online", "offline", "changed", "unknown"] as const;
export const ASSET_SORTS = ["name_asc", "name_desc"] as const;
export const MAX_ASSET_SEARCH_LENGTH = 100;
export const MAX_ASSET_FILTER_LENGTH = 200;

export type AssetStatus = (typeof ASSET_STATUSES)[number];
export type AssetSort = (typeof ASSET_SORTS)[number];

export type AssetListQuery = Readonly<{
  search: string;
  deviceType: string | null;
  vendor: string | null;
  platform: string | null;
  status: AssetStatus | null;
  sort: AssetSort;
  page: number;
  pageSize: (typeof ASSET_PAGE_SIZES)[number];
}>;

export type AssetSummary = Readonly<{
  total: number;
  online: number;
  offline: number;
  changed: number;
}>;

export type AssetRecord = Readonly<{
  id: string;
  name: string;
  hostname: string | null;
  device_type: string;
  status: AssetStatus;
  ip_address: string | null;
  mac_address: string | null;
  vendor: string | null;
  platform: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  source: string;
  classification_confidence: "low" | "medium" | "high" | null;
  os_confidence: "low" | "medium" | "high" | null;
  classification_evidence: readonly Readonly<{ source: string; label: string; value: string }>[];
  open_ports: readonly number[];
  detected_services: readonly Readonly<{
    protocol: "tcp" | "udp";
    port: number;
    name: string;
    product?: string;
    version?: string;
    extra_info?: string;
    tunnel?: string;
  }>[];
  latency_ms: number | null;
  evidence_updated_at: string | null;
  network_node_ref: string | null;
  health_target_ref: string | null;
  managed_telemetry_target_ref: string | null;
  observed_host_target_ref: string | null;
}>;

export type AssetListResponse = Readonly<{
  items: readonly AssetRecord[];
  summary: AssetSummary;
  device_types: readonly string[];
  insights: Readonly<{
    platforms: readonly Readonly<{ value: string; count: number }>[];
    vendors: readonly Readonly<{ value: string; count: number }>[];
    vendor_device_types: readonly Readonly<{ vendor: string; device_type: string; count: number }>[];
  }>;
  pagination: Readonly<{ page: number; page_size: number; total: number; pages: number }>;
}>;

export function validateAssetListQuery(value: unknown):
  | { ok: true; value: AssetListQuery }
  | { ok: false; message: string } {
  if (!record(value)) return { ok: false, message: "Asset query is invalid" };
  const allowed = new Set(["q", "device_type", "vendor", "platform", "status", "sort", "page", "page_size"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    return { ok: false, message: "Asset query contains unsupported fields" };
  }
  const search = single(value.q)?.trim() ?? "";
  if (search.length > MAX_ASSET_SEARCH_LENGTH || /[\u0000-\u001f]/.test(search)) {
    return { ok: false, message: "Asset search is invalid" };
  }
  const deviceTypeValue = single(value.device_type)?.trim() ?? "";
  if (deviceTypeValue.length > 64 || (deviceTypeValue && !/^[a-z0-9][a-z0-9_-]*$/i.test(deviceTypeValue))) {
    return { ok: false, message: "Asset device type is invalid" };
  }
  const vendorValue = boundedFilter(single(value.vendor));
  const platformValue = boundedFilter(single(value.platform));
  if (vendorValue === false || platformValue === false) {
    return { ok: false, message: "Asset evidence filter is invalid" };
  }
  const statusValue = single(value.status)?.trim() ?? "";
  if (statusValue && !ASSET_STATUSES.includes(statusValue as AssetStatus)) {
    return { ok: false, message: "Asset status is invalid" };
  }
  const sortValue = single(value.sort)?.trim() || "name_asc";
  if (!ASSET_SORTS.includes(sortValue as AssetSort)) return { ok: false, message: "Asset sort is invalid" };
  const page = positiveInteger(single(value.page), 1);
  const pageSize = positiveInteger(single(value.page_size), 10);
  if (!page || !ASSET_PAGE_SIZES.includes(pageSize as (typeof ASSET_PAGE_SIZES)[number])) {
    return { ok: false, message: "Asset pagination is invalid" };
  }
  return {
    ok: true,
    value: {
      search,
      deviceType: deviceTypeValue || null,
      vendor: vendorValue || null,
      platform: platformValue || null,
      status: (statusValue || null) as AssetStatus | null,
      sort: sortValue as AssetSort,
      page,
      pageSize: pageSize as (typeof ASSET_PAGE_SIZES)[number],
    },
  };
}

function boundedFilter(value: string | undefined): string | false {
  const text = value?.trim() ?? "";
  return text.length <= MAX_ASSET_FILTER_LENGTH && !/[\u0000-\u001f\u007f]/.test(text) ? text : false;
}

export function validateAssetId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 1_000_000 ? parsed : 0;
}

function single(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === "string") return value[0];
  return undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
