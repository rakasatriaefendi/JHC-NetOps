import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { applicationAuthority, localNetworkNodes } from "./application-persistence.ts";
import { loadNetworkNodes, type NetworkNode } from "./network-nodes.ts";

export async function loadAuthoritativeNetworkNodes(
  supabase: SupabaseClient,
): Promise<{ data: NetworkNode[]; error: boolean }> {
  if (applicationAuthority() === "local_postgres") {
    const rows = await localNetworkNodes();
    return rows ? { data: rows as NetworkNode[], error: false } : { data: [], error: true };
  }
  return loadNetworkNodes(supabase);
}
