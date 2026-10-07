import { requireAdminProfile } from "@/lib/auth";
import { saveReportBranding } from "@/lib/report-branding";
import { boundedRequestBytes } from "@/lib/bounded-request";

export async function PUT(request: Request) {
  const { userId } = await requireAdminProfile();
  const length = Number(request.headers.get("content-length") ?? 0);
  if (!Number.isFinite(length) || length > 2048) return response("INVALID_REPORT_BRANDING", 400);
  const bytes = await boundedRequestBytes(request, 2048);
  if (!bytes) return response("INVALID_REPORT_BRANDING", 400);
  let input: unknown;
  try { input = JSON.parse(new TextDecoder().decode(bytes)); } catch { return response("INVALID_REPORT_BRANDING", 400); }
  const result = await saveReportBranding(userId, input);
  return result.error ? response(result.error, 400) : Response.json({ data: result.data, changed: result.changed }, { headers: { "cache-control": "no-store" } });
}

function response(code: string, status: number) {
  return Response.json({ error: { code, message: "Report branding could not be saved" } }, { status, headers: { "cache-control": "private, no-store" } });
}
