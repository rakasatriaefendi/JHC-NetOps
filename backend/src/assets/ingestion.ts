import { buildAssetObservations, type AssetEvidenceSource } from "./evidence.js";
import type { AssetRepository } from "./repository.js";

export const ASSET_SYNC_TIMEOUT_MS = 3_000;
export const ASSET_SYNC_MIN_INTERVAL_MS = 30_000;

export interface AssetSynchronizer {
  synchronize(): Promise<number>;
}

export class BoundedAssetSynchronizer implements AssetSynchronizer {
  #inFlight: Promise<number> | null = null;
  #lastAttemptAt = 0;

  constructor(
    private readonly source: AssetEvidenceSource,
    private readonly repository: AssetRepository,
    private readonly timeoutMs = ASSET_SYNC_TIMEOUT_MS,
    private readonly minimumIntervalMs = ASSET_SYNC_MIN_INTERVAL_MS,
    private readonly now = () => Date.now(),
  ) {}

  synchronize(): Promise<number> {
    if (this.#inFlight) return this.#inFlight;
    const now = this.now();
    if (now - this.#lastAttemptAt < this.minimumIntervalMs) return Promise.resolve(0);
    this.#lastAttemptAt = now;
    this.#inFlight = this.#run().finally(() => { this.#inFlight = null; });
    return this.#inFlight;
  }

  async #run(): Promise<number> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    const snapshot = await this.source.load(signal);
    const observations = buildAssetObservations(snapshot);
    if (!observations.length) return 0;
    return this.repository.ingest(observations, signal);
  }
}
