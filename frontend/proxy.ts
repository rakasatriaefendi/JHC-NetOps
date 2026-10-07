import { type NextRequest } from "next/server";

import { updateSession } from "@/lib/auth-proxy";

export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
    // Server Actions must receive the same mutation-origin checks even when
    // addressed through a pathname otherwise excluded as a static asset.
    { source: "/:path*", has: [{ type: "header", key: "next-action" }] },
  ],
};

