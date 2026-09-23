"use server";

import { requireApprovedProfile } from "@/lib/auth";
import { applicationAuthority, localRunners, type ApplicationAuthority } from "@/lib/application-persistence";
import { normalizeTrafficRunnerSnapshots, type TrafficRunnerSnapshot, type TrafficState } from "@/lib/traffic";
import { loadAuthoritativeTrafficState } from "@/lib/traffic-source";

export type TrafficRunnersResult = {
  ok: boolean;
  authority: ApplicationAuthority;
  data: TrafficRunnerSnapshot[];
};

export async function getTrafficRunnersAction(): Promise<TrafficRunnersResult> {
  const { supabase } = await requireApprovedProfile();
  const authority = applicationAuthority();
  if (authority === "local_postgres") {
    const rows = await localRunners();
    return rows
      ? { ok: true, authority, data: normalizeTrafficRunnerSnapshots(rows) }
      : { ok: false, authority, data: [] };
  }
  const { data, error } = await supabase.from("diagnostic_runners")
    .select("id,display_name,last_seen_at,health_status,capabilities")
    .order("display_name");
  return error || !data
    ? { ok: false, authority, data: [] }
    : { ok: true, authority, data: normalizeTrafficRunnerSnapshots(data) };
}

export async function getTrafficStateAction(): Promise<Readonly<{
  ok: boolean;
  authority: ApplicationAuthority;
  data: TrafficState | null;
}>> {
  const { supabase, profile } = await requireApprovedProfile();
  const state = await loadAuthoritativeTrafficState(supabase, profile.role);
  return { ok: !state.error, authority: state.authority, data: state.error ? null : state.data };
}
