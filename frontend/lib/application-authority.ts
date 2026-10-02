import "server-only";

export type ApplicationAuthority = "local_postgres";

export function getApplicationAuthority(): ApplicationAuthority {
  const value = process.env.PERSISTENCE_AUTHORITY?.trim();
  if (value !== "local_postgres") throw new Error("Application persistence authority must be local_postgres");
  return "local_postgres";
}
