import "server-only";
import { validAssetIdentity, type AssetIdentityData } from "./asset-identity-contract.ts";

import { validAssetScanState, type AssetScanMode, type AssetScanRecord, type AssetScanState } from "./asset-scan-contract.ts";
import { validAssetChangePayload, type AssetChangeData, type AssetChangeHistoryQuery } from "./asset-change-contract.ts";
import { validConfiguredNetworks, validDetectedNetworks, validRoute, type ConfiguredScanNetwork, type DetectedScanNetwork, type ScanNetworkRoute } from "./scan-network-contract.ts";

export type AssetStatus = "online" | "offline" | "changed" | "unknown";
export type AssetSort = "name_asc" | "name_desc";

export type AssetRecord = Readonly<{
  id: string;
  identity_state?: "resolved" | "provisional" | "conflict";
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
  detected_services: readonly Readonly<{ protocol: "tcp" | "udp"; port: number; name: string; product?: string; version?: string; extra_info?: string; tunnel?: string }>[];
  latency_ms: number | null;
  evidence_updated_at: string | null;
  network_node_ref: string | null;
  health_target_ref: string | null;
  managed_telemetry_target_ref: string | null;
  observed_host_target_ref: string | null;
}>;

export type AssetInventoryData = Readonly<{
  server_time: string;
  items: readonly AssetRecord[];
  summary: Readonly<{ total: number; online: number; offline: number; changed: number }>;
  device_types: readonly string[];
  insights: Readonly<{
    platforms: readonly Readonly<{ value: string; count: number }>[];
    vendors: readonly Readonly<{ value: string; count: number }>[];
    vendor_device_types: readonly Readonly<{ vendor: string; device_type: string; count: number }>[];
  }>;
  pagination: Readonly<{ page: number; page_size: number; total: number; pages: number }>;
}>;

export type AssetInventoryQuery = Readonly<{
  q?: string;
  device_type?: string;
  vendor?: string;
  platform?: string;
  status?: string;
  sort?: string;
  page?: string;
  page_size?: string;
}>;

export type AssetReportDownload = Readonly<{ bytes: ArrayBuffer; filename: string }>;

export async function loadAssetInventory(query: AssetInventoryQuery): Promise<
  { data: AssetInventoryData | null; error: "unconfigured" | "unavailable" | null }
> {
  const backendUrl = process.env.LOCAL_BACKEND_URL?.trim();
  const token = process.env.LOCAL_BACKEND_FRONTEND_TOKEN?.trim();
  if (!backendUrl || !token) return { data: null, error: "unconfigured" };
  const origin = safeLoopbackOrigin(backendUrl);
  if (!origin || token.length < 32 || token.length > 512 || /[\r\n]/.test(token)) {
    return { data: null, error: "unconfigured" };
  }
  const url = new URL("/api/assets", origin);
  for (const key of ["q", "device_type", "vendor", "platform", "status", "sort", "page", "page_size"] as const) {
    const value = query[key];
    if (typeof value === "string" && value) url.searchParams.set(key, value);
  }
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return { data: null, error: "unavailable" };
    const payload: unknown = await response.json();
    return validAssetPayload(payload)
      ? { data: payload.data, error: null }
      : { data: null, error: "unavailable" };
  } catch {
    return { data: null, error: "unavailable" };
  }
}

export async function loadAssetInventoryReport(query: AssetInventoryQuery, language: "id" | "en"): Promise<
  { data: AssetReportDownload | null; error: "unconfigured" | "unavailable" | null }
> {
  const config = localBackendConfig();
  if (!config) return { data: null, error: "unconfigured" };
  const url = new URL("/api/assets/export.xlsx", config.origin);
  for (const key of ["q", "device_type", "vendor", "platform", "status", "sort"] as const) {
    const value = query[key];
    if (typeof value === "string" && value) url.searchParams.set(key, value);
  }
  url.searchParams.set("lang", language);
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${config.token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok || response.headers.get("content-type")?.split(";")[0] !== "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
      return { data: null, error: "unavailable" };
    }
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > 20 * 1024 * 1024) {
      return { data: null, error: "unavailable" };
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 20 * 1024 * 1024) return { data: null, error: "unavailable" };
    const filename = reportFilename(response.headers.get("content-disposition"));
    return filename ? { data: { bytes, filename }, error: null } : { data: null, error: "unavailable" };
  } catch {
    return { data: null, error: "unavailable" };
  }
}

function safeLoopbackOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
        url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null;
    return url.origin;
  } catch { return null; }
}

function reportFilename(value: string | null): string | null {
  const match = value?.match(/^attachment; filename="(JHC-NetOps-Asset-Inventory-\d{4}-\d{2}-\d{2}\.xlsx)"$/);
  return match?.[1] ?? null;
}

function validAssetPayload(value: unknown): value is { data: AssetInventoryData } {
  if (!record(value) || !record(value.data)) return false;
  const data = value.data;
  if (!Array.isArray(data.items) || data.items.length > 50 || !record(data.summary) ||
      !Array.isArray(data.device_types) || data.device_types.length > 256 || !record(data.pagination) || !record(data.insights)) return false;
  return typeof data.server_time === "string" && Number.isFinite(Date.parse(data.server_time)) &&
    validInsights(data.insights) && data.items.every(validAsset) &&
    [data.summary.total, data.summary.online, data.summary.offline, data.summary.changed,
      data.pagination.page, data.pagination.page_size, data.pagination.total, data.pagination.pages]
      .every((item) => typeof item === "number" && Number.isSafeInteger(item) && item >= 0);
}

function validAsset(item: unknown): boolean {
  return record(item) && typeof item.id === "string" && typeof item.name === "string"
    && (item.hostname === null || typeof item.hostname === "string")
    && typeof item.device_type === "string" && ["online", "offline", "changed", "unknown"].includes(String(item.status))
    && (item.classification_confidence === null || ["low", "medium", "high"].includes(String(item.classification_confidence)))
    && (item.os_confidence === null || ["low", "medium", "high"].includes(String(item.os_confidence)))
    && Array.isArray(item.open_ports) && item.open_ports.length <= 32
    && item.open_ports.every((port) => Number.isSafeInteger(port) && Number(port) >= 1 && Number(port) <= 65_535)
    && Array.isArray(item.detected_services) && item.detected_services.length <= 32
    && item.detected_services.every((service) => record(service) && (service.protocol === "tcp" || service.protocol === "udp")
      && Number.isSafeInteger(service.port) && Number(service.port) >= 1 && Number(service.port) <= 65_535 && typeof service.name === "string"
      && optionalString(service.product, 160) && optionalString(service.version, 100)
      && optionalString(service.extra_info, 160) && optionalString(service.tunnel, 32))
    && Array.isArray(item.classification_evidence) && item.classification_evidence.length <= 32
    && item.classification_evidence.every((evidence) => record(evidence) && typeof evidence.source === "string"
      && typeof evidence.label === "string" && typeof evidence.value === "string");
}

export async function loadAssetIdentity(id: string): Promise<{ data: AssetIdentityData | null; error: "unconfigured" | "unavailable" | null }> {
  const config = localBackendConfig();
  if (!config) return { data: null, error: "unconfigured" };
  try {
    const response = await fetch(new URL(`/api/assets/${encodeURIComponent(id)}/identity`, config.origin), {
      headers: { authorization: `Bearer ${config.token}` }, cache: "no-store", signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return { data: null, error: "unavailable" };
    const payload: unknown = await response.json();
    return validAssetIdentity(payload, id) ? { data: payload.data, error: null } : { data: null, error: "unavailable" };
  } catch { return { data: null, error: "unavailable" }; }
}

export async function loadAssetChangeHistory(query: AssetChangeHistoryQuery, assetId: string | null = null): Promise<
  { data: AssetChangeData | null; error: "unconfigured" | "unavailable" | null }
> {
  const config = localBackendConfig();
  if (!config) return { data: null, error: "unconfigured" };
  if (assetId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(assetId)) {
    return { data: null, error: "unavailable" };
  }
  const url = new URL(assetId ? `/api/assets/${assetId}/events` : "/api/assets/events", config.origin);
  for (const key of ["q", "event_type", "source", "changed_field", "page", "page_size"] as const) {
    const value = query[key];
    if (typeof value === "string" && value) url.searchParams.set(key, value);
  }
  try {
    const response = await fetch(url, { headers: { authorization: `Bearer ${config.token}` }, cache: "no-store", signal: AbortSignal.timeout(12_000) });
    if (!response.ok) return { data: null, error: "unavailable" };
    const payload: unknown = await response.json();
    return validAssetChangePayload(payload) ? { data: payload.data, error: null } : { data: null, error: "unavailable" };
  } catch { return { data: null, error: "unavailable" }; }
}

export async function loadAssetScanState(): Promise<{ data: AssetScanState | null; error: "unconfigured" | "unavailable" | null }> {
  const config = localBackendConfig();
  if (!config) return { data: null, error: "unconfigured" };
  try {
    const response = await fetch(new URL("/api/assets/scan", config.origin), {
      headers: { authorization: `Bearer ${config.token}` }, cache: "no-store", signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return { data: null, error: "unavailable" };
    const payload: unknown = await response.json();
    return record(payload) && validAssetScanState(payload.data)
      ? { data: payload.data, error: null }
      : { data: null, error: "unavailable" };
  } catch { return { data: null, error: "unavailable" }; }
}

export async function requestAssetScan(mode: AssetScanMode, network: string): Promise<
  { data: AssetScanRecord | null; error: string | null }
> {
  return mutateAssetScan("POST", "/api/assets/scan", { mode, network });
}

export async function cancelAssetScan(id: string): Promise<{ data: AssetScanRecord | null; error: string | null }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return { data: null, error: "INVALID_SCAN_ID" };
  }
  return mutateAssetScan("DELETE", `/api/assets/scan/${id}`, null);
}

export async function loadScanNetworks(): Promise<{ data: readonly ConfiguredScanNetwork[] | null; error: string | null }> {
  const result = await assetBackendRequest("GET", "/api/assets/scan-networks");
  return result.ok && validConfiguredNetworks(result.payload)
    ? { data: result.payload.data.networks, error: null }
    : { data: null, error: result.error ?? "SCAN_NETWORKS_UNAVAILABLE" };
}

export async function loadDetectedScanNetworks(): Promise<{ data: { available: boolean; networks: readonly DetectedScanNetwork[] } | null; error: string | null }> {
  const result = await assetBackendRequest("GET", "/api/assets/scan-networks/detected");
  return result.ok && validDetectedNetworks(result.payload)
    ? { data: { available: result.payload.data.available, networks: result.payload.data.networks }, error: null }
    : { data: null, error: result.error ?? "SCAN_NETWORKS_UNAVAILABLE" };
}

export async function testScanNetwork(cidr: string): Promise<{ data: ScanNetworkRoute | null; error: string | null }> {
  const result = await assetBackendRequest("POST", "/api/assets/scan-networks/test", { cidr });
  if (!result.ok || !record(result.payload) || !record(result.payload.data) || !validRoute(result.payload.data)) {
    return { data: null, error: result.error ?? "SCAN_NETWORKS_UNAVAILABLE" };
  }
  return { data: result.payload.data, error: null };
}

export async function createScanNetwork(name: string, cidr: string, origin: "manual" | "detected" = "manual") {
  const result = await assetBackendRequest("POST", "/api/assets/scan-networks", { name: name || null, cidr, origin });
  return { ok: result.ok, error: result.ok ? null : result.error ?? "SCAN_NETWORKS_UNAVAILABLE" };
}

export async function updateScanNetwork(id: string, change: { name?: string | null; enabled?: boolean }) {
  if (!validUuid(id)) return { ok: false, error: "INVALID_SCAN_NETWORK_ID" };
  const result = await assetBackendRequest("PATCH", `/api/assets/scan-networks/${id}`, change);
  return { ok: result.ok, error: result.ok ? null : result.error ?? "SCAN_NETWORKS_UNAVAILABLE" };
}

export async function deleteScanNetwork(id: string) {
  if (!validUuid(id)) return { ok: false, error: "INVALID_SCAN_NETWORK_ID" };
  const result = await assetBackendRequest("DELETE", `/api/assets/scan-networks/${id}`);
  return { ok: result.ok, error: result.ok ? null : result.error ?? "SCAN_NETWORKS_UNAVAILABLE" };
}

async function mutateAssetScan(method: "POST" | "DELETE", path: string, body: object | null) {
  const config = localBackendConfig();
  if (!config) return { data: null, error: "SCANNER_UNAVAILABLE" };
  try {
    const response = await fetch(new URL(path, config.origin), {
      method,
      headers: { authorization: `Bearer ${config.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
    const payload: unknown = await response.json();
    if (!response.ok) return { data: null, error: safeBackendCode(payload) };
    return record(payload) && validScanResponse(payload.data)
      ? { data: payload.data, error: null }
      : { data: null, error: "ASSET_SCAN_FAILED" };
  } catch { return { data: null, error: "ASSET_SCAN_FAILED" }; }
}

function validScanResponse(value: unknown): value is AssetScanRecord {
  return validAssetScanState({ available: true, networks: [], current: value, last: null });
}

function safeBackendCode(value: unknown): string {
  if (!record(value) || !record(value.error) || typeof value.error.code !== "string") return "ASSET_SCAN_FAILED";
  return ["SCAN_ALREADY_RUNNING", "SCANNER_UNAVAILABLE", "SCAN_NOT_RUNNING", "INVALID_SCAN_REQUEST", "SCAN_NETWORK_NOT_ALLOWED"].includes(value.error.code)
    ? value.error.code : "ASSET_SCAN_FAILED";
}

export function localBackendConfig(): { origin: string; token: string } | null {
  const backendUrl = process.env.LOCAL_BACKEND_URL?.trim();
  const token = process.env.LOCAL_BACKEND_FRONTEND_TOKEN?.trim();
  const origin = backendUrl ? safeLoopbackOrigin(backendUrl) : null;
  return origin && token && token.length >= 32 && token.length <= 512 && !/[\r\n]/.test(token) ? { origin, token } : null;
}

async function assetBackendRequest(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: object): Promise<{ ok: boolean; payload: unknown; error: string | null }> {
  const config = localBackendConfig();
  if (!config) return { ok: false, payload: null, error: "SCAN_NETWORKS_UNAVAILABLE" };
  try {
    const response = await fetch(new URL(path, config.origin), {
      method,
      headers: { authorization: `Bearer ${config.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
    const payload: unknown = response.status === 204 ? null : await response.json();
    return { ok: response.ok, payload, error: response.ok ? null : safeScanNetworkCode(payload) };
  } catch { return { ok: false, payload: null, error: "SCAN_NETWORKS_UNAVAILABLE" }; }
}

function safeScanNetworkCode(value: unknown): string {
  if (!record(value) || !record(value.error) || typeof value.error.code !== "string") return "SCAN_NETWORKS_UNAVAILABLE";
  return ["INVALID_SCAN_NETWORK", "SCAN_NETWORK_PUBLIC", "SCAN_NETWORK_TOO_BROAD", "INVALID_SCAN_NETWORK_NAME",
    "INVALID_SCAN_NETWORK_UPDATE", "INVALID_SCAN_NETWORK_ID", "SCAN_NETWORK_DUPLICATE", "SCAN_NETWORK_LIMIT_REACHED",
    "SCAN_NETWORK_ROUTE_UNAVAILABLE", "SCAN_NETWORK_NOT_FOUND"].includes(value.error.code)
    ? value.error.code : "SCAN_NETWORKS_UNAVAILABLE";
}

function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function optionalString(value: unknown, maximum: number): boolean {
  return value === undefined || typeof value === "string" && value.length <= maximum;
}

function validInsights(value: Record<string, unknown>): boolean {
  const validItem = (item: unknown) => record(item) && typeof item.value === "string"
    && Number.isSafeInteger(item.count) && Number(item.count) >= 0;
  return Array.isArray(value.platforms) && value.platforms.length <= 24 && value.platforms.every(validItem)
    && Array.isArray(value.vendors) && value.vendors.length <= 24 && value.vendors.every(validItem)
    && Array.isArray(value.vendor_device_types) && value.vendor_device_types.length <= 32
    && value.vendor_device_types.every((item) => record(item) && typeof item.vendor === "string"
      && typeof item.device_type === "string" && Number.isSafeInteger(item.count) && Number(item.count) >= 0);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
