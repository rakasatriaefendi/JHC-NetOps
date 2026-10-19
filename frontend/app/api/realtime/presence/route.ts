import { cookies } from "next/headers";
import { localAuthenticatedProfile } from "@/lib/local-auth";
import { LOCAL_AUTH_COOKIE } from "@/lib/local-auth-cookie";
import { localBackendConfig } from "@/lib/assets";
import { createLocalRealtimeProxy } from "@/lib/local-realtime-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = createLocalRealtimeProxy({
  authenticate: async () => (await localAuthenticatedProfile())?.status === "approved",
  backend: localBackendConfig,
  upstream: async () => {
    const token = (await cookies()).get(LOCAL_AUTH_COOKIE)?.value;
    return token && /^[A-Za-z0-9_-]{43}$/.test(token)
      ? { path: "/api/application/presence", sessionToken: token } : null;
  },
});
