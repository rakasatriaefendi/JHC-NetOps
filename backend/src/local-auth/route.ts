import type { FastifyInstance } from "fastify";

import { validRunnerBearerToken } from "../runner-heartbeat/auth.js";
import { LocalAuthError, type PostgresLocalAuthRepository } from "./repository.js";

export type LocalAuthRouteOptions = Readonly<{ token: string; repository: PostgresLocalAuthRepository }>;

export function registerLocalAuthRoutes(server: FastifyInstance, options: LocalAuthRouteOptions): void {
  const authorized = (value: unknown) => validRunnerBearerToken(value, options.token);
  const unauthorized = { error: { code: "UNAUTHORIZED", message: "Frontend server authentication required" } };
  const invalid = { error: { code: "INVALID_AUTH_REQUEST", message: "Authentication request is invalid" } };

  server.post("/api/auth/register", async (request, reply) => {
    if (!authorized(request.headers.authorization)) return reply.code(401).send(unauthorized);
    const body = exactBody(request.body, ["email", "password", "full_name"]);
    if (!body || !strings(body, ["email", "password", "full_name"])) return reply.code(400).send(invalid);
    try {
      return reply.code(201).send({ data: await options.repository.register(
        body.email as string, body.password as string, body.full_name as string, AbortSignal.timeout(8_000),
      ) });
    } catch (error) { return authFailure(reply, error); }
  });

  server.post("/api/auth/login", async (request, reply) => {
    if (!authorized(request.headers.authorization)) return reply.code(401).send(unauthorized);
    const body = exactBody(request.body, ["email", "password"]);
    if (!body || !strings(body, ["email", "password"])) return reply.code(400).send(invalid);
    try {
      return reply.code(200).send({ data: await options.repository.login(
        body.email as string, body.password as string, AbortSignal.timeout(8_000),
      ) });
    } catch (error) { return authFailure(reply, error); }
  });

  server.post("/api/auth/session", async (request, reply) => {
    if (!authorized(request.headers.authorization)) return reply.code(401).send(unauthorized);
    const body = exactBody(request.body, ["session_token"]);
    if (!body || !strings(body, ["session_token"])) return reply.code(400).send(invalid);
    try {
      return reply.code(200).send({ data: { profile: await options.repository.resolve(
        body.session_token as string, AbortSignal.timeout(5_000),
      ) } });
    } catch (error) { return authFailure(reply, error); }
  });

  server.post("/api/auth/logout", async (request, reply) => {
    if (!authorized(request.headers.authorization)) return reply.code(401).send(unauthorized);
    const body = exactBody(request.body, ["session_token"]);
    if (!body || !strings(body, ["session_token"])) return reply.code(400).send(invalid);
    await options.repository.logout(body.session_token as string, AbortSignal.timeout(5_000));
    return reply.code(204).send();
  });
}

function authFailure(reply: import("fastify").FastifyReply, error: unknown) {
  if (!(error instanceof LocalAuthError)) {
    return reply.code(503).send({ error: { code: "AUTH_UNAVAILABLE", message: "Authentication is unavailable" } });
  }
  if (error.code === "INVALID_CREDENTIALS" || error.code === "SESSION_INVALID") {
    return reply.code(401).send({ error: { code: error.code, message: "Authentication failed" } });
  }
  if (error.code === "ACCOUNT_EXISTS" || error.code === "ACCOUNT_ENROLLMENT_REQUIRED") {
    return reply.code(409).send({ error: { code: error.code, message: "Account cannot be registered" } });
  }
  return reply.code(400).send({ error: { code: error.code, message: "Authentication request is invalid" } });
}

function exactBody(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  return Object.keys(body).length === keys.length && keys.every((key) => key in body) ? body : null;
}

function strings(body: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof body[key] === "string");
}
