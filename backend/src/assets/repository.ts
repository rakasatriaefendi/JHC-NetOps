import type { Pool, QueryResultRow } from "pg";

import type { AssetListQuery, AssetListResponse, AssetRecord, AssetSummary } from "./contract.js";
import type { AssetObservation } from "./evidence.js";

export const ASSET_QUERY_TIMEOUT_MS = 5_000;

export interface AssetRepository {
  list(query: AssetListQuery, signal: AbortSignal): Promise<AssetListResponse>;
  detail(id: string, signal: AbortSignal): Promise<AssetRecord | null>;
  ingest(observations: readonly AssetObservation[], signal: AbortSignal): Promise<number>;
}

export class PostgresAssetRepository implements AssetRepository {
  constructor(private readonly pool: Pool) {}

  async list(query: AssetListQuery, signal: AbortSignal): Promise<AssetListResponse> {
    signal.throwIfAborted();
    const { where, values } = filters(query);
    const offset = (query.page - 1) * query.pageSize;
    const order = query.sort === "name_desc" ? "lower(name) DESC, id DESC" : "lower(name) ASC, id ASC";
    const listValues = [...values, query.pageSize, offset];
    const limitIndex = values.length + 1;
    const offsetIndex = values.length + 2;
    const [itemsResult, countResult, summaryResult, typesResult, platformsResult, vendorsResult, vendorTypesResult] = await Promise.all([
      this.pool.query<AssetRow>(`SELECT ${ASSET_COLUMNS} FROM asset.assets ${where} ORDER BY ${order} LIMIT $${limitIndex} OFFSET $${offsetIndex}`, listValues),
      this.pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM asset.assets ${where}`, values),
      this.pool.query<SummaryRow>({
        text: `SELECT count(*)::text AS total,
          count(*) FILTER (WHERE status = 'online')::text AS online,
          count(*) FILTER (WHERE status = 'offline')::text AS offline,
          count(*) FILTER (WHERE status = 'changed')::text AS changed
          FROM asset.assets`,
      }),
      this.pool.query<{ device_type: string }>({
        text: "SELECT DISTINCT device_type FROM asset.assets ORDER BY device_type ASC LIMIT 256",
      }),
      this.pool.query<InsightRow>({
        text: "SELECT platform AS value, count(*)::text AS count FROM asset.assets WHERE platform IS NOT NULL GROUP BY platform ORDER BY count(*) DESC, platform ASC LIMIT 24",
      }),
      this.pool.query<InsightRow>({
        text: "SELECT vendor AS value, count(*)::text AS count FROM asset.assets WHERE vendor IS NOT NULL GROUP BY vendor ORDER BY count(*) DESC, vendor ASC LIMIT 24",
      }),
      this.pool.query<VendorTypeRow>({
        text: "SELECT vendor, device_type, count(*)::text AS count FROM asset.assets WHERE vendor IS NOT NULL AND device_type <> 'unknown' GROUP BY vendor, device_type ORDER BY count(*) DESC, vendor ASC, device_type ASC LIMIT 32",
      }),
    ]);
    signal.throwIfAborted();
    const total = boundedCount(countResult.rows[0]?.count);
    const summary = normalizeSummary(summaryResult.rows[0]);
    return {
      items: itemsResult.rows.map(normalizeAsset),
      summary,
      device_types: typesResult.rows.map(({ device_type }) => device_type),
      insights: {
        platforms: platformsResult.rows.map(normalizeInsight),
        vendors: vendorsResult.rows.map(normalizeInsight),
        vendor_device_types: vendorTypesResult.rows.map((row) => ({ vendor: row.vendor, device_type: row.device_type, count: boundedCount(row.count) })),
      },
      pagination: {
        page: query.page,
        page_size: query.pageSize,
        total,
        pages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    };
  }

  async detail(id: string, signal: AbortSignal): Promise<AssetRecord | null> {
    signal.throwIfAborted();
    const result = await this.pool.query<AssetRow>(`SELECT ${ASSET_COLUMNS} FROM asset.assets WHERE id = $1 LIMIT 1`, [id]);
    signal.throwIfAborted();
    return result.rows[0] ? normalizeAsset(result.rows[0]) : null;
  }

  async ingest(observations: readonly AssetObservation[], signal: AbortSignal): Promise<number> {
    signal.throwIfAborted();
    if (!observations.length) return 0;
    const result = await this.pool.query<{ id: string }>({
      text: `INSERT INTO asset.assets (
        stable_source_key, name, hostname, device_type, status, ip_address, mac_address,
        vendor, platform, first_seen_at, last_seen_at, source, classification_confidence, os_confidence,
        classification_evidence, open_ports, detected_services, latency_ms, evidence_updated_at,
        network_node_ref, health_target_ref, managed_telemetry_target_ref, observed_host_target_ref
      )
      SELECT source.stable_source_key, source.name, source.hostname, source.device_type, source.status,
        source.ip_address::inet, source.mac_address::macaddr, source.vendor, source.platform,
        source.first_seen_at::timestamptz, source.last_seen_at::timestamptz, source.source,
        source.classification_confidence, source.os_confidence, source.classification_evidence, source.open_ports,
        source.detected_services, source.latency_ms, source.evidence_updated_at::timestamptz,
        source.network_node_ref::uuid, source.health_target_ref::uuid,
        source.managed_telemetry_target_ref::uuid, source.observed_host_target_ref::uuid
      FROM jsonb_to_recordset($1::jsonb) AS source(
        stable_source_key text, name text, hostname text, device_type text, status text,
        ip_address text, mac_address text, vendor text, platform text, first_seen_at text,
        last_seen_at text, source text, classification_confidence text, os_confidence text,
        classification_evidence jsonb, open_ports jsonb, detected_services jsonb,
        latency_ms numeric, evidence_updated_at text, network_node_ref text,
        health_target_ref text, managed_telemetry_target_ref text, observed_host_target_ref text
      )
      ON CONFLICT (stable_source_key) DO UPDATE SET
        name = EXCLUDED.name,
        hostname = COALESCE(EXCLUDED.hostname, asset.assets.hostname),
        device_type = EXCLUDED.device_type,
        status = EXCLUDED.status,
        ip_address = EXCLUDED.ip_address,
        mac_address = COALESCE(EXCLUDED.mac_address, asset.assets.mac_address),
        vendor = COALESCE(EXCLUDED.vendor, asset.assets.vendor),
        platform = COALESCE(EXCLUDED.platform, asset.assets.platform),
        first_seen_at = LEAST(asset.assets.first_seen_at, EXCLUDED.first_seen_at),
        last_seen_at = GREATEST(asset.assets.last_seen_at, EXCLUDED.last_seen_at),
        source = EXCLUDED.source,
        classification_confidence = EXCLUDED.classification_confidence,
        os_confidence = EXCLUDED.os_confidence,
        classification_evidence = EXCLUDED.classification_evidence,
        open_ports = EXCLUDED.open_ports,
        detected_services = EXCLUDED.detected_services,
        latency_ms = EXCLUDED.latency_ms,
        evidence_updated_at = EXCLUDED.evidence_updated_at,
        network_node_ref = COALESCE(EXCLUDED.network_node_ref, asset.assets.network_node_ref),
        health_target_ref = COALESCE(EXCLUDED.health_target_ref, asset.assets.health_target_ref),
        managed_telemetry_target_ref = COALESCE(EXCLUDED.managed_telemetry_target_ref, asset.assets.managed_telemetry_target_ref),
        observed_host_target_ref = COALESCE(EXCLUDED.observed_host_target_ref, asset.assets.observed_host_target_ref),
        updated_at = now()
      RETURNING id`,
      values: [JSON.stringify(observations)],
    });
    signal.throwIfAborted();
    return result.rowCount ?? 0;
  }
}

type AssetRow = QueryResultRow & AssetRecord;
type SummaryRow = QueryResultRow & { total: string; online: string; offline: string; changed: string };
type InsightRow = QueryResultRow & { value: string; count: string };
type VendorTypeRow = QueryResultRow & { vendor: string; device_type: string; count: string };

const ASSET_COLUMNS = `id, name, hostname, device_type, status, host(ip_address) AS ip_address,
  mac_address::text AS mac_address, vendor, platform, first_seen_at::text, last_seen_at::text,
  source, classification_confidence, os_confidence, classification_evidence, open_ports, detected_services,
  latency_ms::float8 AS latency_ms, evidence_updated_at::text, network_node_ref::text,
  health_target_ref::text, managed_telemetry_target_ref::text, observed_host_target_ref::text`;

function filters(query: AssetListQuery): { where: string; values: unknown[] } {
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

function normalizeAsset(row: AssetRow): AssetRecord {
  return {
    id: row.id,
    name: row.name,
    hostname: row.hostname,
    device_type: row.device_type,
    status: row.status,
    ip_address: row.ip_address,
    mac_address: row.mac_address,
    vendor: row.vendor,
    platform: row.platform,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    source: row.source,
    classification_confidence: row.classification_confidence,
    os_confidence: row.os_confidence,
    classification_evidence: normalizeEvidence(row.classification_evidence),
    open_ports: normalizePorts(row.open_ports),
    detected_services: normalizeServices(row.detected_services),
    latency_ms: typeof row.latency_ms === "number" && Number.isFinite(row.latency_ms) ? row.latency_ms : null,
    evidence_updated_at: row.evidence_updated_at,
    network_node_ref: row.network_node_ref,
    health_target_ref: row.health_target_ref,
    managed_telemetry_target_ref: row.managed_telemetry_target_ref,
    observed_host_target_ref: row.observed_host_target_ref,
  };
}

function normalizeInsight(row: InsightRow) {
  return { value: row.value, count: boundedCount(row.count) };
}

function normalizeEvidence(value: unknown): AssetRecord["classification_evidence"] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is { source: string; label: string; value: string } =>
    record(item) && typeof item.source === "string" && typeof item.label === "string" && typeof item.value === "string").slice(0, 32);
}

function normalizePorts(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((item): item is number => Number.isSafeInteger(item) && item >= 1 && item <= 65_535).slice(0, 32) : [];
}

function normalizeServices(value: unknown): AssetRecord["detected_services"] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is { protocol: "tcp" | "udp"; port: number; name: string } =>
    record(item) && (item.protocol === "tcp" || item.protocol === "udp") && Number.isSafeInteger(item.port)
      && Number(item.port) >= 1 && Number(item.port) <= 65_535 && typeof item.name === "string").slice(0, 32);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSummary(row: SummaryRow | undefined): AssetSummary {
  return {
    total: boundedCount(row?.total),
    online: boundedCount(row?.online),
    offline: boundedCount(row?.offline),
    changed: boundedCount(row?.changed),
  };
}

function boundedCount(value: string | undefined): number {
  const count = Number(value ?? 0);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}
