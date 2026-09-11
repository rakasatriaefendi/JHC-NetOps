import type { AssetInventoryQuery } from "@/lib/assets";

export function assetExportHref(query: AssetInventoryQuery, language: "id" | "en"): string {
  const params = new URLSearchParams();
  for (const key of ["q", "device_type", "vendor", "platform", "status", "sort"] as const) {
    const value = query[key];
    if (value) params.set(key, value);
  }
  params.set("lang", language);
  return `/assets/export?${params}`;
}
