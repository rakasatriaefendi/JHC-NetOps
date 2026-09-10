import Fastify, { LogController, type FastifyInstance } from "fastify";
import { registerAssetRoutes, type AssetRouteOptions } from "./assets/route.js";
import { registerAssetChangeRoutes, type AssetChangeRouteOptions } from "./assets/change-route.js";
import { registerAssetScanRoutes, type AssetScanRouteOptions } from "./assets/scan-route.js";
import { registerScanNetworkRoutes, type ScanNetworkRouteOptions } from "./assets/scan-network-route.js";
import { registerManagedTelemetryRoute, type ManagedTelemetryRouteOptions } from "./managed-telemetry/route.js";
import { registerNetworkHealthRoute, type NetworkHealthRouteOptions } from "./network-health/route.js";
import { registerRunnerHeartbeatRoute, type RunnerHeartbeatRouteOptions } from "./runner-heartbeat/route.js";
import { registerTrafficRoute, type TrafficRouteOptions } from "./traffic/route.js";

export const BACKEND_SERVICE_NAME = "jhc-netops-backend";
export const REQUEST_BODY_LIMIT_BYTES = 64 * 1024;

type BuildServerOptions = Readonly<{
  assets?: AssetRouteOptions;
  assetChanges?: AssetChangeRouteOptions;
  assetScan?: AssetScanRouteOptions;
  scanNetworks?: ScanNetworkRouteOptions;
  logger?: boolean;
  managedTelemetry?: ManagedTelemetryRouteOptions;
  networkHealth?: NetworkHealthRouteOptions;
  runnerHeartbeat?: RunnerHeartbeatRouteOptions;
  traffic?: TrafficRouteOptions;
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

  if (options.runnerHeartbeat) {
    registerRunnerHeartbeatRoute(server, options.runnerHeartbeat);
  }
  if (options.networkHealth) registerNetworkHealthRoute(server, options.networkHealth);
  if (options.traffic) registerTrafficRoute(server, options.traffic);
  if (options.managedTelemetry) registerManagedTelemetryRoute(server, options.managedTelemetry);
  if (options.assets) registerAssetRoutes(server, options.assets);
  if (options.assetChanges) registerAssetChangeRoutes(server, options.assetChanges);
  if (options.assetScan) registerAssetScanRoutes(server, options.assetScan);
  if (options.scanNetworks) registerScanNetworkRoutes(server, options.scanNetworks);

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
