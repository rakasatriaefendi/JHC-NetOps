import { type NextRequest, NextResponse } from "next/server";

import { LOCAL_AUTH_COOKIE } from "./local-auth-cookie";
import { resolveAuthRedirectOrigin } from "./auth-redirect-origin";
import { sensitiveResponsePath, trustedMutationOrigin } from "./web-security";

const protectedPrefixes = [
  "/dashboard",
  "/traffic",
  "/history",
  "/alerts",
  "/diagnostics",
  "/admin",
  "/pending",
];

export async function updateSession(request: NextRequest) {
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !trustedMutationOrigin(request.url, request.headers)) {
    return NextResponse.json({ error: { code: "MUTATION_ORIGIN_REJECTED" } }, {
      status: 403, headers: { "cache-control": "private, no-store" },
    });
  }
  const hasSessionCookie = request.cookies.has(LOCAL_AUTH_COOKIE);
  const pathname = request.nextUrl.pathname;
  const isProtected = protectedPrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );

  const response = !hasSessionCookie && isProtected ? redirectTo(request, "/login") : NextResponse.next({ request });
  if (isProtected || sensitiveResponsePath(pathname)) response.headers.set("cache-control", "private, no-store");
  return response;
}

function redirectTo(request: NextRequest, pathname: string) {
  return NextResponse.redirect(
    new URL(pathname, resolveAuthRedirectOrigin(request.url, request.headers)),
  );
}
