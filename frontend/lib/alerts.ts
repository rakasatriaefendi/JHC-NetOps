"use server";

import type { SupabaseClient } from "@supabase/supabase-js";

import { applicationAuthority, localOpenEvents } from "@/lib/application-persistence";
import type { NetworkHealthEvent } from "@/lib/network-health-client";

export async function loadNetworkHealthAlerts(supabase: SupabaseClient): Promise<{
  data: NetworkHealthEvent[];
  error: boolean;
}> {
  if (applicationAuthority() === "local_postgres") {
    const rows = await localOpenEvents(500, "network_health");
    return rows ? { data: rows as NetworkHealthEvent[], error: false } : { data: [], error: true };
  }
  const { data, error } = await supabase.from("events")
    .select("id,created_at,severity,title,description,source_ref,resolved_at,raw_context")
    .eq("source", "network_health")
    .is("resolved_at", null)
    .order("created_at", { ascending: false })
    .returns<NetworkHealthEvent[]>();
  return { data: data ?? [], error: Boolean(error) };
}
