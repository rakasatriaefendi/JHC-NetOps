import "server-only";

export type AssetStatus = "online" | "offline" | "changed" | "unknown";
export type AssetSort = "name_asc" | "name_desc";

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
  detected_services: readonly Readonly<{ protocol: "tcp" | "udp"; port: number; name: string }>[];
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

function safeLoopbackOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
        url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null;
    return url.origin;
  } catch { return null; }
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
      && Number.isSafeInteger(service.port) && Number(service.port) >= 1 && Number(service.port) <= 65_535 && typeof service.name === "string")
    && Array.isArray(item.classification_evidence) && item.classification_evidence.length <= 32
    && item.classification_evidence.every((evidence) => record(evidence) && typeof evidence.source === "string"
      && typeof evidence.label === "string" && typeof evidence.value === "string");
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
