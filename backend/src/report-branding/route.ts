import type { FastifyInstance } from "fastify";

import { validRunnerBearerToken } from "../runner-heartbeat/auth.js";
import {
  REPORT_BRANDING_LOGO_REQUEST_MAX_BYTES,
  decodeReportLogoRequest,
  validateReportBrandingText,
} from "./contract.js";
import { ReportBrandingStorageError, type ReportBrandingStore } from "./storage.js";
import type { AuditedReportBranding } from "./audited-mutations.js";
import { ProfilePersistenceError } from "../persistence/profiles.js";

export type ReportBrandingRouteOptions = Readonly<{
  token: string;
  store: ReportBrandingStore;
  mutations?: AuditedReportBranding;
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

  server.put("/api/report-branding", { bodyLimit: 2_048 }, async (request, reply) => {
    if (!authorized(request.headers.authorization)) return unauthorized(reply);
    const body = mutationBody(request.body, true);
    const input = validateReportBrandingText(body?.input);
    if (!input) return invalid(reply, "INVALID_REPORT_BRANDING");
    try {
      if (!body || !options.mutations) return unavailable(reply);
      return reply.header("cache-control", "no-store").send(await options.mutations.text(body.actor_id, input, AbortSignal.timeout(8_000)));
    } catch (error) {
      if (error instanceof ProfilePersistenceError) return forbidden(reply, error.code);
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
    const body = mutationBody(request.body, true);
    const decoded = decodeReportLogoRequest(body?.input);
    if (!decoded) return invalid(reply, "INVALID_REPORT_LOGO");
    try {
      if (!body || !options.mutations) return unavailable(reply);
      return reply.header("cache-control", "no-store").send(await options.mutations.logo(body.actor_id, decoded, AbortSignal.timeout(8_000)));
    } catch (error) {
      if (error instanceof ReportBrandingStorageError) return invalid(reply, error.code);
      if (error instanceof ProfilePersistenceError) return forbidden(reply, error.code);
      return unavailable(reply);
    }
  });

  server.delete("/api/report-branding/logo", async (request, reply) => {
    if (!authorized(request.headers.authorization)) return unauthorized(reply);
    const body = mutationBody(request.body, false);
    if (!body) return invalid(reply, "INVALID_REPORT_BRANDING");
    try {
      if (!options.mutations) return unavailable(reply);
      return reply.header("cache-control", "no-store").send(await options.mutations.remove(body.actor_id, AbortSignal.timeout(8_000)));
    } catch (error) {
      if (error instanceof ProfilePersistenceError) return forbidden(reply, error.code);
      return unavailable(reply);
    }
  });
}

function mutationBody(value: unknown, withInput: boolean): { actor_id: string; input?: unknown } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const keys = withInput ? ["actor_id", "input"] : ["actor_id"];
  if (Object.keys(body).length !== keys.length || Object.keys(body).some((key) => !keys.includes(key)) ||
    typeof body.actor_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.actor_id)) return null;
  return withInput ? { actor_id: body.actor_id, input: body.input } : { actor_id: body.actor_id };
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
function forbidden(reply: Reply, code: string) {
  return reply.code(403).send({ error: { code, message: "Approved administrator required" } });
}
