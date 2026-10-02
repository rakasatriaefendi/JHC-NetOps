import "server-only";

import { cookies, headers } from "next/headers";

import { resolveAuthRedirectOrigin } from "./auth-redirect-origin";
import { localBackendConfig } from "./assets";
import { LOCAL_AUTH_COOKIE } from "./local-auth-cookie";

const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

type LocalAuthResult = Readonly<{
  ok: boolean;
  code: string;
  profile: Record<string, unknown> | null;
}>;

export async function localAuthLogin(email: string, password: string): Promise<LocalAuthResult> {
  const result = await request("/api/auth/login", { email, password });
  return establish(result);
}

export async function localAuthRegister(email: string, password: string, fullName: string): Promise<LocalAuthResult> {
  const result = await request("/api/auth/register", { email, password, full_name: fullName });
  return establish(result);
}

export async function localAuthenticatedProfile(): Promise<Record<string, unknown> | null> {
  const token = (await cookies()).get(LOCAL_AUTH_COOKIE)?.value;
  if (!token || !validToken(token)) return null;
  const result = await request("/api/auth/session", { session_token: token });
  return result.ok && record(result.data) && record(result.data.profile) ? result.data.profile : null;
}

export async function localAuthLogout(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(LOCAL_AUTH_COOKIE)?.value;
  if (token && validToken(token)) await request("/api/auth/logout", { session_token: token });
  cookieStore.delete(LOCAL_AUTH_COOKIE);
}

async function establish(result: BackendResult): Promise<LocalAuthResult> {
  if (!result.ok || !record(result.data)) {
    return { ok: false, code: result.code, profile: null };
  }
  const token = result.data.token;
  const expiresAtValue = result.data.expires_at;
  const profile = result.data.profile;
  if (!validToken(token) || typeof expiresAtValue !== "string" || !record(profile)) {
    return { ok: false, code: "AUTH_UNAVAILABLE", profile: null };
  }
  const expiresAt = Date.parse(expiresAtValue);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return { ok: false, code: "AUTH_UNAVAILABLE", profile: null };
  }
  const requestHeaders = await headers();
  const requestUrl = requestHeaders.get("origin") ?? requestHeaders.get("referer") ?? "http://localhost/login";
  const secure = new URL(resolveAuthRedirectOrigin(requestUrl, requestHeaders)).protocol === "https:";
  (await cookies()).set(LOCAL_AUTH_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: Math.min(SESSION_MAX_AGE_SECONDS, Math.max(1, Math.floor((expiresAt - Date.now()) / 1_000))),
  });
  return { ok: true, code: "OK", profile };
}

type BackendResult = Readonly<{ ok: boolean; code: string; data: unknown }>;

async function request(path: "/api/auth/login" | "/api/auth/register" | "/api/auth/session" | "/api/auth/logout",
  body: Record<string, string>): Promise<BackendResult> {
  const config = localBackendConfig();
  if (!config) return { ok: false, code: "AUTH_UNAVAILABLE", data: null };
  try {
    const response = await fetch(new URL(path, config.origin), {
      method: "POST",
      headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const payload: unknown = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) return { ok: false, code: safeCode(payload), data: null };
    if (response.status === 204) return { ok: true, code: "OK", data: null };
    return record(payload) ? { ok: true, code: "OK", data: payload.data ?? null } :
      { ok: false, code: "AUTH_UNAVAILABLE", data: null };
  } catch {
    return { ok: false, code: "AUTH_UNAVAILABLE", data: null };
  }
}

function safeCode(value: unknown): string {
  const code = record(value) && record(value.error) && typeof value.error.code === "string" ? value.error.code : "AUTH_UNAVAILABLE";
  return ["INVALID_AUTH_REQUEST", "INVALID_CREDENTIALS", "ACCOUNT_EXISTS", "ACCOUNT_ENROLLMENT_REQUIRED",
    "SESSION_INVALID", "ACCOUNT_DISABLED"].includes(code) ? code : "AUTH_UNAVAILABLE";
}

function validToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
