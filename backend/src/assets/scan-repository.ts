import type { Pool, QueryResultRow } from "pg";

import type { AssetObservation } from "./evidence.js";
import { PostgresAssetRepository } from "./repository.js";
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
    return this.#assets.ingest(observations, signal, {
      scanRunId,
      eventSource: "active_scan",
    });
  }
}

type ScanRow = QueryResultRow & {
  id: string; mode: AssetScanMode; network: string; status: AssetScanRecord["status"];
  discovered_count: number; fingerprinted_count: number; failed_count: number; current_target: string | null;
  started_at: string; completed_at: string | null; cancelled_at: string | null; error_code: string | null;
};

const SCAN_COLUMNS = "id::text, mode, network::text, status, discovered_count, fingerprinted_count, failed_count, host(current_target) AS current_target, started_at::text, completed_at::text, cancelled_at::text, error_code";

function normalizeScan(row: ScanRow): AssetScanRecord {
  return { ...row };
}
