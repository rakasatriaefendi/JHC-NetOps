import {
  P12_ALLOWED_HOSTS,
  P12_DATABASE_PATTERN,
  P12_DATABASE_PREFIX,
  P12_FORBIDDEN_DATABASES,
  P12_POSTGRES_PORT,
  P12_RUN_ID_PATTERN,
} from "./contract.js";

export type P12Target = Readonly<{
  runId: string;
  database: string;
  host: string;
  port: 5433;
  connectionString: string;
}>;

export class P12TargetError extends Error {
  readonly code = "P12_TARGET_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "P12TargetError";
  }
}

export function p12DatabaseForRun(runId: string): string {
  if (!P12_RUN_ID_PATTERN.test(runId)) {
    throw new P12TargetError("P12 run ID is invalid");
  }
  const database = `${P12_DATABASE_PREFIX}${runId}`;
  if (!P12_DATABASE_PATTERN.test(database)) {
    throw new P12TargetError("P12 rehearsal database name is invalid");
  }
  return database;
}

export function parseP12Target(runId: string, connectionString: string): P12Target {
  const database = p12DatabaseForRun(runId);
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new P12TargetError("P12_REHEARSAL_DATABASE_URL is invalid");
  }
  const selectedDatabase = decodeURIComponent(url.pathname.slice(1));
  if (url.protocol !== "postgresql:" || !P12_ALLOWED_HOSTS.includes(url.hostname) ||
      url.port !== String(P12_POSTGRES_PORT) || selectedDatabase !== database ||
      P12_FORBIDDEN_DATABASES.includes(selectedDatabase) || !P12_DATABASE_PATTERN.test(selectedDatabase) ||
      !url.username || !url.password || url.search || url.hash) {
    throw new P12TargetError(
      "P12 target must use the exact rehearsal database on loopback port 5433",
    );
  }
  return Object.freeze({
    runId,
    database,
    host: url.hostname,
    port: P12_POSTGRES_PORT,
    connectionString,
  });
}

export function loadP12Target(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): P12Target {
  const runId = environment.P12_RUN_ID?.trim();
  const connectionString = environment.P12_REHEARSAL_DATABASE_URL?.trim();
  if (!runId || !connectionString) {
    throw new P12TargetError(
      "P12_RUN_ID and P12_REHEARSAL_DATABASE_URL are required; DATABASE_URL is never used as fallback",
    );
  }
  return parseP12Target(runId, connectionString);
}
