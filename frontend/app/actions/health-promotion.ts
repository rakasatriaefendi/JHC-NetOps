"use server";

import { requireOperatorProfile } from "@/lib/auth";
import { applicationAuthority, localApplicationRequest, uuid } from "@/lib/application-persistence";

/** Existing Health target promotion, now behind one authority-aware server action. */
export async function promoteHealthTargetsAction(runnerId: string, nodeIds: string[]): Promise<{ ok: boolean }> {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(runnerId) || !Array.isArray(nodeIds) ||
    nodeIds.length < 1 || nodeIds.length > 254 || new Set(nodeIds).size !== nodeIds.length ||
    !nodeIds.every(uuid)) return { ok: false };
  const { supabase, userId } = await requireOperatorProfile();
  if (applicationAuthority() === "local_postgres") {
    const result = await localApplicationRequest("POST", "/api/application/network-targets/promote", {
      actor_id: userId, runner_id: runnerId, node_ids: nodeIds,
    });
    return { ok: result.ok };
  }
  const { error } = await supabase.from("network_targets").upsert(
    nodeIds.map((nodeId) => ({ runner_id: runnerId, node_id: nodeId, enabled: true })),
    { onConflict: "runner_id,node_id" },
  );
  return { ok: !error };
}
