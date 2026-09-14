export const POSTGRES_FOUNDATION = Object.freeze({
  database: "jhc_netops",
  role: "jhc_netops_app",
  port: 5433,
  dataDirectory: "/var/lib/postgresql/16/jhcnetops",
  serverAddresses: Object.freeze(["127.0.0.1", "::1"]),
});

export const POSTGRES_BASELINE_OBJECTS = Object.freeze([
  "asset.assets",
  "asset.scan_runs",
  "asset.change_events",
  "asset.scan_networks",
  "asset.scan_network_bootstrap",
  "asset.medical_equipment",
  "asset.medical_calibration_records",
  "asset.medical_service_records",
  "asset.medical_calibration_record_number_seq",
  "asset.medical_service_record_number_seq",
]);

const IDENTITY_QUERY = `
SELECT
  current_database()::text AS database_name,
  current_user::text AS role_name,
  inet_server_port()::integer AS server_port,
  COALESCE(inet_server_addr()::text, '') AS server_address,
  current_setting('data_directory') AS data_directory,
  current_setting('transaction_read_only') AS transaction_read_only
`.trim();

const BASELINE_QUERY = `
SELECT required.object_name, to_regclass(required.object_name)::text AS resolved_name
FROM unnest($1::text[]) AS required(object_name)
ORDER BY required.object_name
`.trim();

export type FoundationQuery = (
  sql: string,
  values?: readonly unknown[],
) => Promise<readonly Readonly<Record<string, unknown>>[]>;

export type PostgresFoundationResult = Readonly<{
  database: string;
  role: string;
  port: number;
  readOnly: true;
  baselineObjectCount: number;
}>;

export class PostgresFoundationError extends Error {
  readonly code = "POSTGRES_FOUNDATION_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "PostgresFoundationError";
  }
}

export async function verifyPostgresFoundation(query: FoundationQuery): Promise<PostgresFoundationResult> {
  const identityRows = await query(IDENTITY_QUERY);
  const identity = identityRows[0];
  if (!identity || identityRows.length !== 1) {
    throw new PostgresFoundationError("PostgreSQL identity response is invalid");
  }
  if (identity.database_name !== POSTGRES_FOUNDATION.database) {
    throw new PostgresFoundationError("PostgreSQL database identity does not match jhc_netops");
  }
  if (identity.role_name !== POSTGRES_FOUNDATION.role) {
    throw new PostgresFoundationError("PostgreSQL runtime role does not match jhc_netops_app");
  }
  if (identity.server_port !== POSTGRES_FOUNDATION.port) {
    throw new PostgresFoundationError("PostgreSQL server port does not match the dedicated port 5433");
  }
  if (typeof identity.server_address !== "string" ||
      !POSTGRES_FOUNDATION.serverAddresses.some((address) => address === identity.server_address)) {
    throw new PostgresFoundationError("PostgreSQL server is not bound to an allowed loopback address");
  }
  if (identity.data_directory !== POSTGRES_FOUNDATION.dataDirectory) {
    throw new PostgresFoundationError("PostgreSQL data directory does not match cluster 16/jhcnetops");
  }
  if (identity.transaction_read_only !== "on") {
    throw new PostgresFoundationError("PostgreSQL preflight session is not read-only");
  }

  const baselineRows = await query(BASELINE_QUERY, [POSTGRES_BASELINE_OBJECTS]);
  const resolved = new Map(baselineRows.map((row) => [row.object_name, row.resolved_name]));
  const missing = POSTGRES_BASELINE_OBJECTS.filter((name) => resolved.get(name) !== name);
  if (missing.length > 0) {
    throw new PostgresFoundationError(`PostgreSQL baseline is incomplete (${missing.length} object(s) missing)`);
  }

  return Object.freeze({
    database: POSTGRES_FOUNDATION.database,
    role: POSTGRES_FOUNDATION.role,
    port: POSTGRES_FOUNDATION.port,
    readOnly: true,
    baselineObjectCount: POSTGRES_BASELINE_OBJECTS.length,
  });
}
