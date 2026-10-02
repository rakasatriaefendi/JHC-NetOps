import "server-only";

import { localNetworkNodes } from "./application-persistence.ts";
import type { NetworkNode } from "./network-nodes.ts";

export async function loadAuthoritativeNetworkNodes(): Promise<{ data: NetworkNode[]; error: boolean }> {
  const rows = await localNetworkNodes();
  return rows ? { data: rows as NetworkNode[], error: false } : { data: [], error: true };
}
