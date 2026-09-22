import "server-only";

export type ApplicationAuthority = "supabase" | "local_postgres";

export function getApplicationAuthority(): ApplicationAuthority {
  const value = process.env.PERSISTENCE_AUTHORITY?.trim();
  if (value !== "supabase" && value !== "local_postgres") {
    throw new Error("Application persistence authority is missing or invalid");
  }
  return value;
}