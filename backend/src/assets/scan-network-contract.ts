import { ASSET_SCAN_MAX_NETWORKS, normalizePrivateCidr } from "./scan-contract.js";

export { ASSET_SCAN_MAX_NETWORKS };
export const SCAN_NETWORK_NAME_MAX = 100;
export const SCAN_NETWORK_ROUTE_KINDS = ["direct", "routed", "unreachable", "unknown"] as const;
export type ScanNetworkOrigin = "manual" | "detected" | "bootstrap";
export type ScanNetworkRouteKind = (typeof SCAN_NETWORK_ROUTE_KINDS)[number];

export type ConfiguredScanNetwork = Readonly<{
  id: string;
  name: string | null;
  cidr: string;
  enabled: boolean;
  origin: ScanNetworkOrigin;
  created_at: string;
  updated_at: string;
}>;

export type ScanNetworkRoute = Readonly<{
  cidr: string;
  route_kind: ScanNetworkRouteKind;
  interface_name: string | null;
  source_ip: string | null;
  gateway: string | null;
  reason_code: "ROUTE_AVAILABLE" | "ROUTE_UNAVAILABLE" | "ROUTE_UNKNOWN";
}>;

export type EnrichedScanNetwork = ConfiguredScanNetwork & ScanNetworkRoute;
export type DetectedScanNetwork = Readonly<{
  cidr: string;
  interface_name: string;
  source_ip: string;
  route_kind: "direct";
}>;

export type ScanNetworkDetection = Readonly<{
  available: boolean;
  networks: readonly DetectedScanNetwork[];
  reason_code: null | "DETECTOR_UNAVAILABLE";
}>;

export type CreateScanNetworkInput = Readonly<{
  name: string | null;
  cidr: string;
  origin: "manual" | "detected";
}>;

export type UpdateScanNetworkInput = Readonly<{
  name?: string | null;
  enabled?: boolean;
}>;

export type ScanNetworkValidationCode =
  | "INVALID_SCAN_NETWORK"
  | "SCAN_NETWORK_PUBLIC"
  | "SCAN_NETWORK_TOO_BROAD"
  | "INVALID_SCAN_NETWORK_NAME";

export function validateCreateScanNetwork(value: unknown):
  | { ok: true; value: CreateScanNetworkInput; canonicalized: boolean }
  | { ok: false; code: ScanNetworkValidationCode } {
  if (!record(value) || Object.keys(value).some((key) => !["name", "cidr", "origin"].includes(key)) ||
      typeof value.cidr !== "string" || (value.origin !== undefined && value.origin !== "manual" && value.origin !== "detected")) {
    return { ok: false, code: "INVALID_SCAN_NETWORK" };
  }
  const name = normalizeName(value.name);
  if (name === undefined) return { ok: false, code: "INVALID_SCAN_NETWORK_NAME" };
  const submittedCidr = value.cidr.trim();
  const cidr = normalizePrivateCidr(submittedCidr);
  if (!cidr) return { ok: false, code: cidrError(value.cidr) };
  if (cidr !== submittedCidr) return { ok: false, code: "INVALID_SCAN_NETWORK" };
  return {
    ok: true,
    value: { name, cidr, origin: value.origin === "detected" ? "detected" : "manual" },
    canonicalized: false,
  };
}

export function validateUpdateScanNetwork(value: unknown):
  | { ok: true; value: UpdateScanNetworkInput }
  | { ok: false; code: "INVALID_SCAN_NETWORK_UPDATE" | "INVALID_SCAN_NETWORK_NAME" } {
  if (!record(value) || Object.keys(value).length === 0 ||
      Object.keys(value).some((key) => key !== "name" && key !== "enabled") ||
      (value.enabled !== undefined && typeof value.enabled !== "boolean")) {
    return { ok: false, code: "INVALID_SCAN_NETWORK_UPDATE" };
  }
  const name = value.name === undefined ? undefined : normalizeName(value.name);
  if (name === undefined && value.name !== undefined) return { ok: false, code: "INVALID_SCAN_NETWORK_NAME" };
  const result: { name?: string | null; enabled?: boolean } = {};
  if (value.name !== undefined) result.name = name ?? null;
  if (value.enabled !== undefined) result.enabled = value.enabled;
  return { ok: true, value: result };
}

export function validateScanNetworkTest(value: unknown):
  | { ok: true; value: { cidr: string }; canonicalized: boolean }
  | { ok: false; code: ScanNetworkValidationCode } {
  if (!record(value) || Object.keys(value).length !== 1 || typeof value.cidr !== "string") {
    return { ok: false, code: "INVALID_SCAN_NETWORK" };
  }
  const submittedCidr = value.cidr.trim();
  const cidr = normalizePrivateCidr(submittedCidr);
  if (!cidr) return { ok: false, code: cidrError(value.cidr) };
  if (cidr !== submittedCidr) return { ok: false, code: "INVALID_SCAN_NETWORK" };
  return { ok: true, value: { cidr }, canonicalized: false };
}

function normalizeName(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  if (!name || name.length > SCAN_NETWORK_NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) return undefined;
  return name;
}

function cidrError(value: string): ScanNetworkValidationCode {
  const prefix = /\/(\d{1,3})$/.exec(value.trim());
  if (prefix && Number(prefix[1]) < 22) return "SCAN_NETWORK_TOO_BROAD";
  if (/^(?:\d{1,3}\.){3}\d{1,3}\//.test(value.trim())) return "SCAN_NETWORK_PUBLIC";
  return "INVALID_SCAN_NETWORK";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
