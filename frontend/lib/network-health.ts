"use server";

import { localEvents, localHealthTargets, localRunners, localHealthSamples } from "./application-persistence.ts";
import { requireApprovedProfile } from "./auth";
import type { HealthHistoryResult } from "./health-history.ts";
import type {
  HealthStatus,
  NetworkHealthTarget,
  NetworkHealthEvent,
  NetworkHealthSample,
  HealthTrendRange,
} from "./network-health-client.ts";

export type {
  HealthStatus,
  NetworkHealthTarget,
  NetworkHealthEvent,
  NetworkHealthSample,
  HealthTrendRange,
};

export async function loadNetworkHealth() {
  return loadNetworkHealthLocal();
}

export async function loadNetworkHealthHistory() {
  const events = await localEvents(100, "network_health");
  return { data: events ? events as NetworkHealthEvent[] : [], error: !events };
}

async function loadNetworkHealthLocal() {
  const [rows, runners, events] = await Promise.all([
    localHealthTargets(),
    localRunners(),
    localEvents(20, "network_health"),
  ]);
  if (!rows || !runners || !events) return { data: [], events: [], error: true };
  const capabilityByRunner = new Map(runners.map((runner) => [String(runner.id), relation(runner.capabilities)]));
  const data = rows.filter((row) => row.enabled === true).map((row): NetworkHealthTarget => {
    const node = relation(row.node) as NetworkHealthTarget["node"];
    const latest = relation(row.latest) as NetworkHealthTarget["latest"];
    const capabilities = capabilityByRunner.get(String(row.runner_id));
    const targets = Array.isArray(capabilities?.targets) ? capabilities.targets : [];
    const diagnosticTarget = targets.find((target) => relation(target)?.host === node.ip_address);
    const operations = Array.isArray(capabilities?.operations) ? capabilities.operations : [];
    return {
      ...row,
      node,
      latest,
      diagnostic_target_id: relation(diagnosticTarget)?.id ? String(relation(diagnosticTarget)!.id) : null,
      manual_ping_available: operations.includes("manual_ping"),
    } as NetworkHealthTarget;
  });
  return { data, events: events as NetworkHealthEvent[], error: false };
}

export async function loadHealthSamples(targetIds: string[], range: HealthTrendRange): Promise<HealthHistoryResult> {
  await requireApprovedProfile();
  return localHealthSamples(targetIds, range);
}

function relation(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return Array.isArray(value) && value[0] && typeof value[0] === "object" ? value[0] as Record<string, unknown> : null;
}
