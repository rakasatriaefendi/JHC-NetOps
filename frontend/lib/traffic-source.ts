import "server-only";

import { localRunners, localTrafficState, type ApplicationAuthority } from "@/lib/application-persistence";
import { emptyTrafficState, mergeTrafficRunnerSnapshots, normalizeTrafficRunnerSnapshots, type TrafficState } from "@/lib/traffic";
import type { ProfileRole } from "@/lib/authorization";

export async function loadAuthoritativeTrafficState(
  role: ProfileRole,
): Promise<{ authority: ApplicationAuthority; data: TrafficState; error: boolean }> {
  const authority = "local_postgres" as const;
  const [state, runnerRows] = await Promise.all([localTrafficState(), localRunners()]);
  if (!state || !runnerRows || !Array.isArray(state.sessions) || !Array.isArray(state.snapshots) ||
      typeof state.storage_status !== "object" || state.storage_status === null) {
    return { authority, data: emptyTrafficState(role), error: true };
  }
  return {
    data: {
      runners: mergeTrafficRunnerSnapshots([], normalizeTrafficRunnerSnapshots(runnerRows)),
      sessions: state.sessions as TrafficState["sessions"],
      snapshots: state.snapshots as TrafficState["snapshots"],
      storage_status: state.storage_status as TrafficState["storage_status"],
      role,
      server_time: new Date().toISOString(),
    },
    authority,
    error: false,
  };
}
