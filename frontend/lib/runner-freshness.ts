// Heartbeat cadence is not advertised to clients. Allow a 60-second cadence
// plus one interval of grace; keep this aligned with the backend control plane.
export const RUNNER_FRESHNESS_MS = 120_000;

export function isRunnerHeartbeatFresh(lastSeenAt: string, nowMs = Date.now()) {
  const lastSeen = Date.parse(lastSeenAt);
  return Number.isFinite(lastSeen) && nowMs - lastSeen <= RUNNER_FRESHNESS_MS;
}
