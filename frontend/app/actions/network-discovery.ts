"use server";

import { applicationAuthority, localRunners, type ApplicationAuthority } from "@/lib/application-persistence";
import { requireApprovedProfile } from "@/lib/auth";
import { normalizeDiscoveryRunners, type DiscoveryRunner } from "@/lib/network-discovery-client";

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
