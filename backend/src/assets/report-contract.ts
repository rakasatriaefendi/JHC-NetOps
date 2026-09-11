import { validateAssetListQuery, type AssetListQuery } from "./contract.js";

export const ASSET_REPORT_LANGUAGES = ["id", "en"] as const;
export const ASSET_REPORT_MAX_ASSETS = 2_000;
export const ASSET_REPORT_MAX_HISTORY_EVENTS = 10_000;
export const ASSET_REPORT_MAX_BYTES = 20 * 1024 * 1024;

export type AssetReportLanguage = (typeof ASSET_REPORT_LANGUAGES)[number];
export type AssetReportQuery = Readonly<{
  inventory: AssetListQuery;
  language: AssetReportLanguage;
}>;

export function validateAssetReportQuery(value: unknown):
  | { ok: true; value: AssetReportQuery }
  | { ok: false; message: string } {
  if (!record(value)) return { ok: false, message: "Asset report query is invalid" };
  const allowed = new Set(["q", "device_type", "vendor", "platform", "status", "sort", "lang"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    return { ok: false, message: "Asset report query contains unsupported fields" };
  }
  const language = single(value.lang) ?? "id";
  if (!ASSET_REPORT_LANGUAGES.includes(language as AssetReportLanguage)) {
    return { ok: false, message: "Asset report language is invalid" };
  }
  const inventoryInput = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "lang"));
  const inventory = validateAssetListQuery({ ...inventoryInput, page: "1", page_size: "10" });
  return inventory.ok
    ? { ok: true, value: { inventory: inventory.value, language: language as AssetReportLanguage } }
    : { ok: false, message: inventory.message };
}

function single(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === "string") return value[0];
  return undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
