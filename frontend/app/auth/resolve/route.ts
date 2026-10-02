import { NextResponse } from "next/server";

import { normalizedProfile } from "@/lib/auth";
import { authDestination } from "@/lib/auth-destination";
import { resolveAuthRedirectOrigin } from "@/lib/auth-redirect-origin";
import { localAuthenticatedProfile } from "@/lib/local-auth";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const redirectOrigin = resolveAuthRedirectOrigin(requestUrl, request.headers);
  const profile = normalizedProfile(await localAuthenticatedProfile());
  if (!profile) {
    return privateRedirect(new URL("/login", redirectOrigin));
  }

  const destination = authDestination(profile.status);
  return privateRedirect(new URL(destination, redirectOrigin));
}

function privateRedirect(url: URL) {
  const response = NextResponse.redirect(url);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
