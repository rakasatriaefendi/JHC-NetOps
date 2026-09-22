"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import { applicationAuthority, localNetworkDiscovery, localRunners } from "./application-persistence.ts";
import type {
  DiscoverySession,
  DiscoveryRunner,
  DiscoveryHost,
  DISCOVERY_RUNNER_FRESHNESS_MS,
  isDiscoveryRunnerOnline,
  observedTrafficIps,
} from "./network-discovery-client.ts";

export type {
  DiscoverySession,
  DiscoveryRunner,
  DiscoveryHost,
  DISCOVERY_RUNNER_FRESHNESS_MS,
  isDiscoveryRunnerOnline,
  observedTrafficIps,
};

export async function loadDiscoverySessions(supabase: SupabaseClient, isAdmin: boolean) {
  if (!isAdmin) return { data: [] as DiscoverySession[], error: false };
  if (applicationAuthority() === "local_postgres") {
    // Local mode: admin discovery sessions not yet exposed via API; return empty
    return { data: [] as DiscoverySession[], error: false };
  }
  const { data, error } = await supabase.from("network_discovery_sessions").select("*").limit(50).returns<DiscoverySession[]>();
  return { data: data ?? [], error: Boolean(error) };
}

export async function loadDiscoveryRunners(fallback: DiscoveryRunner[]) {
  if (applicationAuthority() !== "local_postgres") {
    return { data: fallback, error: false };
  }
  const rows = await localRunners();
  if (!rows) return { data: [] as DiscoveryRunner[], error: true };
  return {
    data: rows.map(normalizeDiscoveryRunner).filter((runner): runner is DiscoveryRunner => runner !== null),
    error: false,
  };
}

export async function loadDiscoverySessionLocal(runnerId: string): Promise<DiscoverySession | null> {
  if (applicationAuthority() !== "local_postgres") return null;
  const session = await localNetworkDiscovery(runnerId);
  return session as DiscoverySession | null;
}

function normalizeDiscoveryRunner(row: Record<string, unknown>): DiscoveryRunner | null {
  const capabilities = record(row.capabilities) ? row.capabilities : null;
  const operations = capabilities && Array.isArray(capabilities.operations)
    ? capabilities.operations.filter((operation): operation is string => typeof operation === "string")
    : [];
  if (typeof row.id !== "string" || typeof row.display_name !== "string"
    || typeof row.last_seen_at !== "string"
    || (row.health_status !== "online" && row.health_status !== "degraded")) return null;
  return {
    id: row.id,
    display_name: row.display_name,
    last_seen_at: row.last_seen_at,
    health_status: row.health_status,
    capabilities: { operations },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
