"use server";

import { localNetworkDiscovery, localRunners } from "./application-persistence.ts";
import type {
  DiscoverySession,
  DiscoveryRunner,
  DiscoveryHost,
  DISCOVERY_RUNNER_FRESHNESS_MS,
  isDiscoveryRunnerOnline,
  observedTrafficIps,
} from "./network-discovery-client.ts";
import { normalizeDiscoveryRunners } from "./network-discovery-client.ts";

export type {
  DiscoverySession,
  DiscoveryRunner,
  DiscoveryHost,
  DISCOVERY_RUNNER_FRESHNESS_MS,
  isDiscoveryRunnerOnline,
  observedTrafficIps,
};

export async function loadDiscoverySessions(isAdmin: boolean) {
  if (!isAdmin) return { data: [] as DiscoverySession[], error: false };
  return { data: [] as DiscoverySession[], error: false };
}

export async function loadDiscoveryRunners(_fallback: DiscoveryRunner[] = []) {
  const rows = await localRunners();
  if (!rows) return { data: [] as DiscoveryRunner[], error: true };
  return {
    data: normalizeDiscoveryRunners(rows),
    error: false,
  };
}

export async function loadDiscoverySessionLocal(runnerId: string): Promise<DiscoverySession | null> {
  const session = await localNetworkDiscovery(runnerId);
  return session as DiscoverySession | null;
}
