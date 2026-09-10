export type ScanNetworkRouteKind = "direct" | "routed" | "unreachable" | "unknown";
export type ConfiguredScanNetwork = Readonly<{
  id: string;
  name: string | null;
  cidr: string;
  enabled: boolean;
  origin: "manual" | "detected" | "bootstrap";
  created_at: string;
  updated_at: string;
  route_kind: ScanNetworkRouteKind;
  interface_name: string | null;
  source_ip: string | null;
  gateway: string | null;
  reason_code: "ROUTE_AVAILABLE" | "ROUTE_UNAVAILABLE" | "ROUTE_UNKNOWN";
}>;

export type DetectedScanNetwork = Readonly<{
  cidr: string;
  interface_name: string;
  source_ip: string;
  route_kind: "direct";
}>;

export type ScanNetworkRoute = Readonly<{
  cidr: string;
  route_kind: ScanNetworkRouteKind;
  interface_name: string | null;
  source_ip: string | null;
  gateway: string | null;
  reason_code: "ROUTE_AVAILABLE" | "ROUTE_UNAVAILABLE" | "ROUTE_UNKNOWN";
  canonicalized?: boolean;
}>;

export function validConfiguredNetworks(value: unknown): value is { data: { networks: readonly ConfiguredScanNetwork[] } } {
  return record(value) && record(value.data) && Array.isArray(value.data.networks) && value.data.networks.length <= 8
    && value.data.networks.every(validConfiguredNetwork);
}

export function validDetectedNetworks(value: unknown): value is { data: { available: boolean; networks: readonly DetectedScanNetwork[]; reason_code: null | "DETECTOR_UNAVAILABLE" } } {
  return record(value) && record(value.data) && typeof value.data.available === "boolean"
    && (value.data.reason_code === null || value.data.reason_code === "DETECTOR_UNAVAILABLE")
    && Array.isArray(value.data.networks) && value.data.networks.length <= 8
    && value.data.networks.every((item) => record(item) && typeof item.cidr === "string"
      && typeof item.interface_name === "string" && typeof item.source_ip === "string" && item.route_kind === "direct");
}

export function validRoute(value: unknown): value is ScanNetworkRoute {
  return record(value) && typeof value.cidr === "string" && isRouteKind(value.route_kind)
    && optionalString(value.interface_name) && optionalString(value.source_ip) && optionalString(value.gateway)
    && ["ROUTE_AVAILABLE", "ROUTE_UNAVAILABLE", "ROUTE_UNKNOWN"].includes(String(value.reason_code));
}

export function validConfiguredNetwork(value: unknown): value is ConfiguredScanNetwork {
  return record(value) && typeof value.id === "string" && (value.name === null || typeof value.name === "string")
    && typeof value.cidr === "string" && typeof value.enabled === "boolean"
    && ["manual", "detected", "bootstrap"].includes(String(value.origin))
    && typeof value.created_at === "string" && typeof value.updated_at === "string" && validRoute(value);
}

function isRouteKind(value: unknown): value is ScanNetworkRouteKind {
  return value === "direct" || value === "routed" || value === "unreachable" || value === "unknown";
}
function optionalString(value: unknown): boolean { return value === null || typeof value === "string"; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
