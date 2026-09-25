import { type NextRequest, NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { resolveAuthRedirectOrigin } from "@/lib/auth-redirect-origin";

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const redirectOrigin = resolveAuthRedirectOrigin(requestUrl, request.headers);
  const code = requestUrl.searchParams.get("code");
  const requestedNext = requestUrl.searchParams.get("next") ?? "/pending";
  const next =
    requestedNext.startsWith("/") && !requestedNext.startsWith("//")
      ? requestedNext
      : "/pending";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      return privateRedirect(new URL(next, redirectOrigin));
    }
  }

  return privateRedirect(
    new URL("/login?error=confirmation-failed", redirectOrigin),
  );
}

function privateRedirect(url: URL) {
  const response = NextResponse.redirect(url);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
