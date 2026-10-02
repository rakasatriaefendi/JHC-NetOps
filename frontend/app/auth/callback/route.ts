import { type NextRequest, NextResponse } from "next/server";

import { resolveAuthRedirectOrigin } from "@/lib/auth-redirect-origin";

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const redirectOrigin = resolveAuthRedirectOrigin(requestUrl, request.headers);
  return privateRedirect(
    new URL("/login?error=legacy-confirmation-unavailable", redirectOrigin),
  );
}

function privateRedirect(url: URL) {
  const response = NextResponse.redirect(url);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
