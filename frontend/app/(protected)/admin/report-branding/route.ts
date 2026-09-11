import { requireAdminProfile } from "@/lib/auth";
import { saveReportBranding } from "@/lib/report-branding";

export async function PUT(request: Request) {
  await requireAdminProfile();
  const length = Number(request.headers.get("content-length") ?? 0);
  if (!Number.isFinite(length) || length > 2048) return response("INVALID_REPORT_BRANDING", 400);
  const result = await saveReportBranding(await request.json().catch(() => null));
  return result.error ? response(result.error, 400) : Response.json({ data: result.data }, { headers: { "cache-control": "no-store" } });
}

function response(code: string, status: number) {
  return Response.json({ error: { code, message: "Report branding could not be saved" } }, { status });
}
