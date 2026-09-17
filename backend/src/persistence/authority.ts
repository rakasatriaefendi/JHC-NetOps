export const PERSISTENCE_AUTHORITIES = Object.freeze(["supabase", "local_postgres"] as const);

export type PersistenceAuthority = (typeof PERSISTENCE_AUTHORITIES)[number];

export class PersistenceAuthorityError extends Error {
  readonly code = "PERSISTENCE_AUTHORITY_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "PersistenceAuthorityError";
  }
}

export function parsePersistenceAuthority(value: string | undefined): PersistenceAuthority {
  const normalized = value?.trim();
  if (!PERSISTENCE_AUTHORITIES.includes(normalized as PersistenceAuthority)) {
    throw new PersistenceAuthorityError("PERSISTENCE_AUTHORITY must explicitly be supabase or local_postgres");
  }
  return normalized as PersistenceAuthority;
}

/**
 * Selects one complete application persistence implementation exactly once.
 * Factories are intentionally lazy: selecting local authority cannot construct,
 * call, or fall back to a Supabase application repository.
 */
export function selectApplicationPersistence<T>(
  authority: PersistenceAuthority,
  factories: Readonly<{
    supabase: () => T;
    localPostgres: () => T;
  }>,
): T {
  return authority === "supabase" ? factories.supabase() : factories.localPostgres();
}

export function assertPersistenceAuthority(
  configured: PersistenceAuthority,
  required: PersistenceAuthority,
): void {
  if (configured !== required) {
    throw new PersistenceAuthorityError(`Application persistence mutation requires ${required} authority`);
  }
}
