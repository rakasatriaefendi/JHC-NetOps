import { configuredAuthPublicOrigin, resolveAuthRedirectOrigin } from "./auth-redirect-origin.ts";

export const WEB_SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
];

// Explicit reviewed direct entrypoints, NOT an allowlist derived from Host.
// A changed LAN address needs a reviewed policy change, not arbitrary forwarding.
const DIRECT_ORIGINS = new Set([
  "http://192.168.1.130:3401", "http://localhost:3401", "http://127.0.0.1:3401",
]);
const DEVELOPMENT_ORIGINS = new Set(["http://localhost:3000", "http://127.0.0.1:3000"]);

export function trustedMutationOrigin(requestUrl: string, headers: Pick<Headers, "get">,
  publicUrl = process.env.NEXT_PUBLIC_SITE_URL, development = process.env.NODE_ENV === "development"): boolean {
  const rawOrigin = headers.get("origin");
  if (!rawOrigin || rawOrigin === "null") return false;
  let origin: URL;
  let request: URL;
  try {
    origin = new URL(rawOrigin); request = new URL(requestUrl);
    if (origin.origin !== rawOrigin || origin.username || origin.password || !["http:", "https:"].includes(origin.protocol)) return false;
  } catch { return false; }
  const configured = configuredAuthPublicOrigin(publicUrl);
  // Reuse the validated forwarding contract, but NEVER its fallback alone as
  // proof of trust: public requests must match an independently configured host.
  if (configured && origin.origin === configured) {
    const target = new URL(configured);
    const host = headers.get("host");
    const forwardedHost = headers.get("x-forwarded-host");
    const forwardedProto = headers.get("x-forwarded-proto");
    const matchesPublic = request.origin === configured || host === target.host ||
      (forwardedHost === target.host && forwardedProto === target.protocol.slice(0, -1));
    return matchesPublic && resolveAuthRedirectOrigin(requestUrl, headers, publicUrl) === configured;
  }
  return origin.origin === request.origin &&
    (DIRECT_ORIGINS.has(origin.origin) || development && DEVELOPMENT_ORIGINS.has(origin.origin));
}

export function sensitiveResponsePath(path: string): boolean {
  return ["/admin", "/auth", "/login", "/register", "/pending", "/api"].some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}
