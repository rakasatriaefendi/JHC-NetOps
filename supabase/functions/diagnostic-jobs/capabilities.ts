const PROFILE_REFERENCE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const CAPABILITY_KEYS = new Set([
  "enabled",
  "max_concurrent",
  "poll_intervals_seconds",
  "versions",
  "credential_profiles",
]);
const POLL_INTERVALS = new Set([30, 60]);
const SNMP_VERSIONS = new Set(["3", "2c"]);

export type SnmpTelemetryCapability =
  | { enabled: false }
  | {
    enabled: true;
    max_concurrent: number;
    poll_intervals_seconds: number[];
    versions: string[];
    credential_profiles: string[];
  };

export function validateSnmpTelemetryCapability(value: unknown):
  | { ok: true; value: SnmpTelemetryCapability | undefined }
  | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: undefined };
  if (!isRecord(value) || Object.keys(value).some((key) => !CAPABILITY_KEYS.has(key)) ||
      typeof value.enabled !== "boolean") return invalid();

  if (value.enabled === false) {
    return Object.keys(value).length === 1 ? { ok: true, value: { enabled: false } } : invalid();
  }
  const maxConcurrent = value.max_concurrent;
  if (typeof maxConcurrent !== "number" || !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 5 ||
      !boundedUniqueArray<number>(value.poll_intervals_seconds, 1, 2, (item) => Number.isSafeInteger(item) && POLL_INTERVALS.has(item as number)) ||
      !boundedUniqueArray<string>(value.versions, 1, 2, (item) => typeof item === "string" && SNMP_VERSIONS.has(item)) ||
      !boundedUniqueArray<string>(value.credential_profiles, 0, 50, (item) => typeof item === "string" && PROFILE_REFERENCE.test(item))) {
    return invalid();
  }
  return { ok: true, value: {
    enabled: true,
    max_concurrent: maxConcurrent,
    poll_intervals_seconds: [...value.poll_intervals_seconds],
    versions: [...value.versions],
    credential_profiles: [...value.credential_profiles],
  } };
}

function boundedUniqueArray<T>(value: unknown, minLength: number, maxLength: number, validItem: (item: unknown) => boolean): value is T[] {
  return Array.isArray(value) && value.length >= minLength && value.length <= maxLength &&
    value.every(validItem) && new Set(value).size === value.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalid(): { ok: false; error: string } {
  return { ok: false, error: "Runner SNMP telemetry capability is invalid" };
}
