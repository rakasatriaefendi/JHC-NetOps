import { type NextRequest, NextResponse } from "next/server";

import { LOCAL_AUTH_COOKIE } from "./local-auth-cookie";
import { resolveAuthRedirectOrigin } from "./auth-redirect-origin";

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
  const hasSessionCookie = request.cookies.has(LOCAL_AUTH_COOKIE);
  const pathname = request.nextUrl.pathname;
  const isProtected = protectedPrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );

  if (!hasSessionCookie && isProtected) return redirectTo(request, "/login");
  return NextResponse.next({ request });
}

function redirectTo(request: NextRequest, pathname: string) {
  return NextResponse.redirect(
    new URL(pathname, resolveAuthRedirectOrigin(request.url, request.headers)),
  );
}
