import type { Pool, QueryResultRow } from "pg";

import { ASSET_CHANGE_FIELDS, normalizeAssetChangeSnapshot } from "./change.js";
import {
  ASSET_CHANGE_EVENT_TYPES,
  ASSET_CHANGE_SOURCES,
  type AssetChangeEvent,
  type AssetChangeListResponse,
  type AssetChangeQuery,
} from "./change-contract.js";

export interface AssetChangeRepository {
  list(query: AssetChangeQuery, signal: AbortSignal): Promise<AssetChangeListResponse>;
}

export class PostgresAssetChangeRepository implements AssetChangeRepository {
  constructor(private readonly pool: Pool) {}

  async list(query: AssetChangeQuery, signal: AbortSignal): Promise<AssetChangeListResponse> {
    signal.throwIfAborted();
    const { where, values } = filters(query);
    const offset = (query.page - 1) * query.pageSize;
    const listValues = [...values, query.pageSize, offset];
    const limitIndex = values.length + 1;
    const offsetIndex = values.length + 2;
    const [eventsResult, countResult] = await Promise.all([
      this.pool.query<ChangeRow>({
        text: `SELECT id::text, asset_id::text, scan_run_id::text, asset_stable_key,
          event_type, source, observed_at::text, recorded_at::text, changed_fields,
          before_state, after_state
          FROM asset.change_events ${where}
          ORDER BY recorded_at DESC, id DESC LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
        values: listValues,
      }),
      this.pool.query<{ count: string }>({ text: `SELECT count(*)::text AS count FROM asset.change_events ${where}`, values }),
    ]);
    signal.throwIfAborted();
    const total = boundedCount(countResult.rows[0]?.count);
    return {
      events: eventsResult.rows.map(normalizeEvent).filter((event): event is AssetChangeEvent => event !== null),
      pagination: { page: query.page, page_size: query.pageSize, total, pages: Math.max(1, Math.ceil(total / query.pageSize)) },
    };
  }
}

type ChangeRow = QueryResultRow & {
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

function filters(query: AssetChangeQuery): { where: string; values: unknown[] } {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (query.assetId) {
    values.push(query.assetId);
    clauses.push(`asset_id = $${values.length}::uuid`);
  }
  if (query.search) {
    values.push(`%${query.search.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
    clauses.push(`(asset_stable_key ILIKE $${values.length} ESCAPE '\\'
      OR coalesce(after_state->>'name', '') ILIKE $${values.length} ESCAPE '\\'
      OR coalesce(after_state->>'hostname', '') ILIKE $${values.length} ESCAPE '\\'
      OR coalesce(after_state->>'ip_address', '') ILIKE $${values.length} ESCAPE '\\'
      OR coalesce(after_state->>'mac_address', '') ILIKE $${values.length} ESCAPE '\\'
      OR coalesce(after_state->>'vendor', '') ILIKE $${values.length} ESCAPE '\\'
      OR coalesce(after_state->>'platform', '') ILIKE $${values.length} ESCAPE '\\')`);
  }
  if (query.eventType) {
    values.push(query.eventType);
    clauses.push(`event_type = $${values.length}`);
  }
  if (query.source) {
    values.push(query.source);
    clauses.push(`source = $${values.length}`);
  }
  if (query.changedField) {
    values.push(query.changedField);
    clauses.push(`changed_fields @> ARRAY[$${values.length}]::text[]`);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", values };
}

function normalizeEvent(row: ChangeRow): AssetChangeEvent | null {
  if (!ASSET_CHANGE_EVENT_TYPES.includes(row.event_type as AssetChangeEvent["event_type"]) ||
      !ASSET_CHANGE_SOURCES.includes(row.source as AssetChangeEvent["source"]) ||
      !record(row.after_state)) return null;
  const changedFields = Array.isArray(row.changed_fields)
    ? row.changed_fields.filter((field): field is AssetChangeEvent["changed_fields"][number] =>
      typeof field === "string" && ASSET_CHANGE_FIELDS.includes(field as AssetChangeEvent["changed_fields"][number]))
    : [];
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
