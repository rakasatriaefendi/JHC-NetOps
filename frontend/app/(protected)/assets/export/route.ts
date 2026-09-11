import type { NextRequest } from "next/server";

import { requireApprovedProfile } from "@/lib/auth";
import { loadAssetInventoryReport, type AssetInventoryQuery } from "@/lib/assets";

export async function GET(request: NextRequest) {
  await requireApprovedProfile();
  const params = request.nextUrl.searchParams;
  const language = params.get("lang") === "en" ? "en" : "id";
  const query = Object.fromEntries(
    ["q", "device_type", "vendor", "platform", "status", "sort"]
      .map((key) => [key, params.get(key)] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== null),
  ) as AssetInventoryQuery;
  const report = await loadAssetInventoryReport(query, language);
  if (!report.data) {
    return Response.json(
      { error: { code: "ASSET_REPORT_UNAVAILABLE", message: "Asset report is temporarily unavailable" } },
      { status: report.error === "unconfigured" ? 503 : 502 },
    );
  }
  return new Response(report.data.bytes, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-disposition": `attachment; filename="${report.data.filename}"`,
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
  });
}
