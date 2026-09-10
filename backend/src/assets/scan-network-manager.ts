import { ASSET_PERSISTENCE_TIMEOUT_MS } from "./route.js";
import type { ScanNetworkAdapter } from "./scan-network-adapter.js";
import type {
  ConfiguredScanNetwork,
  CreateScanNetworkInput,
  EnrichedScanNetwork,
  ScanNetworkDetection,
  ScanNetworkRoute,
  UpdateScanNetworkInput,
} from "./scan-network-contract.js";
import type { ScanNetworkRepository } from "./scan-network-repository.js";

export const SCAN_NETWORK_ROUTE_TIMEOUT_MS = 3_000;

export class ScanNetworkManager {
  constructor(
    private readonly repository: ScanNetworkRepository,
    private readonly adapter: ScanNetworkAdapter,
    private readonly timeoutMs = ASSET_PERSISTENCE_TIMEOUT_MS,
  ) {}

  initialize(bootstrapNetworks: readonly string[]): Promise<void> {
    return this.repository.bootstrap(bootstrapNetworks, AbortSignal.timeout(this.timeoutMs));
  }

  async list(): Promise<readonly EnrichedScanNetwork[]> {
    const rows = await this.repository.list(AbortSignal.timeout(this.timeoutMs));
    return Promise.all(rows.map(async (row) => ({ ...row, ...await this.inspect(row.cidr) })));
  }

  async detected(): Promise<ScanNetworkDetection> {
    return this.adapter.detect(AbortSignal.timeout(SCAN_NETWORK_ROUTE_TIMEOUT_MS));
  }

  inspect(cidr: string): Promise<ScanNetworkRoute> {
    return this.adapter.inspect(cidr, AbortSignal.timeout(SCAN_NETWORK_ROUTE_TIMEOUT_MS));
  }

  async create(input: CreateScanNetworkInput): Promise<{ network: ConfiguredScanNetwork; route: ScanNetworkRoute; warning: boolean }> {
    const route = await this.inspect(input.cidr);
    const enabled = route.route_kind === "direct" || route.route_kind === "routed";
    const network = await this.repository.create(input, enabled, AbortSignal.timeout(this.timeoutMs));
    return { network, route, warning: !enabled };
  }

  async update(id: string, input: UpdateScanNetworkInput): Promise<ConfiguredScanNetwork | null> {
    if (input.enabled === true) {
      const row = (await this.repository.list(AbortSignal.timeout(this.timeoutMs))).find((item) => item.id === id);
      if (!row) return null;
      const route = await this.inspect(row.cidr);
      if (route.route_kind !== "direct" && route.route_kind !== "routed") throw new ScanNetworkManagerError("SCAN_NETWORK_ROUTE_UNAVAILABLE");
    }
    return this.repository.update(id, input, AbortSignal.timeout(this.timeoutMs));
  }

  remove(id: string): Promise<boolean> {
    return this.repository.remove(id, AbortSignal.timeout(this.timeoutMs));
  }

  async enabled(): Promise<readonly EnrichedScanNetwork[]> {
    return (await this.list()).filter((item) => item.enabled);
  }
}

export class ScanNetworkManagerError extends Error {
  constructor(readonly code: "SCAN_NETWORK_ROUTE_UNAVAILABLE") { super(code); this.name = "ScanNetworkManagerError"; }
}
