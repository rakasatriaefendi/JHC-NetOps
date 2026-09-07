const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3402;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);

export type BackendConfig = Readonly<{
  host: string;
  port: number;
}>;

export class BackendConfigurationError extends Error {
  readonly code = "BACKEND_CONFIGURATION_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "BackendConfigurationError";
  }
}

export function loadBackendConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): BackendConfig {
  const host = environment.HOST?.trim() || DEFAULT_HOST;
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new BackendConfigurationError("HOST must be a loopback address");
  }

  const rawPort = environment.PORT?.trim();
  const port = rawPort ? parsePort(rawPort) : DEFAULT_PORT;
  return Object.freeze({ host, port });
}

function parsePort(value: string): number {
  if (!/^\d{1,5}$/.test(value)) {
    throw new BackendConfigurationError("PORT must be an integer between 1 and 65535");
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new BackendConfigurationError("PORT must be an integer between 1 and 65535");
  }
  return port;
}
