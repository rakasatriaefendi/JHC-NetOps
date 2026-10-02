"use server";

import { requireApprovedProfile } from "@/lib/auth";
import { localRunners, type ApplicationAuthority } from "@/lib/application-persistence";
import { normalizeTrafficRunnerSnapshots, type TrafficRunnerSnapshot, type TrafficState } from "@/lib/traffic";
import { loadAuthoritativeTrafficState } from "@/lib/traffic-source";

export type TrafficRunnersResult = {
  ok: boolean;
  authority: ApplicationAuthority;
  data: TrafficRunnerSnapshot[];
};

export async function getTrafficRunnersAction(): Promise<TrafficRunnersResult> {
  await requireApprovedProfile();
  const authority = "local_postgres" as const;
  const rows = await localRunners();
  return rows
    ? { ok: true, authority, data: normalizeTrafficRunnerSnapshots(rows) }
    : { ok: false, authority, data: [] };
}

export async function getTrafficStateAction(): Promise<Readonly<{
  ok: boolean;
  authority: ApplicationAuthority;
  data: TrafficState | null;
}>> {
  const { profile } = await requireApprovedProfile();
  const state = await loadAuthoritativeTrafficState(profile.role);
  return { ok: !state.error, authority: state.authority, data: state.error ? null : state.data };
}
