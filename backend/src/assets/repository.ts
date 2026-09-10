import type { Pool, PoolClient, QueryResultRow } from "pg";

import type { AssetListQuery, AssetListResponse, AssetRecord, AssetSummary } from "./contract.js";
import { normalizeAssetChangeSnapshot, prepareAssetChangeEvent, type AssetChangeEventWrite } from "./change.js";
import { mergeAssetEvidence } from "./evidence-merge.js";
import type { AssetObservation } from "./evidence.js";
import { assetListOrder, assetListWhere } from "./query.js";

export const ASSET_QUERY_TIMEOUT_MS = 5_000;

export interface AssetRepository {
  list(query: AssetListQuery, signal: AbortSignal): Promise<AssetListResponse>;
  detail(id: string, signal: AbortSignal): Promise<AssetRecord | null>;
  ingest(observations: readonly AssetObservation[], signal: AbortSignal, context?: AssetIngestContext): Promise<number>;
}

export type AssetIngestContext = Readonly<{
  scanRunId?: string | null;
  eventSource?: AssetObservation["source"];
  observationsPremerged?: boolean;
}>;

export class PostgresAssetRepository implements AssetRepository {
  constructor(private readonly pool: Pool) {}

  async list(query: AssetListQuery, signal: AbortSignal): Promise<AssetListResponse> {
    signal.throwIfAborted();
    const { where, values } = assetListWhere(query);
    const offset = (query.page - 1) * query.pageSize;
    const order = assetListOrder(query);
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

  async ingest(observations: readonly AssetObservation[], signal: AbortSignal, context: AssetIngestContext = {}): Promise<number> {
    signal.throwIfAborted();
    if (!observations.length) return 0;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const stableKeys = [...new Set(observations.map((item) => item.stable_source_key))].sort();
      await client.query({
        text: `SELECT pg_advisory_xact_lock(hashtextextended(stable_key, 0))
          FROM unnest($1::text[]) AS keys(stable_key) ORDER BY stable_key`,
        values: [stableKeys],
      });
      signal.throwIfAborted();
      const beforeResult = await loadAssetsForChange(client, stableKeys);
      const beforeByKey = new Map(beforeResult.rows.map((row) => [row.stable_source_key, row]));
      const effectiveObservations = context.observationsPremerged
        ? observations
        : observations.map((observation) => {
          const before = beforeByKey.get(observation.stable_source_key);
          return before ? mergeAssetEvidence(existingObservation(before), observation) : observation;
        });
      const result = await client.query<{ id: string; stable_source_key: string }>({
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
        vendor = CASE
          WHEN lower(btrim(coalesce(asset.assets.vendor, ''))) IN ('', '-', 'unknown', 'unknown vendor', 'n/a', 'none', 'null')
            OR lower(btrim(asset.assets.vendor)) ~ '^0x[0-9a-f]*$'
            OR btrim(asset.assets.vendor) !~ '[[:alpha:]]'
          THEN EXCLUDED.vendor
          ELSE COALESCE(EXCLUDED.vendor, asset.assets.vendor)
        END,
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
        RETURNING id::text, stable_source_key`,
        values: [JSON.stringify(effectiveObservations)],
      });
      signal.throwIfAborted();
      const afterResult = await loadAssetsForChange(client, stableKeys);
      const afterByKey = new Map(afterResult.rows.map((row) => [row.stable_source_key, row]));
      const observationByKey = new Map(observations.map((item) => [item.stable_source_key, item]));
      const events: AssetChangeEventWrite[] = [];
      for (const stableKey of stableKeys) {
        const after = afterByKey.get(stableKey);
        const observation = observationByKey.get(stableKey);
        if (!after || !observation) continue;
        const before = beforeByKey.get(stableKey);
        const event = prepareAssetChangeEvent({
          assetId: after.id,
          stableKey,
          source: context.eventSource ?? observation.source,
          scanRunId: context.scanRunId ?? null,
          observedAt: observation.evidence_updated_at ?? observation.last_seen_at ?? observation.first_seen_at ?? new Date().toISOString(),
          before: before ? normalizeAssetChangeSnapshot(before) : null,
          after: normalizeAssetChangeSnapshot(after),
        });
        if (event) events.push(event);
      }
      if (events.length) await insertAssetChangeEvents(client, events);
      signal.throwIfAborted();
      await client.query("COMMIT");
      return result.rowCount ?? 0;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

type AssetRow = QueryResultRow & AssetRecord;
type SummaryRow = QueryResultRow & { total: string; online: string; offline: string; changed: string };
type InsightRow = QueryResultRow & { value: string; count: string };
type VendorTypeRow = QueryResultRow & { vendor: string; device_type: string; count: string };
type ChangeAssetRow = AssetRow & { stable_source_key: string };

export const ASSET_COLUMNS = `id, name, hostname, device_type, status, host(ip_address) AS ip_address,
  mac_address::text AS mac_address, vendor, platform, first_seen_at::text, last_seen_at::text,
  source, classification_confidence, os_confidence, classification_evidence, open_ports, detected_services,
  latency_ms::float8 AS latency_ms, evidence_updated_at::text, network_node_ref::text,
  health_target_ref::text, managed_telemetry_target_ref::text, observed_host_target_ref::text`;

async function loadAssetsForChange(client: PoolClient, stableKeys: readonly string[]) {
  return client.query<ChangeAssetRow>({
    text: `SELECT stable_source_key, ${ASSET_COLUMNS} FROM asset.assets
      WHERE stable_source_key = ANY($1::text[]) FOR UPDATE`,
    values: [stableKeys],
  });
}

async function insertAssetChangeEvents(client: PoolClient, events: readonly AssetChangeEventWrite[]): Promise<void> {
  await client.query({
    text: `INSERT INTO asset.change_events (
      asset_id, scan_run_id, asset_stable_key, event_key, event_type, source,
      observed_at, changed_fields, before_state, after_state
    )
    SELECT source.asset_id::uuid, source.scan_run_id::uuid, source.asset_stable_key,
      source.event_key, source.event_type, source.source, source.observed_at::timestamptz,
      ARRAY(SELECT jsonb_array_elements_text(source.changed_fields)),
      source.before_state, source.after_state
    FROM jsonb_to_recordset($1::jsonb) AS source(
      asset_id text, scan_run_id text, asset_stable_key text, event_key text,
      event_type text, source text, observed_at text, changed_fields jsonb,
      before_state jsonb, after_state jsonb
    )
    ON CONFLICT (event_key) DO NOTHING`,
    values: [JSON.stringify(events)],
  });
}

export function normalizeAsset(row: AssetRow): AssetRecord {
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

function existingObservation(row: ChangeAssetRow): AssetObservation {
  const normalized = normalizeAsset(row);
  return {
    stable_source_key: row.stable_source_key,
    name: normalized.name,
    hostname: normalized.hostname,
    device_type: normalized.device_type,
    status: normalized.status,
    ip_address: normalized.ip_address,
    mac_address: normalized.mac_address,
    vendor: normalized.vendor,
    platform: normalized.platform,
    first_seen_at: normalized.first_seen_at,
    last_seen_at: normalized.last_seen_at,
    source: normalized.source as AssetObservation["source"],
    classification_confidence: normalized.classification_confidence,
    os_confidence: normalized.os_confidence,
    classification_evidence: normalized.classification_evidence,
    open_ports: normalized.open_ports,
    detected_services: normalized.detected_services,
    latency_ms: normalized.latency_ms,
    evidence_updated_at: normalized.evidence_updated_at,
    network_node_ref: normalized.network_node_ref,
    health_target_ref: normalized.health_target_ref,
    managed_telemetry_target_ref: normalized.managed_telemetry_target_ref,
    observed_host_target_ref: normalized.observed_host_target_ref,
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
  return value.map(normalizeService).filter((item): item is NonNullable<typeof item> => item !== null).slice(0, 32);
}

function normalizeService(item: unknown): AssetRecord["detected_services"][number] | null {
  if (!record(item) || (item.protocol !== "tcp" && item.protocol !== "udp") || !Number.isSafeInteger(item.port)
      || Number(item.port) < 1 || Number(item.port) > 65_535 || typeof item.name !== "string") return null;
  const product = optionalText(item.product, 160);
  const version = optionalText(item.version, 100);
  const extraInfo = optionalText(item.extra_info, 160);
  const tunnel = optionalText(item.tunnel, 32);
  return {
    protocol: item.protocol,
    port: Number(item.port),
    name: item.name.slice(0, 100),
    ...(product ? { product } : {}),
    ...(version ? { version } : {}),
    ...(extraInfo ? { extra_info: extraInfo } : {}),
    ...(tunnel ? { tunnel } : {}),
  };
}

function optionalText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= maximum && !/[\u0000-\u001f\u007f]/.test(text) ? text : null;
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
