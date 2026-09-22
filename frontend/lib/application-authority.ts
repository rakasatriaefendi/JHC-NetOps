export type ApplicationAuthority = "supabase" | "local_postgres";

export function applicationAuthority(environment: Readonly<Record<string, string | undefined>> = process.env): ApplicationAuthority {
  const value = environment.PERSISTENCE_AUTHORITY?.trim();
  if (value !== "supabase" && value !== "local_postgres") {
    throw new Error("Application persistence authority is missing or invalid");
  }
  return value;
}