import { ASSET_CHANGE_FIELDS, type AssetChangeField, type AssetChangeSnapshot } from "./change.js";

export const ASSET_CHANGE_EVENT_TYPES = ["created", "changed"] as const;
export const ASSET_CHANGE_SOURCES = ["manual", "discovery", "observed_host", "device_inspector", "managed_telemetry", "active_scan", "import"] as const;
export const ASSET_CHANGE_PAGE_SIZES = [10, 25, 50] as const;

export type AssetChangeEventType = (typeof ASSET_CHANGE_EVENT_TYPES)[number];
export type AssetChangeSource = (typeof ASSET_CHANGE_SOURCES)[number];

export type AssetChangeEvent = Readonly<{
  id: string;
  asset_id: string | null;
  scan_run_id: string | null;
  asset_stable_key: string;
  event_type: AssetChangeEventType;
  source: AssetChangeSource;
  observed_at: string;
  recorded_at: string;
  changed_fields: readonly AssetChangeField[];
  before_state: AssetChangeSnapshot | null;
  after_state: AssetChangeSnapshot;
}>;

export type AssetChangeQuery = Readonly<{
  search: string;
  eventType: AssetChangeEventType | null;
  source: AssetChangeSource | null;
  changedField: AssetChangeField | null;
  assetId: string | null;
  page: number;
  pageSize: (typeof ASSET_CHANGE_PAGE_SIZES)[number];
}>;

export type AssetChangeListResponse = Readonly<{
  events: readonly AssetChangeEvent[];
  pagination: Readonly<{ page: number; page_size: number; total: number; pages: number }>;
}>;

export function validateAssetChangeQuery(value: unknown):
  | { ok: true; value: Omit<AssetChangeQuery, "assetId"> }
  | { ok: false; message: string } {
  if (!record(value)) return { ok: false, message: "Asset change query is invalid" };
  const allowed = new Set(["q", "event_type", "source", "changed_field", "page", "page_size"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return { ok: false, message: "Asset change query contains unsupported fields" };
  const search = single(value.q)?.trim() ?? "";
  if (search.length > 100 || /[\u0000-\u001f\u007f]/.test(search)) return { ok: false, message: "Asset change search is invalid" };
  const eventType = single(value.event_type)?.trim() ?? "";
  if (eventType && !ASSET_CHANGE_EVENT_TYPES.includes(eventType as AssetChangeEventType)) return { ok: false, message: "Asset change event type is invalid" };
  const source = single(value.source)?.trim() ?? "";
  if (source && !ASSET_CHANGE_SOURCES.includes(source as AssetChangeSource)) return { ok: false, message: "Asset change source is invalid" };
  const changedField = single(value.changed_field)?.trim() ?? "";
  if (changedField && !ASSET_CHANGE_FIELDS.includes(changedField as AssetChangeField)) return { ok: false, message: "Asset changed field is invalid" };
  const page = positiveInteger(single(value.page), 1);
  const pageSize = positiveInteger(single(value.page_size), 25);
  if (!page || !ASSET_CHANGE_PAGE_SIZES.includes(pageSize as (typeof ASSET_CHANGE_PAGE_SIZES)[number])) return { ok: false, message: "Asset change pagination is invalid" };
  return {
    ok: true,
    value: {
      search,
      eventType: eventType ? eventType as AssetChangeEventType : null,
      source: source ? source as AssetChangeSource : null,
      changedField: changedField ? changedField as AssetChangeField : null,
      page,
      pageSize: pageSize as (typeof ASSET_CHANGE_PAGE_SIZES)[number],
    },
  };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 1_000_000 ? parsed : 0;
}

function single(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
