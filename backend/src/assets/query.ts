import type { AssetListQuery } from "./contract.js";

export function assetListWhere(query: AssetListQuery): { where: string; values: unknown[] } {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (query.search) {
    values.push(`%${query.search.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
    clauses.push(`(name ILIKE $${values.length} ESCAPE '\\'
      OR coalesce(hostname, '') ILIKE $${values.length} ESCAPE '\\'
      OR host(ip_address) ILIKE $${values.length} ESCAPE '\\'
      OR coalesce(mac_address::text, '') ILIKE $${values.length} ESCAPE '\\'
      OR coalesce(vendor, '') ILIKE $${values.length} ESCAPE '\\'
      OR coalesce(platform, '') ILIKE $${values.length} ESCAPE '\\')`);
  }
  if (query.deviceType) {
    values.push(query.deviceType);
    clauses.push(`device_type = $${values.length}`);
  }
  if (query.vendor) {
    values.push(query.vendor);
    clauses.push(`vendor = $${values.length}`);
  }
  if (query.platform) {
    values.push(query.platform);
    clauses.push(`platform = $${values.length}`);
  }
  if (query.status) {
    values.push(query.status);
    clauses.push(`status = $${values.length}`);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", values };
}

export function assetListOrder(query: AssetListQuery): string {
  return query.sort === "name_desc" ? "lower(name) DESC, id DESC" : "lower(name) ASC, id ASC";
}
