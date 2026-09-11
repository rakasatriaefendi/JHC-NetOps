import "server-only";

import { localBackendConfig } from "@/lib/assets";
import {
  DEFAULT_REPORT_BRANDING,
  REPORT_BRANDING_LOGO_MAX_BYTES,
  type ReportBranding,
  validReportBranding,
} from "@/lib/report-branding-contract";

export type ReportBrandingResult = Readonly<{ data: ReportBranding; error: string | null }>;

export async function loadReportBranding(): Promise<ReportBrandingResult> {
  const result = await request("GET", "/api/report-branding");
  return result.ok && validEnvelope(result.payload)
    ? { data: result.payload.data, error: null }
    : { data: DEFAULT_REPORT_BRANDING, error: result.error ?? "REPORT_BRANDING_UNAVAILABLE" };
}

export async function saveReportBranding(value: unknown): Promise<ReportBrandingResult> {
  const result = await request("PUT", "/api/report-branding", value);
  return result.ok && validEnvelope(result.payload)
    ? { data: result.payload.data, error: null }
    : { data: DEFAULT_REPORT_BRANDING, error: result.error ?? "INVALID_REPORT_BRANDING" };
}

export async function saveReportLogo(file: File): Promise<ReportBrandingResult> {
  if (!file.size || file.size > REPORT_BRANDING_LOGO_MAX_BYTES) return { data: DEFAULT_REPORT_BRANDING, error: "INVALID_REPORT_LOGO" };
  const bytes = Buffer.from(await file.arrayBuffer());
  const result = await request("PUT", "/api/report-branding/logo", {
    filename: file.name,
    mime_type: file.type,
    base64: bytes.toString("base64"),
  });
  return result.ok && validEnvelope(result.payload)
    ? { data: result.payload.data, error: null }
    : { data: DEFAULT_REPORT_BRANDING, error: result.error ?? "INVALID_REPORT_LOGO" };
}

export async function removeReportLogo(): Promise<ReportBrandingResult> {
  const result = await request("DELETE", "/api/report-branding/logo");
  return result.ok && validEnvelope(result.payload)
    ? { data: result.payload.data, error: null }
    : { data: DEFAULT_REPORT_BRANDING, error: result.error ?? "REPORT_BRANDING_UNAVAILABLE" };
}

export async function loadReportLogo(): Promise<{ bytes: ArrayBuffer; mimeType: "image/png" | "image/jpeg" } | null> {
  const config = localBackendConfig();
  if (!config) return null;
  try {
    const response = await fetch(new URL("/api/report-branding/logo", config.origin), {
      headers: { authorization: `Bearer ${config.token}` }, cache: "no-store", signal: AbortSignal.timeout(8_000),
    });
    const mimeType = response.headers.get("content-type")?.split(";")[0];
    if (!response.ok || (mimeType !== "image/png" && mimeType !== "image/jpeg")) return null;
    const bytes = await response.arrayBuffer();
    return bytes.byteLength > 0 && bytes.byteLength <= REPORT_BRANDING_LOGO_MAX_BYTES ? { bytes, mimeType } : null;
  } catch { return null; }
}

async function request(method: "GET" | "PUT" | "DELETE", path: string, body?: unknown) {
  const config = localBackendConfig();
  if (!config) return { ok: false, payload: null as unknown, error: "REPORT_BRANDING_UNCONFIGURED" };
  try {
    const response = await fetch(new URL(path, config.origin), {
      method,
      headers: { authorization: `Bearer ${config.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
    const payload: unknown = await response.json().catch(() => null);
    return { ok: response.ok, payload, error: safeErrorCode(payload) };
  } catch { return { ok: false, payload: null as unknown, error: "REPORT_BRANDING_UNAVAILABLE" }; }
}

function validEnvelope(value: unknown): value is { data: ReportBranding } {
  return record(value) && validReportBranding(value.data);
}
function safeErrorCode(value: unknown): string | null {
  return record(value) && record(value.error) && typeof value.error.code === "string" && /^[A-Z0-9_]{1,80}$/.test(value.error.code) ? value.error.code : null;
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
