import { resolve } from "node:path";

import { ASSET_SCAN_MAX_CONCURRENCY, parseAllowedScanNetworks } from "./assets/scan-contract.js";
import { parsePersistenceAuthority, type PersistenceAuthority } from "./persistence/authority.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3402;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);

export type BackendConfig = Readonly<{
  host: string;
  port: number;
  runnerApiToken: string;
  frontendApiToken: string;
  persistenceAuthority: PersistenceAuthority;
  candidateReadOnly: boolean;
  supabaseUrl: string | null;
  supabaseServiceRoleKey: string | null;
  applicationDatabaseUrl: string;
  assets: Readonly<{
    databaseUrl: string;
    frontendApiToken: string;
    reportBrandingDir: string;
    medicalDueSoonDays: number;
    scan: Readonly<{
      networks: readonly string[];
      helperPath: string;
      concurrency: number;
      hostTimeoutMs: number;
      discoveryTimeoutMs: number;
    }>;
  }> | null;
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
  const frontendApiToken = requiredSecret(environment.FRONTEND_API_TOKEN, "FRONTEND_API_TOKEN", 32, 512);
  const persistenceAuthority = parsePersistenceAuthority(environment.PERSISTENCE_AUTHORITY);
  const candidateReadOnly = parseCandidateReadOnly(environment.P13_CANDIDATE_READ_ONLY);
  if (candidateReadOnly && persistenceAuthority === "local_postgres") {
    throw new BackendConfigurationError(
      "P13_CANDIDATE_READ_ONLY cannot be enabled with local_postgres authority",
    );
  }
  const hasSupabaseConfiguration = Boolean(environment.SUPABASE_URL?.trim() || environment.SUPABASE_SERVICE_ROLE_KEY);
  const needsSupabaseApplicationCompatibility = persistenceAuthority === "supabase";
  const supabaseUrl = hasSupabaseConfiguration || needsSupabaseApplicationCompatibility
    ? parseSupabaseUrl(environment.SUPABASE_URL)
    : null;
  const supabaseServiceRoleKey = hasSupabaseConfiguration || needsSupabaseApplicationCompatibility
    ? requiredSecret(environment.SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY", 32, 4096)
    : null;
  const applicationDatabaseUrl = parseDedicatedPostgresUrl(environment.APPLICATION_DATABASE_URL?.trim() ?? "");
  const databaseUrl = environment.DATABASE_URL?.trim();
  const assetsFrontendApiToken = environment.FRONTEND_API_TOKEN?.trim();
  if (Boolean(databaseUrl) !== Boolean(assetsFrontendApiToken)) {
    throw new BackendConfigurationError("DATABASE_URL and FRONTEND_API_TOKEN must be configured together");
  }
  const assets = databaseUrl && assetsFrontendApiToken
    ? Object.freeze({
      databaseUrl: parseDedicatedPostgresUrl(databaseUrl),
      frontendApiToken: requiredSecret(assetsFrontendApiToken, "FRONTEND_API_TOKEN", 32, 512),
      reportBrandingDir: parseReportBrandingDir(environment.REPORT_BRANDING_DIR),
      medicalDueSoonDays: boundedInteger(environment.MEDICAL_DUE_SOON_DAYS, 30, 1, 180, "MEDICAL_DUE_SOON_DAYS"),
      scan: parseAssetScanConfig(environment),
    })
    : null;
  return Object.freeze({ host, port, runnerApiToken, frontendApiToken, persistenceAuthority, candidateReadOnly,
    supabaseUrl, supabaseServiceRoleKey, applicationDatabaseUrl, assets });
}

export function requireSupabaseRuntimeConfig(config: BackendConfig): Readonly<{
  url: string;
  serviceRoleKey: string;
}> {
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
    throw new BackendConfigurationError(
      "Supabase compatibility/projector configuration is missing or invalid",
    );
  }
  return Object.freeze({ url: config.supabaseUrl, serviceRoleKey: config.supabaseServiceRoleKey });
}

function parseCandidateReadOnly(value: string | undefined): boolean {
  const configured = value?.trim();
  if (!configured || configured === "false") return false;
  if (configured === "true") return true;
  throw new BackendConfigurationError("P13_CANDIDATE_READ_ONLY must be true or false");
}

function parseReportBrandingDir(value: string | undefined): string {
  const configured = value?.trim();
  if (configured && (configured.length > 1024 || /[\u0000-\u001f\u007f]/.test(configured))) {
    throw new BackendConfigurationError("REPORT_BRANDING_DIR is invalid");
  }
  return resolve(configured || "data/report-branding");
}

function parseAssetScanConfig(environment: Readonly<Record<string, string | undefined>>) {
  let networks: readonly string[];
  try {
    networks = parseAllowedScanNetworks(environment.ASSET_SCAN_NETWORKS);
  } catch {
    throw new BackendConfigurationError("ASSET_SCAN_NETWORKS must contain bounded canonical RFC1918 IPv4 CIDRs");
  }
  const helperPath = environment.ASSET_SCAN_HELPER_PATH?.trim() || "/usr/local/libexec/jhc-netops-asset-scan";
  if (!/^\/[A-Za-z0-9._/-]{1,255}$/.test(helperPath) || helperPath.includes("//") || helperPath.includes("/../")) {
    throw new BackendConfigurationError("ASSET_SCAN_HELPER_PATH must be a bounded absolute path");
  }
  return Object.freeze({
    networks,
    helperPath,
    concurrency: boundedInteger(environment.ASSET_SCAN_CONCURRENCY, 4, 1, ASSET_SCAN_MAX_CONCURRENCY, "ASSET_SCAN_CONCURRENCY"),
    hostTimeoutMs: boundedInteger(environment.ASSET_SCAN_HOST_TIMEOUT_MS, 45_000, 5_000, 120_000, "ASSET_SCAN_HOST_TIMEOUT_MS"),
    discoveryTimeoutMs: boundedInteger(environment.ASSET_SCAN_DISCOVERY_TIMEOUT_MS, 120_000, 10_000, 300_000, "ASSET_SCAN_DISCOVERY_TIMEOUT_MS"),
  });
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  if (!value?.trim()) return fallback;
  if (!/^\d+$/.test(value)) throw new BackendConfigurationError(`${name} must be a bounded integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new BackendConfigurationError(`${name} must be a bounded integer`);
  }
  return parsed;
}

export function parseDedicatedPostgresUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "postgresql:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
        url.port !== "5433" || url.pathname !== "/jhc_netops" || url.username !== "jhc_netops_app" ||
        !url.password || url.hash || url.search) {
      throw new Error("invalid");
    }
    return value;
  } catch {
    throw new BackendConfigurationError(
      "DATABASE_URL must target the dedicated loopback jhc_netops cluster on port 5433 as jhc_netops_app",
    );
  }
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
