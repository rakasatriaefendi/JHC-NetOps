const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3402;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);

export type BackendConfig = Readonly<{
  host: string;
  port: number;
  runnerApiToken: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
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
  const runnerApiToken = requiredSecret(environment.RUNNER_API_TOKEN, "RUNNER_API_TOKEN", 32, 512);
  const supabaseUrl = parseSupabaseUrl(environment.SUPABASE_URL);
  const supabaseServiceRoleKey = requiredSecret(
    environment.SUPABASE_SERVICE_ROLE_KEY,
    "SUPABASE_SERVICE_ROLE_KEY",
    32,
    4096,
  );
  return Object.freeze({ host, port, runnerApiToken, supabaseUrl, supabaseServiceRoleKey });
}

function requiredSecret(value: string | undefined, name: string, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || /\s/.test(value) ||
      /^(?:replace_|change_me)/i.test(value)) {
    throw new BackendConfigurationError(`${name} is missing or invalid`);
  }
  return value;
}

function parseSupabaseUrl(value: string | undefined): string {
  if (typeof value !== "string" || value.length > 2048) {
    throw new BackendConfigurationError("SUPABASE_URL is missing or invalid");
  }
  try {
    const url = new URL(value);
    const loopbackHttp = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !loopbackHttp) || url.username || url.password ||
        url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
      throw new Error("invalid");
    }
    return url.origin;
  } catch {
    throw new BackendConfigurationError("SUPABASE_URL is missing or invalid");
  }
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
