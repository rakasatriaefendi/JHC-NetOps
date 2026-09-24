import { createClient } from "@/lib/supabase/server";
import { applicationAuthority } from "@/lib/application-persistence";
import { loadLocalAuthenticatedProfile } from "@/lib/auth";
import { localBackendConfig } from "@/lib/assets";
import { createLocalRealtimeProxy } from "@/lib/local-realtime-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function approvedSession(): Promise<boolean> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;
  if (error || !userId) return false;
  const profile = applicationAuthority() === "local_postgres"
    ? await loadLocalAuthenticatedProfile(supabase, userId)
    : (await supabase.from("profiles").select("status").eq("id", userId)
      .maybeSingle<{ status: "pending" | "approved" | "rejected" }>()).data;
  return profile?.status === "approved";
}

export const GET = createLocalRealtimeProxy({
  authenticate: approvedSession,
  backend: () => applicationAuthority() === "local_postgres" ? localBackendConfig() : null,
});
