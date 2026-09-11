import type { FastifyInstance } from "fastify";

import { validRunnerBearerToken } from "../runner-heartbeat/auth.js";
import {
  REPORT_BRANDING_LOGO_REQUEST_MAX_BYTES,
  decodeReportLogoRequest,
  validateReportBrandingText,
} from "./contract.js";
import { ReportBrandingStorageError, type ReportBrandingStore } from "./storage.js";

export type ReportBrandingRouteOptions = Readonly<{
  token: string;
  store: ReportBrandingStore;
}>;

export function registerReportBrandingRoutes(server: FastifyInstance, options: ReportBrandingRouteOptions): void {
  const authorized = (header: string | undefined) => validRunnerBearerToken(header, options.token);

  server.get("/api/report-branding", async (request, reply) => {
    if (!authorized(request.headers.authorization)) return unauthorized(reply);
    try {
      return reply.header("cache-control", "no-store").send({ data: await options.store.read() });
    } catch {
      return unavailable(reply);
    }
  });

  server.put("/api/report-branding", async (request, reply) => {
    if (!authorized(request.headers.authorization)) return unauthorized(reply);
    const input = validateReportBrandingText(request.body);
    if (!input) return invalid(reply, "INVALID_REPORT_BRANDING");
    try {
      return reply.header("cache-control", "no-store").send({ data: await options.store.saveText(input) });
    } catch {
      return unavailable(reply);
    }
  });

  server.get("/api/report-branding/logo", async (request, reply) => {
    if (!authorized(request.headers.authorization)) return unauthorized(reply);
    try {
      const logo = (await options.store.readSnapshot()).logo;
      if (!logo) return reply.code(404).send({ error: { code: "REPORT_LOGO_NOT_FOUND", message: "Report logo is not configured" } });
      return reply.header("content-type", logo.mimeType).header("cache-control", "no-store").send(logo.bytes);
    } catch {
      return unavailable(reply);
    }
  });

  server.put("/api/report-branding/logo", { bodyLimit: REPORT_BRANDING_LOGO_REQUEST_MAX_BYTES }, async (request, reply) => {
    if (!authorized(request.headers.authorization)) return unauthorized(reply);
    const decoded = decodeReportLogoRequest(request.body);
    if (!decoded) return invalid(reply, "INVALID_REPORT_LOGO");
    try {
      return reply.header("cache-control", "no-store").send({ data: await options.store.saveLogo(decoded) });
    } catch (error) {
      if (error instanceof ReportBrandingStorageError) return invalid(reply, error.code);
      return unavailable(reply);
    }
  });

  server.delete("/api/report-branding/logo", async (request, reply) => {
    if (!authorized(request.headers.authorization)) return unauthorized(reply);
    try {
      return reply.header("cache-control", "no-store").send({ data: await options.store.removeLogo() });
    } catch {
      return unavailable(reply);
    }
  });
}

type Reply = Parameters<typeof unauthorized>[0];
function unauthorized(reply: { code(status: number): { send(body: unknown): unknown } }) {
  return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Frontend server authentication required" } });
}
function invalid(reply: Reply, code: string) {
  return reply.code(400).send({ error: { code, message: "Report branding input is invalid" } });
}
function unavailable(reply: Reply) {
  return reply.code(503).send({ error: { code: "REPORT_BRANDING_UNAVAILABLE", message: "Report branding is temporarily unavailable" } });
}
