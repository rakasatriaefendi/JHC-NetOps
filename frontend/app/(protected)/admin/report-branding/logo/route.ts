import { requireAdminProfile } from "@/lib/auth";
import { loadReportLogo, removeReportLogo, saveReportLogo } from "@/lib/report-branding";
import { REPORT_BRANDING_LOGO_MAX_BYTES } from "@/lib/report-branding-contract";
import { boundedRequestBytes } from "@/lib/bounded-request";

const FORM_OVERHEAD_BYTES = 512 * 1024;

export async function GET() {
  await requireAdminProfile();
  const logo = await loadReportLogo();
  if (!logo) return error("REPORT_LOGO_NOT_FOUND", 404);
  return new Response(logo.bytes, { headers: { "content-type": logo.mimeType, "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  const { userId } = await requireAdminProfile();
  const length = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > REPORT_BRANDING_LOGO_MAX_BYTES + FORM_OVERHEAD_BYTES) return error("INVALID_REPORT_LOGO", 413);
  const bytes = await boundedRequestBytes(request, REPORT_BRANDING_LOGO_MAX_BYTES + FORM_OVERHEAD_BYTES);
  if (!bytes) return error("INVALID_REPORT_LOGO", 413);
  const form = await new Request(request.url, { method: "POST", headers: request.headers, body: bytes }).formData().catch(() => null);
  if (!form || form.getAll("logo").length !== 1 || [...form.keys()].some((key) => key !== "logo")) return error("INVALID_REPORT_LOGO", 400);
  const file = form.get("logo");
  if (!(file instanceof File) || !file.size || file.size > REPORT_BRANDING_LOGO_MAX_BYTES) return error("INVALID_REPORT_LOGO", 400);
  const result = await saveReportLogo(userId, file);
  return result.error ? error(result.error, 400) : Response.json({ data: result.data, changed: result.changed }, { headers: { "cache-control": "no-store" } });
}

export async function DELETE() {
  const { userId } = await requireAdminProfile();
  const result = await removeReportLogo(userId);
  return result.error ? error(result.error, 503) : Response.json({ data: result.data, changed: result.changed }, { headers: { "cache-control": "no-store" } });
}

function error(code: string, status: number) {
  return Response.json({ error: { code, message: "Report logo operation failed" } }, { status, headers: { "cache-control": "private, no-store" } });
}
