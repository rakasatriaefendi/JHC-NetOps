export const PERSISTENCE_AUTHORITIES = Object.freeze(["local_postgres"] as const);

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
    throw new PersistenceAuthorityError("PERSISTENCE_AUTHORITY must explicitly be local_postgres");
  }
  return normalized as PersistenceAuthority;
}

/**
 * Constructs the single supported local PostgreSQL persistence implementation.
 */
export function selectApplicationPersistence<T>(
  authority: PersistenceAuthority,
  factory: () => T,
): T {
  if (authority !== "local_postgres") throw new PersistenceAuthorityError("Unsupported persistence authority");
  return factory();
}

export function assertPersistenceAuthority(
  configured: PersistenceAuthority,
  required: PersistenceAuthority,
): void {
  if (configured !== required) {
    throw new PersistenceAuthorityError(`Application persistence mutation requires ${required} authority`);
  }
}
