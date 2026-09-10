import type { Pool, PoolClient, QueryResultRow } from "pg";

import { ASSET_SCAN_MAX_NETWORKS, type ConfiguredScanNetwork, type CreateScanNetworkInput, type UpdateScanNetworkInput } from "./scan-network-contract.js";

export interface ScanNetworkRepository {
  bootstrap(networks: readonly string[], signal: AbortSignal): Promise<void>;
  list(signal: AbortSignal): Promise<readonly ConfiguredScanNetwork[]>;
  create(input: CreateScanNetworkInput, enabled: boolean, signal: AbortSignal): Promise<ConfiguredScanNetwork>;
  update(id: string, input: UpdateScanNetworkInput, signal: AbortSignal): Promise<ConfiguredScanNetwork | null>;
  remove(id: string, signal: AbortSignal): Promise<boolean>;
}

export class PostgresScanNetworkRepository implements ScanNetworkRepository {
  constructor(private readonly pool: Pool) {}

  async bootstrap(networks: readonly string[], signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(1249073103)");
      const initialized = await client.query("SELECT singleton FROM asset.scan_network_bootstrap WHERE singleton = true");
      if (!initialized.rowCount) {
        for (const cidr of networks.slice(0, ASSET_SCAN_MAX_NETWORKS)) {
          signal.throwIfAborted();
          await client.query({
            text: `INSERT INTO asset.scan_networks (name, network, enabled, origin)
              VALUES (NULL, $1::cidr, true, 'bootstrap') ON CONFLICT (network) DO NOTHING`,
            values: [cidr],
          });
        }
        await client.query("INSERT INTO asset.scan_network_bootstrap (singleton) VALUES (true) ON CONFLICT DO NOTHING");
      }
      await client.query("COMMIT");
    } catch (error) {
      await rollback(client);
      throw error;
    } finally { client.release(); }
    signal.throwIfAborted();
  }

  async list(signal: AbortSignal): Promise<readonly ConfiguredScanNetwork[]> {
    signal.throwIfAborted();
    const result = await this.pool.query<ScanNetworkRow>(
      `SELECT id::text, name, network::text AS cidr, enabled, origin, created_at::text, updated_at::text
       FROM asset.scan_networks WHERE deleted_at IS NULL ORDER BY created_at ASC, id ASC`,
    );
    signal.throwIfAborted();
    return result.rows.map(normalizeRow);
  }

  async create(input: CreateScanNetworkInput, enabled: boolean, signal: AbortSignal): Promise<ConfiguredScanNetwork> {
    signal.throwIfAborted();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(1249073103)");
      const existing = await client.query<{ deleted_at: string | null }>("SELECT deleted_at::text FROM asset.scan_networks WHERE network = $1::cidr FOR UPDATE", [input.cidr]);
      if (existing.rows[0] && existing.rows[0].deleted_at === null) throw new ScanNetworkRepositoryError("SCAN_NETWORK_DUPLICATE");
      const count = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM asset.scan_networks WHERE deleted_at IS NULL");
      if (Number(count.rows[0]?.count ?? ASSET_SCAN_MAX_NETWORKS) >= ASSET_SCAN_MAX_NETWORKS) throw new ScanNetworkRepositoryError("SCAN_NETWORK_LIMIT_REACHED");
      const result = existing.rows[0]
        ? await client.query<ScanNetworkRow>({
          text: `UPDATE asset.scan_networks SET name = $2, enabled = $3, origin = $4, deleted_at = NULL, updated_at = now()
            WHERE network = $1::cidr RETURNING id::text, name, network::text AS cidr, enabled, origin, created_at::text, updated_at::text`,
          values: [input.cidr, input.name, enabled, input.origin],
        })
        : await client.query<ScanNetworkRow>({
          text: `INSERT INTO asset.scan_networks (name, network, enabled, origin) VALUES ($1, $2::cidr, $3, $4)
            RETURNING id::text, name, network::text AS cidr, enabled, origin, created_at::text, updated_at::text`,
          values: [input.name, input.cidr, enabled, input.origin],
        });
      await client.query("COMMIT");
      const row = result.rows[0];
      if (!row) throw new Error("SCAN_NETWORK_CREATE_FAILED");
      return normalizeRow(row);
    } catch (error) {
      await rollback(client);
      if (isUniqueViolation(error)) throw new ScanNetworkRepositoryError("SCAN_NETWORK_DUPLICATE");
      throw error;
    } finally { client.release(); }
  }

  async update(id: string, input: UpdateScanNetworkInput, signal: AbortSignal): Promise<ConfiguredScanNetwork | null> {
    signal.throwIfAborted();
    const result = await this.pool.query<ScanNetworkRow>({
      text: `UPDATE asset.scan_networks SET
        name = CASE WHEN $2::boolean THEN $3 ELSE name END,
        enabled = COALESCE($4::boolean, enabled), updated_at = now()
        WHERE id = $1::uuid AND deleted_at IS NULL
        RETURNING id::text, name, network::text AS cidr, enabled, origin, created_at::text, updated_at::text`,
      values: [id, Object.hasOwn(input, "name"), input.name ?? null, input.enabled ?? null],
    });
    signal.throwIfAborted();
    return result.rows[0] ? normalizeRow(result.rows[0]) : null;
  }

  async remove(id: string, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    const result = await this.pool.query({
      text: "UPDATE asset.scan_networks SET enabled = false, deleted_at = now(), updated_at = now() WHERE id = $1::uuid AND deleted_at IS NULL",
      values: [id],
    });
    signal.throwIfAborted();
    return Boolean(result.rowCount);
  }
}

export class ScanNetworkRepositoryError extends Error {
  constructor(readonly code: "SCAN_NETWORK_DUPLICATE" | "SCAN_NETWORK_LIMIT_REACHED") { super(code); this.name = "ScanNetworkRepositoryError"; }
}

type ScanNetworkRow = QueryResultRow & ConfiguredScanNetwork;
function normalizeRow(row: ScanNetworkRow): ConfiguredScanNetwork { return { ...row }; }
function isUniqueViolation(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "23505"; }
async function rollback(client: PoolClient): Promise<void> { try { await client.query("ROLLBACK"); } catch { /* original failure wins */ } }
