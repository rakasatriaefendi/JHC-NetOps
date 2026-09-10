import type { NmapExecutor } from "./scan-executor.js";
import { ScanExecutionError } from "./scan-executor.js";
import { parseNmapXml } from "./nmap-parser.js";
import { normalizeScannedHost } from "./scan-normalize.js";
import type { AssetScanRepository } from "./scan-repository.js";
import {
  ASSET_SCAN_MAX_CONCURRENCY,
  ASSET_SCAN_MAX_HOSTS,
  type AssetScanMode,
  type AssetScanRecord,
  type AssetScanState,
} from "./scan-contract.js";
import type { EnrichedScanNetwork } from "./scan-network-contract.js";

export interface AssetScanNetworkSource {
  enabled(): Promise<readonly EnrichedScanNetwork[]>;
}

export const ASSET_SCAN_DISCOVERY_TIMEOUT_MS = 120_000;
export const ASSET_SCAN_HOST_TIMEOUT_MS = 45_000;
export const ASSET_SCAN_DEFAULT_CONCURRENCY = 4;
export const ASSET_SCAN_PERSIST_TIMEOUT_MS = 7_000;

export class AssetScanController {
  #active: { record: AssetScanRecord; routeKind: "direct" | "routed"; abort: AbortController; done: Promise<void> } | null = null;
  #starting = false;

  constructor(
    private readonly repository: AssetScanRepository,
    private readonly executor: NmapExecutor,
    private readonly networkSource: readonly string[] | AssetScanNetworkSource,
    private readonly concurrency = ASSET_SCAN_DEFAULT_CONCURRENCY,
    private readonly hostTimeoutMs = ASSET_SCAN_HOST_TIMEOUT_MS,
    private readonly discoveryTimeoutMs = ASSET_SCAN_DISCOVERY_TIMEOUT_MS,
    private readonly now = () => new Date(),
  ) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > ASSET_SCAN_MAX_CONCURRENCY) throw new Error("SCAN_CONCURRENCY_INVALID");
  }

  async initialize(): Promise<void> {
    await this.repository.recoverInterrupted(this.now().toISOString(), AbortSignal.timeout(ASSET_SCAN_PERSIST_TIMEOUT_MS));
  }

  async state(): Promise<AssetScanState> {
    const options = await this.#networkOptions();
    const routable = options.filter((item): item is EnrichedScanNetwork & { route_kind: "direct" | "routed" } => item.route_kind === "direct" || item.route_kind === "routed");
    if (!routable.length) return { available: false, networks: [], network_options: [], current: null, last: null };
    const available = await this.executor.available();
    return {
      available,
      networks: routable.map((item) => item.cidr),
      network_options: routable.map((item) => ({ name: item.name, cidr: item.cidr, route_kind: item.route_kind })),
      current: this.#active?.record ?? null,
      last: await this.repository.last(AbortSignal.timeout(ASSET_SCAN_PERSIST_TIMEOUT_MS)),
    };
  }

  async start(mode: AssetScanMode, network: string): Promise<AssetScanRecord> {
    if (this.#active || this.#starting) throw new AssetScanError("SCAN_ALREADY_RUNNING");
    const configured = (await this.#networkOptions()).find((item) => item.cidr === network);
    if (!configured) throw new AssetScanError("SCAN_NETWORK_NOT_ALLOWED");
    if (configured.route_kind !== "direct" && configured.route_kind !== "routed") throw new AssetScanError("SCAN_NETWORK_ROUTE_UNAVAILABLE");
    if (!await this.executor.available()) throw new AssetScanError("SCANNER_UNAVAILABLE");
    this.#starting = true;
    try {
      const startedAt = this.now().toISOString();
      const record = await this.repository.create(mode, network, startedAt, AbortSignal.timeout(ASSET_SCAN_PERSIST_TIMEOUT_MS));
      const abort = new AbortController();
      const active = { record, routeKind: configured.route_kind, abort, done: Promise.resolve() };
      this.#active = active;
      active.done = this.#run(active).finally(() => { if (this.#active === active) this.#active = null; });
      void active.done.catch(() => undefined);
      return record;
    } catch (error) {
      if (isUniqueViolation(error)) throw new AssetScanError("SCAN_ALREADY_RUNNING");
      throw error;
    } finally { this.#starting = false; }
  }

  async cancel(id: string): Promise<AssetScanRecord> {
    const active = this.#active;
    if (!active || active.record.id !== id) throw new AssetScanError("SCAN_NOT_RUNNING");
    active.abort.abort();
    await active.done;
    return active.record;
  }

  async shutdown(): Promise<void> {
    const active = this.#active;
    if (!active) return;
    active.abort.abort();
    await active.done;
  }

  async #run(active: { record: AssetScanRecord; routeKind: "direct" | "routed"; abort: AbortController; done: Promise<void> }): Promise<void> {
    try {
      const discoveryXml = await runBounded(
        this.executor, active.routeKind === "routed" ? "discovery-routed" : "discovery", active.record.network, active.abort.signal, this.discoveryTimeoutMs,
      );
      const discovered = parseNmapXml(discoveryXml, active.record.network).slice(0, ASSET_SCAN_MAX_HOSTS);
      active.record = { ...active.record, discovered_count: discovered.length };
      await this.#persist(active.record);
      if (active.record.mode === "quick") {
        active.abort.signal.throwIfAborted();
        const observedAt = this.now().toISOString();
        await this.repository.ingest(discovered.map((host) => normalizeScannedHost(host, null, observedAt)), active.record.id, AbortSignal.timeout(ASSET_SCAN_PERSIST_TIMEOUT_MS));
        active.abort.signal.throwIfAborted();
        await this.#complete(active, "completed");
        return;
      }

      const results = new Array<ReturnType<typeof parseNmapXml>[number] | null>(discovered.length).fill(null);
      let cursor = 0;
      let completed = 0;
      const worker = async () => {
        while (!active.abort.signal.aborted) {
          const index = cursor++;
          const host = discovered[index];
          if (!host) return;
          active.record = { ...active.record, current_target: host.ip_address };
          try {
            const xml = await runBounded(
              this.executor, "fingerprint", host.ip_address, active.abort.signal, this.hostTimeoutMs,
            );
            const fingerprint = parseNmapXml(xml, active.record.network).find((item) => item.ip_address === host.ip_address) ?? null;
            results[index] = fingerprint;
            active.record = fingerprint
              ? { ...active.record, fingerprinted_count: active.record.fingerprinted_count + 1 }
              : { ...active.record, failed_count: active.record.failed_count + 1 };
          } catch (error) {
            if (active.abort.signal.aborted) throw error;
            active.record = { ...active.record, failed_count: active.record.failed_count + 1 };
          }
          completed += 1;
          if (completed % 10 === 0) await this.#persist(active.record);
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.concurrency, discovered.length || 1) }, worker));
      if (active.abort.signal.aborted) throw new ScanExecutionError("NMAP_CANCELLED");
      const observedAt = this.now().toISOString();
      await this.repository.ingest(discovered.map((host, index) => normalizeScannedHost(host, results[index] ?? null, observedAt)), active.record.id, AbortSignal.timeout(ASSET_SCAN_PERSIST_TIMEOUT_MS));
      active.abort.signal.throwIfAborted();
      await this.#complete(active, "completed");
    } catch (error) {
      if (active.abort.signal.aborted || error instanceof ScanExecutionError && error.code === "NMAP_CANCELLED") {
        await this.#complete(active, "cancelled", "SCAN_CANCELLED");
      } else {
        await this.#complete(active, "failed", safeErrorCode(error));
      }
    }
  }

  async #complete(active: { record: AssetScanRecord }, status: "completed" | "failed" | "cancelled", errorCode: string | null = null): Promise<void> {
    const at = this.now().toISOString();
    active.record = {
      ...active.record,
      status,
      current_target: null,
      completed_at: status === "cancelled" ? null : at,
      cancelled_at: status === "cancelled" ? at : null,
      error_code: errorCode,
    };
    await this.#persist(active.record);
  }

  #persist(record: AssetScanRecord): Promise<void> {
    return this.repository.update(record, AbortSignal.timeout(ASSET_SCAN_PERSIST_TIMEOUT_MS));
  }

  async #networkOptions(): Promise<readonly EnrichedScanNetwork[]> {
    if (!isStaticNetworkSource(this.networkSource)) return this.networkSource.enabled();
    const now = this.now().toISOString();
    return this.networkSource.map((cidr, index) => ({
      id: `static-${index}`,
      name: null,
      cidr,
      enabled: true,
      origin: "bootstrap" as const,
      created_at: now,
      updated_at: now,
      route_kind: "direct" as const,
      interface_name: null,
      source_ip: null,
      gateway: null,
      reason_code: "ROUTE_AVAILABLE" as const,
    }));
  }
}

export class AssetScanError extends Error {
  constructor(readonly code: "SCAN_ALREADY_RUNNING" | "SCANNER_UNAVAILABLE" | "SCAN_NOT_RUNNING" | "SCAN_NETWORK_NOT_ALLOWED" | "SCAN_NETWORK_ROUTE_UNAVAILABLE") { super(code); this.name = "AssetScanError"; }
}

function safeErrorCode(error: unknown): string {
  if (error instanceof ScanExecutionError) return error.code;
  if (error instanceof Error && error.message === "NMAP_OUTPUT_INVALID") return "NMAP_OUTPUT_INVALID";
  if (error instanceof Error && error.message === "SCAN_TIMEOUT") return "SCAN_TIMEOUT";
  if (error instanceof DOMException && error.name === "TimeoutError") return "SCAN_TIMEOUT";
  return "SCAN_FAILED";
}

async function runBounded(
  executor: NmapExecutor,
  mode: "discovery" | "discovery-routed" | "fingerprint",
  target: string,
  parentSignal: AbortSignal,
  timeoutMs: number,
): Promise<string> {
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    return await executor.run(mode, target, AbortSignal.any([parentSignal, timeout]));
  } catch (error) {
    if (timeout.aborted && !parentSignal.aborted) throw new Error("SCAN_TIMEOUT");
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

function isStaticNetworkSource(value: readonly string[] | AssetScanNetworkSource): value is readonly string[] {
  return Array.isArray(value);
}
