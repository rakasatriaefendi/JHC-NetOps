import { normalizedProfile } from "@/lib/auth";
import { applicationAuthority } from "@/lib/application-persistence";
import { localAuthenticatedProfile } from "@/lib/local-auth";
import { localBackendConfig } from "@/lib/assets";
import { createLocalRealtimeProxy } from "@/lib/local-realtime-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function approvedSession(): Promise<boolean> {
  const profile = normalizedProfile(await localAuthenticatedProfile());
  return profile?.status === "approved";
}

export const GET = createLocalRealtimeProxy({
  authenticate: approvedSession,
  backend: () => applicationAuthority() === "local_postgres" ? localBackendConfig() : null,
});
