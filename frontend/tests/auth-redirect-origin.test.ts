import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  configuredAuthPublicOrigin,
  resolveAuthRedirectOrigin,
} from "../lib/auth-redirect-origin.ts";

const PUBLIC_ORIGIN = "https://noc.jhchospitalgroup.id";
const LAN_ORIGIN = "http://192.168.1.130:3401";

test("trusted reverse-proxy headers select only the configured public origin", () => {
  const headers = new Headers({
    host: "192.168.1.130:3401",
    "x-forwarded-host": "noc.jhchospitalgroup.id",
    "x-forwarded-proto": "https",
  });
  assert.equal(resolveAuthRedirectOrigin(`${LAN_ORIGIN}/auth/resolve`, headers, PUBLIC_ORIGIN), PUBLIC_ORIGIN);
});

test("direct private LAN requests retain their request origin", () => {
  const headers = new Headers({ host: "192.168.1.130:3401" });
  assert.equal(resolveAuthRedirectOrigin(`${LAN_ORIGIN}/auth/resolve`, headers, PUBLIC_ORIGIN), LAN_ORIGIN);
});

test("arbitrary host and forwarded-host values cannot become redirect origins", () => {
  const spoofedForward = new Headers({
    host: "192.168.1.130:3401",
    "x-forwarded-host": "attacker.example",
    "x-forwarded-proto": "https",
  });
  assert.equal(resolveAuthRedirectOrigin(`${LAN_ORIGIN}/auth/resolve`, spoofedForward, PUBLIC_ORIGIN), LAN_ORIGIN);

  const spoofedRequest = new Headers({ host: "attacker.example" });
  assert.equal(resolveAuthRedirectOrigin("https://attacker.example/auth/resolve", spoofedRequest, PUBLIC_ORIGIN), PUBLIC_ORIGIN);
});

test("malformed configured site URLs fail closed while direct LAN remains usable", () => {
  const directHeaders = new Headers({ host: "192.168.1.130:3401" });
  for (const malformed of [
    "ftp://noc.jhchospitalgroup.id",
    "https://user:secret@noc.jhchospitalgroup.id",
    "https://noc.jhchospitalgroup.id/path",
    "https://noc.jhchospitalgroup.id?query=1",
    "not-a-url",
  ]) {
    assert.equal(configuredAuthPublicOrigin(malformed), null);
    assert.equal(resolveAuthRedirectOrigin(`${LAN_ORIGIN}/auth/resolve`, directHeaders, malformed), LAN_ORIGIN);
  }
  assert.equal(
    resolveAuthRedirectOrigin("https://attacker.example/auth/resolve", new Headers(), "not-a-url"),
    "http://localhost",
  );
});

test("auth routes retain destinations and cache policy with local session operations", () => {
  const resolveRoute = readFileSync(new URL("../app/auth/resolve/route.ts", import.meta.url), "utf8");
  const callbackRoute = readFileSync(new URL("../app/auth/callback/route.ts", import.meta.url), "utf8");
  const authActions = readFileSync(new URL("../app/actions/auth.ts", import.meta.url), "utf8");
  const loginForm = readFileSync(new URL("../components/auth/login-form.tsx", import.meta.url), "utf8");
  const proxy = readFileSync(new URL("../lib/auth-proxy.ts", import.meta.url), "utf8");

  assert.match(resolveRoute, /resolveAuthRedirectOrigin\(requestUrl, request\.headers\)/);
  assert.match(resolveRoute, /authDestination\(profile\.status\)/);
  assert.match(resolveRoute, /new URL\("\/login", redirectOrigin\)/);
  assert.match(resolveRoute, /localAuthenticatedProfile\(\)/);
  assert.match(resolveRoute, /Cache-Control", "private, no-store"/);
  assert.doesNotMatch(resolveRoute, /export async function POST/);

  assert.match(callbackRoute, /resolveAuthRedirectOrigin\(requestUrl, request\.headers\)/);
  assert.doesNotMatch(callbackRoute, /supabase\.auth\./);
  assert.match(callbackRoute, /\/login\?error=legacy-confirmation-unavailable/);
  assert.match(callbackRoute, /Cache-Control", "private, no-store"/);

  assert.match(authActions, /localAuthLogin\(email, password\)/);
  assert.match(authActions, /formData\.get\("email"\)/);
  assert.match(authActions, /formData\.get\("password"\)/);
  assert.match(authActions, /return \{ error: null, message: null, authenticated: true \}/);
  assert.doesNotMatch(authActions, /redirect\("\/auth\/resolve"\)/);
  assert.doesNotMatch(authActions, /return\s+\{[^}]*password/);
  assert.doesNotMatch(authActions, /redirect\([^)]*(?:email|password)/);
  assert.match(authActions, /logAuthFailure\("login", \{ code: result\.code \}\)/);
  assert.match(authActions, /localAuthRegister\(email, password, fullName\)/);
  assert.match(authActions, /localAuthLogout\(\)/);
  assert.doesNotMatch(authActions, /supabase\.auth\./);
  assert.match(loginForm, /<form action=\{formAction\}/);
  assert.doesNotMatch(loginForm, /<form[^>]+action=["']\/auth\/resolve/);
  assert.match(loginForm, /if \(state\.authenticated\) router\.replace\("\/auth\/resolve"\)/);
  assert.doesNotMatch(loginForm, /router\.replace\([^)]*(?:email|password)/);
  assert.match(proxy, /request\.cookies\.has\(LOCAL_AUTH_COOKIE\)/);
  assert.match(proxy, /resolveAuthRedirectOrigin\(request\.url, request\.headers\)/);
  assert.doesNotMatch(proxy, /supabase\.auth\.|createServerClient/);
});
