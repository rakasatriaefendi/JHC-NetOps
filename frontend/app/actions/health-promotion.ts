"use server";

import { requireApprovedProfile, requireOperatorProfile } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { localApplicationRequest, localHealthTargets, uuid } from "@/lib/application-persistence";

export async function healthTargetMonitoringStateAction(runnerId: string, nodeId: string): Promise<boolean> {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(runnerId) || !uuid(nodeId)) return false;
  await requireApprovedProfile();
  const targets = await localHealthTargets();
  return Boolean(targets?.some((target) => target.runner_id === runnerId &&
    target.node_id === nodeId && target.enabled === true));
}

/** Existing Health target promotion, now behind one authority-aware server action. */
export async function promoteHealthTargetsAction(runnerId: string, nodeIds: string[]): Promise<{ ok: boolean }> {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(runnerId) || !Array.isArray(nodeIds) ||
    nodeIds.length < 1 || nodeIds.length > 254 || new Set(nodeIds).size !== nodeIds.length ||
    !nodeIds.every(uuid)) return { ok: false };
  const { userId } = await requireOperatorProfile();
  const result = await localApplicationRequest("POST", "/api/application/network-targets/promote", {
    actor_id: userId, runner_id: runnerId, node_ids: nodeIds,
  });
  if (!result.ok) return { ok: false };
  const latest = await localHealthTargets();
  if (!latest || !nodeIds.every((id) => latest.some((target) => target.runner_id === runnerId && target.node_id === id && target.enabled === true))) return { ok: false };
  revalidatePath("/dashboard");
  revalidatePath("/devices");
  return { ok: true };
}
