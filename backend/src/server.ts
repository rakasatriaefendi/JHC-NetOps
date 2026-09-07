import Fastify, { LogController, type FastifyInstance } from "fastify";

export const BACKEND_SERVICE_NAME = "jhc-netops-backend";
export const REQUEST_BODY_LIMIT_BYTES = 64 * 1024;

type BuildServerOptions = Readonly<{
  logger?: boolean;
}>;

export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const server = Fastify({
    bodyLimit: REQUEST_BODY_LIMIT_BYTES,
    connectionTimeout: 5_000,
    keepAliveTimeout: 5_000,
    requestTimeout: 10_000,
    routerOptions: { maxParamLength: 200 },
    logController: new LogController({ disableRequestLogging: true }),
    logger: options.logger === false ? false : {
      level: "info",
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "request.headers.authorization",
          "request.headers.cookie",
        ],
        censor: "[REDACTED]",
      },
    },
  });

  server.addHook("onResponse", async (request, reply) => {
    request.log.info({
      request_id: request.id,
      method: request.method,
      route: request.routeOptions.url ?? "unmatched",
      status_code: reply.statusCode,
    }, "request completed");
  });

  server.get("/healthz", async () => ({
    status: "ok",
    service: BACKEND_SERVICE_NAME,
  }));

  server.setNotFoundHandler((_request, reply) => reply.code(404).send({
    error: {
      code: "NOT_FOUND",
      message: "Route not found",
    },
  }));

  server.setErrorHandler((error, request, reply) => {
    const errorStatus = typeof error === "object" && error !== null && "statusCode" in error
      ? (error as { statusCode?: unknown }).statusCode
      : undefined;
    const payloadTooLarge = errorStatus === 413;
    const statusCode = payloadTooLarge ? 413 : 500;
    const code = payloadTooLarge ? "PAYLOAD_TOO_LARGE" : "INTERNAL_ERROR";
    request.log.error({
      request_id: request.id,
      status_code: statusCode,
      error_code: code,
    }, "request failed");
    return reply.code(statusCode).send({
      error: {
        code,
        message: payloadTooLarge ? "Request payload is too large" : "Internal server error",
      },
    });
  });

  return server;
}

export function createGracefulShutdown(server: FastifyInstance) {
  let closePromise: Promise<void> | undefined;
  return (signal: string): Promise<void> => {
    if (!closePromise) {
      server.log.info({ signal }, "graceful shutdown requested");
      closePromise = server.close();
    }
    return closePromise;
  };
}
