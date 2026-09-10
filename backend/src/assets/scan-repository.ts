import type { Pool, QueryResultRow } from "pg";

import type { AssetObservation } from "./evidence.js";
import { PostgresAssetRepository } from "./repository.js";
import { mergeActiveScanObservation } from "./scan-normalize.js";
import type { AssetScanMode, AssetScanRecord } from "./scan-contract.js";

export interface AssetScanRepository {
  recoverInterrupted(completedAt: string, signal: AbortSignal): Promise<void>;
  create(mode: AssetScanMode, network: string, startedAt: string, signal: AbortSignal): Promise<AssetScanRecord>;
  update(record: AssetScanRecord, signal: AbortSignal): Promise<void>;
  last(signal: AbortSignal): Promise<AssetScanRecord | null>;
  ingest(observations: readonly AssetObservation[], scanRunId: string, signal: AbortSignal): Promise<number>;
}

export class PostgresAssetScanRepository implements AssetScanRepository {
  readonly #assets: PostgresAssetRepository;
  constructor(private readonly pool: Pool) { this.#assets = new PostgresAssetRepository(pool); }

  async recoverInterrupted(completedAt: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await this.pool.query({
      text: "UPDATE asset.scan_runs SET status = 'failed', completed_at = $1::timestamptz, current_target = NULL, error_code = 'BACKEND_RESTARTED' WHERE status = 'running'",
      values: [completedAt],
    });
    signal.throwIfAborted();
  }

  async create(mode: AssetScanMode, network: string, startedAt: string, signal: AbortSignal): Promise<AssetScanRecord> {
    signal.throwIfAborted();
    const result = await this.pool.query<ScanRow>({
      text: `INSERT INTO asset.scan_runs (mode, network, status, started_at)
        VALUES ($1, $2::cidr, 'running', $3::timestamptz)
        RETURNING ${SCAN_COLUMNS}`,
      values: [mode, network, startedAt],
    });
    signal.throwIfAborted();
    const row = result.rows[0];
    if (!row) throw new Error("SCAN_CREATE_FAILED");
    return normalizeScan(row);
  }

  async update(record: AssetScanRecord, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await this.pool.query({
      text: `UPDATE asset.scan_runs SET status = $2, discovered_count = $3, fingerprinted_count = $4,
        failed_count = $5, current_target = $6::inet, completed_at = $7::timestamptz,
        cancelled_at = $8::timestamptz, error_code = $9 WHERE id = $1::uuid`,
      values: [record.id, record.status, record.discovered_count, record.fingerprinted_count,
        record.failed_count, record.current_target, record.completed_at, record.cancelled_at, record.error_code],
    });
    signal.throwIfAborted();
  }

  async last(signal: AbortSignal): Promise<AssetScanRecord | null> {
    signal.throwIfAborted();
    const result = await this.pool.query<ScanRow>(
      `SELECT ${SCAN_COLUMNS} FROM asset.scan_runs WHERE status <> 'running' ORDER BY started_at DESC LIMIT 1`,
    );
    signal.throwIfAborted();
    return result.rows[0] ? normalizeScan(result.rows[0]) : null;
  }

  async ingest(observations: readonly AssetObservation[], scanRunId: string, signal: AbortSignal): Promise<number> {
    signal.throwIfAborted();
    if (!observations.length) return 0;
    const macs = observations.map((item) => item.mac_address).filter((item): item is string => Boolean(item));
    const ips = observations.map((item) => item.ip_address).filter((item): item is string => Boolean(item));
    const candidates = await this.pool.query<ExistingAssetRow>({
      text: `SELECT stable_source_key, name, hostname, device_type, status, host(ip_address) AS ip_address,
        mac_address::text AS mac_address, vendor, platform, first_seen_at::text, last_seen_at::text,
        source, classification_confidence, os_confidence, classification_evidence, open_ports,
        detected_services, latency_ms::float8 AS latency_ms, evidence_updated_at::text,
        network_node_ref::text, health_target_ref::text, managed_telemetry_target_ref::text,
        observed_host_target_ref::text
        FROM asset.assets
        WHERE (cardinality($1::text[]) > 0 AND mac_address::text = ANY($1::text[]))
           OR (cardinality($2::text[]) > 0 AND host(ip_address) = ANY($2::text[]))
        ORDER BY (network_node_ref IS NOT NULL) DESC, (source = 'manual') DESC,
          evidence_updated_at DESC NULLS LAST, stable_source_key ASC`,
      values: [macs, ips],
    });
    const byMac = new Map<string, AssetObservation>();
    const byIp = new Map<string, AssetObservation>();
    for (const row of candidates.rows) {
      const normalized = existingObservation(row);
      if (normalized.mac_address && !byMac.has(normalized.mac_address)) byMac.set(normalized.mac_address, normalized);
      if (normalized.ip_address && !byIp.has(normalized.ip_address)) byIp.set(normalized.ip_address, normalized);
    }
    const merged = new Map<string, AssetObservation>();
    for (const observation of observations) {
      const strongMac = observation.stable_source_key.startsWith("active_scan:mac:");
      const existing = (strongMac && observation.mac_address ? byMac.get(observation.mac_address) : undefined) ??
        (observation.ip_address ? byIp.get(observation.ip_address) : undefined);
      const previous = merged.get(existing?.stable_source_key ?? observation.stable_source_key) ?? existing;
      const value = previous ? mergeActiveScanObservation(previous, observation) : observation;
      merged.set(value.stable_source_key, value);
    }
    return this.#assets.ingest([...merged.values()], signal, { scanRunId, eventSource: "active_scan" });
  }
}

type ScanRow = QueryResultRow & {
  id: string; mode: AssetScanMode; network: string; status: AssetScanRecord["status"];
  discovered_count: number; fingerprinted_count: number; failed_count: number; current_target: string | null;
  started_at: string; completed_at: string | null; cancelled_at: string | null; error_code: string | null;
};

type ExistingAssetRow = QueryResultRow & AssetObservation;
const SCAN_COLUMNS = "id::text, mode, network::text, status, discovered_count, fingerprinted_count, failed_count, host(current_target) AS current_target, started_at::text, completed_at::text, cancelled_at::text, error_code";

function normalizeScan(row: ScanRow): AssetScanRecord {
  return { ...row };
}

function existingObservation(row: ExistingAssetRow): AssetObservation {
  return {
    stable_source_key: row.stable_source_key,
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
    classification_evidence: row.classification_evidence,
    open_ports: row.open_ports,
    detected_services: row.detected_services,
    latency_ms: row.latency_ms,
    evidence_updated_at: row.evidence_updated_at,
    network_node_ref: row.network_node_ref,
    health_target_ref: row.health_target_ref,
    managed_telemetry_target_ref: row.managed_telemetry_target_ref,
    observed_host_target_ref: row.observed_host_target_ref,
  };
}
