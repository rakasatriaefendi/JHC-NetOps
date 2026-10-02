import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { authDestination } from "../lib/auth-destination.ts";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("local auth remains server-only and keeps backend credentials out of browser code", () => {
  const helper = source("../lib/local-auth.ts");
  const cookie = source("../lib/local-auth-cookie.ts");
  assert.match(helper, /import "server-only"/);
  assert.match(helper, /localBackendConfig\(\)/);
  assert.match(helper, /authorization: `Bearer \$\{config\.token\}`/);
  assert.doesNotMatch(cookie, /LOCAL_BACKEND|TOKEN|127\.0\.0\.1/);
  assert.doesNotMatch(helper, /NEXT_PUBLIC_/);
});

test("runtime auth surfaces contain no Supabase Auth calls", () => {
  for (const path of [
    "../app/actions/auth.ts",
    "../app/auth/resolve/route.ts",
    "../app/auth/callback/route.ts",
    "../app/api/realtime/events/route.ts",
    "../lib/auth.ts",
    "../lib/auth-proxy.ts",
  ]) assert.doesNotMatch(source(path), /supabase\.auth\.|\.auth\.(?:getClaims|getUser|signInWithPassword|signUp|signOut|exchangeCodeForSession)/);
});

test("opaque session cookie is HttpOnly, same-site, bounded, and HTTPS-aware", () => {
  const helper = source("../lib/local-auth.ts");
  assert.match(helper, /httpOnly: true/);
  assert.match(helper, /sameSite: "lax"/);
  assert.match(helper, /secure,/);
  assert.match(helper, /path: "\/"/);
  assert.match(helper, /Math\.min\(SESSION_MAX_AGE_SECONDS/);
  assert.match(helper, /resolveAuthRedirectOrigin\(requestUrl, requestHeaders\)/);
});

test("credentials are sent only to loopback auth calls and never returned by actions", () => {
  const helper = source("../lib/local-auth.ts");
  const actions = source("../app/actions/auth.ts");
  assert.match(helper, /request\("\/api\/auth\/login", \{ email, password \}\)/);
  assert.match(helper, /request\("\/api\/auth\/register", \{ email, password, full_name: fullName \}\)/);
  assert.doesNotMatch(actions, /return\s+\{[^}]*(?:password|session_token|token)/);
  assert.doesNotMatch(actions, /supabase\.auth\./);
  assert.match(actions, /authenticated: true/);
});

test("protected routes and realtime use authoritative local session resolution", () => {
  const auth = source("../lib/auth.ts");
  const resolve = source("../app/auth/resolve/route.ts");
  const realtime = source("../app/api/realtime/events/route.ts");
  assert.match(auth, /normalizedProfile\(await localAuthenticatedProfile\(\)\)/);
  assert.match(resolve, /authDestination\(profile\.status\)/);
  assert.match(realtime, /profile\?\.status === "approved"/);
  for (const value of [auth, resolve, realtime]) assert.doesNotMatch(value, /supabase\.auth\./);
});

test("approved, pending, and rejected profiles retain their destinations while disabled returns to login", () => {
  assert.equal(authDestination("approved"), "/dashboard");
  assert.equal(authDestination("pending"), "/pending");
  assert.equal(authDestination("rejected"), "/pending");
  assert.equal(authDestination("disabled"), "/login");
});

test("registration and login retain GET navigation to auth resolve", () => {
  const login = source("../components/auth/login-form.tsx");
  const register = source("../components/auth/register-form.tsx");
  for (const form of [login, register]) {
    assert.match(form, /router\.replace\("\/auth\/resolve"\)/);
    assert.doesNotMatch(form, /action=["']\/auth\/resolve/);
  }
  const resolve = source("../app/auth/resolve/route.ts");
  assert.doesNotMatch(resolve, /export async function POST/);
});
