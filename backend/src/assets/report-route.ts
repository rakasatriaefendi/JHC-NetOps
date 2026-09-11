import type { FastifyInstance } from "fastify";

import { validRunnerBearerToken } from "../runner-heartbeat/auth.js";
import type { AssetSynchronizer } from "./ingestion.js";
import {
  ASSET_REPORT_MAX_ASSETS,
  ASSET_REPORT_MAX_BYTES,
  ASSET_REPORT_MAX_HISTORY_EVENTS,
  validateAssetReportQuery,
} from "./report-contract.js";
import type { AssetReportRepository } from "./report-repository.js";
import { buildAssetWorkbook } from "./report-workbook.js";
import type { ReportBrandingStore } from "../report-branding/storage.js";
import { DEFAULT_REPORT_BRANDING, type ReportBrandingSnapshot } from "../report-branding/contract.js";

export const ASSET_REPORT_TIMEOUT_MS = 12_000;
export const ASSET_REPORT_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export type AssetReportRouteOptions = Readonly<{
  token: string;
  repository: AssetReportRepository;
  synchronizer?: AssetSynchronizer;
  timeoutMs?: number;
  now?: () => Date;
  branding?: ReportBrandingStore;
}>;

export function registerAssetReportRoute(server: FastifyInstance, options: AssetReportRouteOptions): void {
  server.get("/api/assets/export.xlsx", async (request, reply) => {
    if (!validRunnerBearerToken(request.headers.authorization, options.token)) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Frontend server authentication required" } });
    }
    const validated = validateAssetReportQuery(request.query);
    if (!validated.ok) {
      return reply.code(400).send({ error: { code: "INVALID_ASSET_REPORT_QUERY", message: validated.message } });
    }
    try {
      if (options.synchronizer) {
        try {
          await options.synchronizer.synchronize();
        } catch {
          request.log.warn({ request_id: request.id, error_code: "ASSET_EVIDENCE_SYNC_FAILED" }, "asset evidence sync failed; exporting retained inventory");
        }
      }
      const signal = AbortSignal.timeout(options.timeoutMs ?? ASSET_REPORT_TIMEOUT_MS);
      const data = await options.repository.load(
        validated.value.inventory,
        ASSET_REPORT_MAX_ASSETS,
        ASSET_REPORT_MAX_HISTORY_EVENTS,
        signal,
      );
      signal.throwIfAborted();
      let branding: ReportBrandingSnapshot = { branding: DEFAULT_REPORT_BRANDING, logo: null };
      if (options.branding) {
        try {
          branding = await options.branding.readSnapshot();
        } catch {
          request.log.warn({ request_id: request.id, error_code: "REPORT_BRANDING_READ_FAILED" }, "report branding unavailable; using safe default");
        }
      }
      const report = await buildAssetWorkbook(data, validated.value, (options.now ?? (() => new Date()))(), branding);
      if (report.buffer.byteLength > ASSET_REPORT_MAX_BYTES) throw new Error("Asset report exceeds the bounded response size");
      return reply
        .header("content-type", ASSET_REPORT_MIME)
        .header("content-disposition", `attachment; filename="${report.filename}"`)
        .header("cache-control", "no-store")
        .header("content-length", String(report.buffer.byteLength))
        .code(200)
        .send(report.buffer);
    } catch {
      request.log.error({ request_id: request.id, error_code: "ASSET_REPORT_FAILED" }, "asset report generation failed");
      return reply.code(503).send({ error: { code: "ASSET_REPORT_FAILED", message: "Asset report is temporarily unavailable" } });
    }
  });
}
