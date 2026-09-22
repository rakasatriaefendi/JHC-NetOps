"use server";

import { applicationAuthority, localNetworkDiscovery, localRunners, type ApplicationAuthority } from "@/lib/application-persistence";
import { requireApprovedProfile } from "@/lib/auth";
import { normalizeDiscoveryRunners, type DiscoveryRunner, type DiscoverySession } from "@/lib/network-discovery-client";

export type DiscoveryRunnersResult = {
  ok: boolean;
  authority: ApplicationAuthority;
  data: DiscoveryRunner[];
};

export async function getDiscoveryRunnersAction(): Promise<DiscoveryRunnersResult> {
  const { supabase } = await requireApprovedProfile();
  const authority = applicationAuthority();
  if (authority === "local_postgres") {
    const rows = await localRunners();
    return rows
      ? { ok: true, authority, data: normalizeDiscoveryRunners(rows) }
      : { ok: false, authority, data: [] };
  }
  const { data, error } = await supabase.from("diagnostic_runners")
    .select("id,display_name,last_seen_at,health_status,capabilities")
    .order("display_name");
  return error || !data
    ? { ok: false, authority, data: [] }
    : { ok: true, authority, data: normalizeDiscoveryRunners(data) };
}

export type DiscoverySessionResult = {
  ok: boolean;
  authority: ApplicationAuthority;
  data: DiscoverySession | null;
};

export async function getDiscoverySessionAction(runnerId: string): Promise<DiscoverySessionResult> {
  const { supabase } = await requireApprovedProfile();
  const authority = applicationAuthority();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(runnerId)) return { ok: false, authority, data: null };
  if (authority === "local_postgres") {
    const session = await localNetworkDiscovery(runnerId);
    return { ok: true, authority, data: session as DiscoverySession | null };
  }
  const { data, error } = await supabase.from("network_discovery_sessions")
    .select("*").eq("runner_id", runnerId).maybeSingle<DiscoverySession>();
  return error ? { ok: false, authority, data: null } : { ok: true, authority, data };
}
