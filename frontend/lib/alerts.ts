"use server";

import { localOpenEvents } from "@/lib/application-persistence";
import type { NetworkHealthEvent } from "@/lib/network-health-client";

export async function loadNetworkHealthAlerts(): Promise<{
  data: NetworkHealthEvent[];
  error: boolean;
}> {
  const rows = await localOpenEvents(500, "network_health");
  return rows ? { data: rows as NetworkHealthEvent[], error: false } : { data: [], error: true };
}
