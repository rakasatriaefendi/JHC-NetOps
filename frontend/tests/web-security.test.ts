import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { WEB_SECURITY_HEADERS, trustedMutationOrigin, sensitiveResponsePath } from "../lib/web-security.ts";
import { boundedRequestBytes } from "../lib/bounded-request.ts";

const PUBLIC = "https://noc.jhchospitalgroup.id";
const LAN = "http://192.168.1.130:3401";
const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("narrow headers protect frames, MIME, base/form origin, referrer and unnecessary browser capabilities", () => {
  const headers = Object.fromEntries(WEB_SECURITY_HEADERS.map(({ key, value }) => [key, value]));
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.equal(headers["X-Frame-Options"], "DENY");
  assert.equal(headers["Content-Security-Policy"], "frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  assert.equal(headers["Referrer-Policy"], "strict-origin-when-cross-origin");
  assert.equal(headers["Permissions-Policy"], "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  assert.doesNotMatch(headers["Content-Security-Policy"]!, /script-src|style-src|connect-src|unsafe-eval/);
  assert.match(source("../next.config.ts"), /source: "\/:path\*", headers: WEB_SECURITY_HEADERS/);
});

test("configured public, reviewed direct LAN and validated public forwarding mutations are accepted", () => {
  assert.equal(trustedMutationOrigin(`${PUBLIC}/login`, new Headers({ origin: PUBLIC, host: "noc.jhchospitalgroup.id" }), PUBLIC, false), true);
  assert.equal(trustedMutationOrigin(`${LAN}/admin`, new Headers({ origin: LAN, host: "192.168.1.130:3401" }), PUBLIC, false), true);
  assert.equal(trustedMutationOrigin(`${LAN}/admin`, new Headers({ origin: PUBLIC, host: "192.168.1.130:3401",
    "x-forwarded-host": "noc.jhchospitalgroup.id", "x-forwarded-proto": "https" }), PUBLIC, false), true);
  assert.equal(trustedMutationOrigin("http://localhost:3000/login", new Headers({ origin: "http://localhost:3000" }), undefined, true), true);
});

test("foreign/null/missing/malformed origins and arbitrary Host/forwarded headers cannot establish mutation trust", () => {
  for (const origin of ["https://attacker.invalid", "null", `${PUBLIC}/evil`, `${PUBLIC}, https://attacker.invalid`]) {
    assert.equal(trustedMutationOrigin(`${LAN}/admin`, new Headers({ origin }), PUBLIC, false), false);
  }
  assert.equal(trustedMutationOrigin(`${LAN}/admin`, new Headers(), PUBLIC, false), false);
  assert.equal(trustedMutationOrigin("https://attacker.invalid/admin", new Headers({ origin: "https://attacker.invalid", host: "attacker.invalid" }), PUBLIC, false), false);
  assert.equal(trustedMutationOrigin("http://192.168.99.99:3401/admin", new Headers({ origin: "http://192.168.99.99:3401", host: "192.168.99.99:3401" }), PUBLIC, false), false);
  assert.equal(trustedMutationOrigin(`${LAN}/admin`, new Headers({ origin: "https://attacker.invalid", "x-forwarded-host": "attacker.invalid", "x-forwarded-proto": "https" }), PUBLIC, false), false);
  assert.equal(trustedMutationOrigin(`${LAN}/admin`, new Headers({ origin: PUBLIC, "x-forwarded-host": "noc.jhchospitalgroup.id,attacker.invalid", "x-forwarded-proto": "https" }), PUBLIC, false), false);
  assert.equal(trustedMutationOrigin(`${LAN}/admin`, new Headers({ origin: PUBLIC, "x-forwarded-host": "noc.jhchospitalgroup.id", "x-forwarded-proto": "http" }), PUBLIC, false), false);
});

test("proxy rejects foreign writes before authentication and marks sensitive responses private/no-store", () => {
  const proxy = source("../lib/auth-proxy.ts");
  assert.ok(proxy.indexOf("trustedMutationOrigin(request.url, request.headers)") < proxy.indexOf("request.cookies.has"));
  assert.match(proxy, /\["GET", "HEAD", "OPTIONS"\]\.includes\(request.method\)/);
  assert.match(proxy, /status: 403/);
  assert.match(proxy, /response.headers.set\("cache-control", "private, no-store"\)/);
  assert.match(source("../proxy.ts"), /source: "\/:path\*", has: \[\{ type: "header", key: "next-action" \}\]/);
  for (const path of ["/admin", "/admin/report-branding", "/auth/resolve", "/login", "/register", "/pending", "/api/realtime/events"]) assert.equal(sensitiveResponsePath(path), true);
  assert.equal(sensitiveResponsePath("/_next/static/script.js"), false);
});

test("existing opaque cookie/auth/loopback/secret-free runtime protections remain intact", () => {
  const auth = source("../lib/local-auth.ts");
  assert.match(auth, /httpOnly: true/); assert.match(auth, /sameSite: "lax"/); assert.match(auth, /secure,/);
  assert.match(auth, /cache: "no-store"/);
  const persistence = source("../lib/application-persistence.ts");
  assert.match(persistence, /^import "server-only"/);
  assert.match(persistence, /cache: "no-store"/);
  const assets = source("../lib/assets.ts");
  assert.match(assets, /127\.0\.0\.1/);
  assert.match(assets, /LOCAL_BACKEND_FRONTEND_TOKEN/);
  const config = source("../../backend/src/config.ts");
  assert.match(config, /LOOPBACK_HOSTS.has\(host\)/);
  assert.match(config, /parsePersistenceAuthority\(environment.PERSISTENCE_AUTHORITY\)/);
  assert.match(config, /url.port !== "5433"/);
  for (const path of ["../lib/auth-proxy.ts", "../components/ui/action-feedback.tsx", "../lib/web-security.ts"]) {
    assert.doesNotMatch(source(path), /supabase|console\.(?:log|error)|DATABASE_URL|Bearer\s+/i);
  }
});

test("branding actual request body is bounded even when Content-Length is absent", async () => {
  const small = new Request("http://localhost/admin/report-branding", { method: "PUT", body: "{}" });
  assert.equal(new TextDecoder().decode((await boundedRequestBytes(small, 2))!), "{}");
  const large = new Request("http://localhost/admin/report-branding", { method: "PUT", body: "{oversized}" });
  assert.equal(await boundedRequestBytes(large, 2), null);
  assert.equal(await boundedRequestBytes(new Request("http://localhost/admin"), 2), null);
});
