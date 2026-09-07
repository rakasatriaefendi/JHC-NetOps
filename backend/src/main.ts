import { BackendConfigurationError, loadBackendConfig } from "./config.js";
import { buildServer, createGracefulShutdown } from "./server.js";

async function main(): Promise<void> {
  const config = loadBackendConfig();
  const server = buildServer();
  const shutdown = createGracefulShutdown(server);
  const handleSignal = (signal: string) => {
    void shutdown(signal).catch(() => {
      process.stderr.write(`${JSON.stringify({
        level: "error",
        code: "BACKEND_SHUTDOWN_FAILED",
        message: "Backend failed to stop cleanly",
      })}\n`);
      process.exitCode = 1;
    });
  };

  process.once("SIGINT", () => handleSignal("SIGINT"));
  process.once("SIGTERM", () => handleSignal("SIGTERM"));

  try {
    await server.listen({ host: config.host, port: config.port });
  } catch (error) {
    await server.close().catch(() => undefined);
    throw error;
  }
}

try {
  await main();
} catch (error) {
  const configurationFailure = error instanceof BackendConfigurationError;
  process.stderr.write(`${JSON.stringify({
    level: "error",
    code: configurationFailure ? error.code : "BACKEND_STARTUP_FAILED",
    message: configurationFailure ? error.message : "Backend failed to start",
  })}\n`);
  process.exitCode = 1;
}
