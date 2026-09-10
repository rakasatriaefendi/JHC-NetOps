import type { Pool, PoolClient, QueryResultRow } from "pg";

import { ASSET_CHANGE_EVENT_TYPES, ASSET_CHANGE_SOURCES, type AssetChangeEvent } from "./change-contract.js";
import { ASSET_CHANGE_FIELDS, normalizeAssetChangeSnapshot, type AssetChangeField } from "./change.js";
import type { AssetListQuery, AssetRecord } from "./contract.js";
import { assetListOrder, assetListWhere } from "./query.js";
import { ASSET_COLUMNS, normalizeAsset } from "./repository.js";

export type AssetReportData = Readonly<{
  assets: readonly AssetRecord[];
  history: readonly AssetChangeEvent[];
  matchingAssetCount: number;
  assetsTruncated: boolean;
  historyTruncated: boolean;
}>;

export interface AssetReportRepository {
  load(query: AssetListQuery, assetLimit: number, historyLimit: number, signal: AbortSignal): Promise<AssetReportData>;
}

export class PostgresAssetReportRepository implements AssetReportRepository {
  constructor(private readonly pool: Pool) {}

  async load(query: AssetListQuery, assetLimit: number, historyLimit: number, signal: AbortSignal): Promise<AssetReportData> {
    signal.throwIfAborted();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const { where, values } = assetListWhere(query);
      const limitIndex = values.length + 1;
      const assetRows = await client.query<AssetDatabaseRow>({
        text: `SELECT ${ASSET_COLUMNS} FROM asset.assets ${where}
          ORDER BY ${assetListOrder(query)} LIMIT $${limitIndex}`,
        values: [...values, assetLimit + 1],
      });
      signal.throwIfAborted();
      const countRows = await client.query<{ count: string }>({
        text: `SELECT count(*)::text AS count FROM asset.assets ${where}`,
        values,
      });
      const assetsTruncated = assetRows.rows.length > assetLimit;
      const assets = assetRows.rows.slice(0, assetLimit).map(normalizeAsset);
      const history = await loadHistory(client, assets.map((asset) => asset.id), historyLimit, signal);
      await client.query("COMMIT");
      return {
        assets,
        history: history.events,
        matchingAssetCount: boundedCount(countRows.rows[0]?.count),
        assetsTruncated,
        historyTruncated: history.truncated,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

const MEANINGFUL_CHANGE_FIELDS = ASSET_CHANGE_FIELDS.filter((field) => field !== "status");

async function loadHistory(client: PoolClient, assetIds: string[], limit: number, signal: AbortSignal) {
  if (!assetIds.length) return { events: [] as AssetChangeEvent[], truncated: false };
  const rows = await client.query<ChangeDatabaseRow>({
    text: `SELECT id::text, asset_id::text, scan_run_id::text, asset_stable_key,
      event_type, source, observed_at::text, recorded_at::text, changed_fields,
      before_state, after_state
      FROM asset.change_events
      WHERE asset_id = ANY($1::uuid[])
        AND (event_type = 'created' OR changed_fields && $2::text[])
      ORDER BY recorded_at DESC, id DESC LIMIT $3`,
    values: [assetIds, MEANINGFUL_CHANGE_FIELDS, limit + 1],
  });
  signal.throwIfAborted();
  return {
    events: rows.rows.slice(0, limit).map(normalizeReportEvent).filter((event): event is AssetChangeEvent => event !== null),
    truncated: rows.rows.length > limit,
  };
}

type AssetDatabaseRow = QueryResultRow & AssetRecord;
type ChangeDatabaseRow = QueryResultRow & {
  id: string;
  asset_id: string | null;
  scan_run_id: string | null;
  asset_stable_key: string;
  event_type: string;
  source: string;
  observed_at: string;
  recorded_at: string;
  changed_fields: unknown;
  before_state: unknown;
  after_state: unknown;
};

export function normalizeReportEvent(row: ChangeDatabaseRow): AssetChangeEvent | null {
  if (!ASSET_CHANGE_EVENT_TYPES.includes(row.event_type as AssetChangeEvent["event_type"]) ||
      !ASSET_CHANGE_SOURCES.includes(row.source as AssetChangeEvent["source"]) || !record(row.after_state)) return null;
  const changedFields = Array.isArray(row.changed_fields)
    ? row.changed_fields.filter((field): field is AssetChangeField =>
      typeof field === "string" && field !== "status" && ASSET_CHANGE_FIELDS.includes(field as AssetChangeField))
    : [];
  if (row.event_type === "changed" && !changedFields.length) return null;
  return {
    id: row.id,
    asset_id: row.asset_id,
    scan_run_id: row.scan_run_id,
    asset_stable_key: row.asset_stable_key.slice(0, 300),
    event_type: row.event_type as AssetChangeEvent["event_type"],
    source: row.source as AssetChangeEvent["source"],
    observed_at: row.observed_at,
    recorded_at: row.recorded_at,
    changed_fields: changedFields,
    before_state: record(row.before_state) ? normalizeAssetChangeSnapshot(snapshotInput(row.before_state)) : null,
    after_state: normalizeAssetChangeSnapshot(snapshotInput(row.after_state)),
  };
}

function snapshotInput(value: Record<string, unknown>) {
  return {
    name: value.name,
    hostname: value.hostname,
    ip_address: value.ip_address,
    mac_address: value.mac_address,
    vendor: value.vendor,
    platform: value.platform,
    device_type: value.device_type,
    status: value.status,
    open_ports: value.open_ports,
    detected_services: value.detected_services,
  };
}

function boundedCount(value: string | undefined): number {
  const count = Number(value ?? 0);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
