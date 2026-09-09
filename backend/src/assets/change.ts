import { createHash } from "node:crypto";

import { ASSET_SERVICE_LIMIT, normalizeVendor, type AssetService } from "./evidence.js";

export const ASSET_CHANGE_FIELDS = [
  "name",
  "hostname",
  "ip_address",
  "mac_address",
  "vendor",
  "platform",
  "device_type",
  "status",
  "open_ports",
  "detected_services",
] as const;

export type AssetChangeField = (typeof ASSET_CHANGE_FIELDS)[number];

export type AssetChangeSnapshot = Readonly<{
  name: string;
  hostname: string | null;
  ip_address: string | null;
  mac_address: string | null;
  vendor: string | null;
  platform: string | null;
  device_type: string;
  status: "online" | "offline" | "changed" | "unknown";
  open_ports: readonly number[];
  detected_services: readonly AssetService[];
}>;

export type AssetChangeEventWrite = Readonly<{
  asset_id: string;
  scan_run_id: string | null;
  asset_stable_key: string;
  event_key: string;
  event_type: "created" | "changed";
  source: string;
  observed_at: string;
  changed_fields: readonly AssetChangeField[];
  before_state: AssetChangeSnapshot | null;
  after_state: AssetChangeSnapshot;
}>;

type SnapshotInput = Readonly<{
  name: unknown;
  hostname: unknown;
  ip_address: unknown;
  mac_address: unknown;
  vendor: unknown;
  platform: unknown;
  device_type: unknown;
  status: unknown;
  open_ports: unknown;
  detected_services: unknown;
}>;

export function normalizeAssetChangeSnapshot<T extends SnapshotInput>(value: T): AssetChangeSnapshot {
  return {
    name: text(value.name, 200) ?? "",
    hostname: text(value.hostname, 255),
    ip_address: text(value.ip_address, 64),
    mac_address: normalizeMac(value.mac_address),
    vendor: normalizeVendor(value.vendor),
    platform: text(value.platform, 200),
    device_type: (text(value.device_type, 64) ?? "unknown").toLowerCase(),
    status: normalizeStatus(value.status),
    open_ports: normalizePorts(value.open_ports),
    detected_services: normalizeServices(value.detected_services),
  };
}

export function diffAssetSnapshots(before: AssetChangeSnapshot, after: AssetChangeSnapshot): AssetChangeField[] {
  return ASSET_CHANGE_FIELDS.filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]));
}

export function assetChangeEventKey(value: Readonly<{
  stableKey: string;
  eventType: "created" | "changed";
  source: string;
  scanRunId: string | null;
  observedAt: string;
  changedFields: readonly AssetChangeField[];
  before: AssetChangeSnapshot | null;
  after: AssetChangeSnapshot;
}>): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function prepareAssetChangeEvent(value: Readonly<{
  assetId: string;
  stableKey: string;
  source: string;
  scanRunId: string | null;
  observedAt: string;
  before: AssetChangeSnapshot | null;
  after: AssetChangeSnapshot;
}>): AssetChangeEventWrite | null {
  const changedFields = value.before ? diffAssetSnapshots(value.before, value.after) : [];
  if (value.before && changedFields.length === 0) return null;
  const eventType = value.before ? "changed" : "created";
  return {
    asset_id: value.assetId,
    scan_run_id: value.scanRunId,
    asset_stable_key: value.stableKey,
    event_key: assetChangeEventKey({
      stableKey: value.stableKey,
      eventType,
      source: value.source,
      scanRunId: value.scanRunId,
      observedAt: value.observedAt,
      changedFields,
      before: value.before,
      after: value.after,
    }),
    event_type: eventType,
    source: value.source,
    observed_at: value.observedAt,
    changed_fields: changedFields,
    before_state: value.before,
    after_state: value.after,
  };
}

function normalizeStatus(value: unknown): AssetChangeSnapshot["status"] {
  return value === "online" || value === "offline" || value === "changed" || value === "unknown" ? value : "unknown";
}

function normalizePorts(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is number => Number.isSafeInteger(item) && item >= 1 && item <= 65_535))]
    .sort((left, right) => left - right)
    .slice(0, ASSET_SERVICE_LIMIT);
}

function normalizeServices(value: unknown): AssetService[] {
  if (!Array.isArray(value)) return [];
  const services = new Map<string, AssetService>();
  for (const item of value.slice(0, ASSET_SERVICE_LIMIT)) {
    if (!record(item) || (item.protocol !== "tcp" && item.protocol !== "udp") || !Number.isSafeInteger(item.port)) continue;
    const port = Number(item.port);
    const name = text(item.name, 100);
    if (port < 1 || port > 65_535 || !name) continue;
    const product = text(item.product, 160);
    const version = text(item.version, 100);
    const extraInfo = text(item.extra_info, 160);
    const tunnel = text(item.tunnel, 32);
    const service: AssetService = {
      protocol: item.protocol,
      port,
      name,
      ...(product ? { product } : {}),
      ...(version ? { version } : {}),
      ...(extraInfo ? { extra_info: extraInfo } : {}),
      ...(tunnel ? { tunnel } : {}),
    };
    services.set(JSON.stringify(service), service);
  }
  return [...services.values()].sort((left, right) =>
    left.port - right.port || compare(left.protocol, right.protocol) || compare(JSON.stringify(left), JSON.stringify(right)));
}

function normalizeMac(value: unknown): string | null {
  const normalized = text(value, 17)?.replaceAll("-", ":").toUpperCase() ?? null;
  return normalized && /^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(normalized) ? normalized : null;
}

function text(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum && !/[\u0000-\u001f\u007f]/.test(normalized) ? normalized : null;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
