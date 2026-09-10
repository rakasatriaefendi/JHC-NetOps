export const ASSET_SCAN_MODES = ["quick", "deep"] as const;
export const ASSET_SCAN_MAX_NETWORKS = 8;
export const ASSET_SCAN_MAX_ADDRESSES = 1_024;
export const ASSET_SCAN_MAX_HOSTS = 1_024;
export const ASSET_SCAN_MAX_CONCURRENCY = 8;

export type AssetScanMode = (typeof ASSET_SCAN_MODES)[number];
export type AssetScanStatus = "running" | "completed" | "failed" | "cancelled";

export type AssetScanRecord = Readonly<{
  id: string;
  mode: AssetScanMode;
  network: string;
  status: AssetScanStatus;
  discovered_count: number;
  fingerprinted_count: number;
  failed_count: number;
  current_target: string | null;
  started_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
  error_code: string | null;
}>;

export type AssetScanState = Readonly<{
  available: boolean;
  networks: readonly string[];
  current: AssetScanRecord | null;
  last: AssetScanRecord | null;
}>;

export function parseAllowedScanNetworks(value: string | undefined): readonly string[] {
  if (!value?.trim()) return [];
  const raw = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (raw.length > ASSET_SCAN_MAX_NETWORKS) throw new Error("ASSET_SCAN_NETWORKS_INVALID");
  const normalized: string[] = [];
  for (const item of raw) {
    const network = normalizePrivateCidr(item);
    if (!network || normalized.includes(network)) throw new Error("ASSET_SCAN_NETWORKS_INVALID");
    normalized.push(network);
  }
  return normalized;
}

export function validateAssetScanRequest(value: unknown, networks: readonly string[]):
  | { ok: true; value: { mode: AssetScanMode; network: string } }
  | { ok: false; code: "INVALID_SCAN_REQUEST" | "SCAN_NETWORK_NOT_ALLOWED" } {
  if (!record(value) || Object.keys(value).some((key) => key !== "mode" && key !== "network") ||
      !isScanMode(value.mode) || typeof value.network !== "string") {
    return { ok: false, code: "INVALID_SCAN_REQUEST" };
  }
  const network = normalizePrivateCidr(value.network);
  if (!network || network !== value.network || !networks.includes(network)) {
    return { ok: false, code: "SCAN_NETWORK_NOT_ALLOWED" };
  }
  return { ok: true, value: { mode: value.mode, network } };
}

function isScanMode(value: unknown): value is AssetScanMode {
  return value === "quick" || value === "deep";
}

export function normalizePrivateCidr(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 32) return null;
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(value);
  if (!match) return null;
  const ip = parseIpv4(match[1] ?? "");
  const prefix = Number(match[2]);
  if (ip === null || !Number.isSafeInteger(prefix) || prefix < 22 || prefix > 32) return null;
  const size = 2 ** (32 - prefix);
  const base = Math.floor(ip / size) * size;
  const last = base + size - 1;
  if (ip !== base || !isRfc1918(base) || !isRfc1918(last) || size > ASSET_SCAN_MAX_ADDRESSES) return null;
  return `${formatIpv4(base)}/${prefix}`;
}

export function normalizePrivateIpv4(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = parseIpv4(value);
  return parsed !== null && isRfc1918(parsed) ? formatIpv4(parsed) : null;
}

export function isUsableScanHost(value: unknown, requestedNetwork: string): boolean {
  const network = normalizePrivateCidr(requestedNetwork);
  const candidate = typeof value === "string" ? parseIpv4(value) : null;
  if (!network || candidate === null || !isRfc1918(candidate)) return false;
  const [networkAddress = "", prefixText = ""] = network.split("/");
  const base = parseIpv4(networkAddress);
  const prefix = Number(prefixText);
  if (base === null || !Number.isSafeInteger(prefix)) return false;
  const size = 2 ** (32 - prefix);
  const last = base + size - 1;
  if (candidate < base || candidate > last) return false;
  return prefix > 30 || candidate !== base && candidate !== last;
}

function parseIpv4(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^(?:0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) return null;
  return parts.map(Number).reduce((result, octet) => result * 256 + octet, 0);
}

function formatIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join(".");
}

function isRfc1918(value: number): boolean {
  const a = Math.floor(value / 2 ** 24) % 256;
  const b = Math.floor(value / 2 ** 16) % 256;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
