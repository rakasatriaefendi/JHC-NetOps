import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { loadLocalAuthenticatedProfile } from "@/lib/auth";
import { resolveAuthRedirectOrigin } from "@/lib/auth-redirect-origin";
import { applicationAuthority } from "@/lib/application-persistence";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const redirectOrigin = resolveAuthRedirectOrigin(requestUrl, request.headers);
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;

  if (error || !userId) {
    return privateRedirect(new URL("/login", redirectOrigin));
  }

  const profile = applicationAuthority() === "local_postgres"
    ? await loadLocalAuthenticatedProfile(supabase, userId)
    : (await supabase.from("profiles").select("status").eq("id", userId)
      .maybeSingle<{ status: "pending" | "approved" | "rejected" }>()).data;

  const destination = profile?.status === "approved" ? "/dashboard" : "/pending";
  return privateRedirect(new URL(destination, redirectOrigin));
}

function privateRedirect(url: URL) {
  const response = NextResponse.redirect(url);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
