import { randomUUID } from "node:crypto";

export const LOCAL_REALTIME_CHANNEL = "jhc_netops_realtime_v1";
export const LOCAL_REALTIME_MAX_NOTIFICATION_BYTES = 1_024;
export const LOCAL_REALTIME_TOPICS = Object.freeze([
  "network_health",
  "diagnostics",
  "device_inspector",
  "traffic",
  "managed_telemetry",
] as const);

export type LocalRealtimeTopic = typeof LOCAL_REALTIME_TOPICS[number] | "sync";

export type LocalRealtimeInvalidation = Readonly<{
  version: 1;
  event_id: string;
  topic: LocalRealtimeTopic;
  aggregate_key: string | null;
  occurred_at: string;
}>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AGGREGATE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

export function parseLocalRealtimeNotification(payload: unknown): LocalRealtimeInvalidation | null {
  if (typeof payload !== "string" || Buffer.byteLength(payload, "utf8") > LOCAL_REALTIME_MAX_NOTIFICATION_BYTES) {
    return null;
  }
  let value: unknown;
  try { value = JSON.parse(payload); } catch { return null; }
  if (!record(value) || !exactKeys(value, ["version", "event_id", "topic", "aggregate_key", "occurred_at"])) {
    return null;
  }
  if (value.version !== 1 || !UUID_PATTERN.test(String(value.event_id)) ||
      !(LOCAL_REALTIME_TOPICS as readonly unknown[]).includes(value.topic) ||
      typeof value.aggregate_key !== "string" || !AGGREGATE_KEY_PATTERN.test(value.aggregate_key) ||
      !validTimestamp(value.occurred_at)) return null;
  return Object.freeze({
    version: 1,
    event_id: String(value.event_id),
    topic: value.topic as typeof LOCAL_REALTIME_TOPICS[number],
    aggregate_key: value.aggregate_key,
    occurred_at: value.occurred_at,
  });
}

export function createSyncInvalidation(
  now: () => Date = () => new Date(),
  eventId: () => string = randomUUID,
): LocalRealtimeInvalidation {
  const id = eventId();
  if (!UUID_PATTERN.test(id)) throw new Error("Realtime sync event id is invalid");
  return Object.freeze({
    version: 1,
    event_id: id,
    topic: "sync",
    aggregate_key: null,
    occurred_at: now().toISOString(),
  });
}

export function serializeLocalRealtimeSse(event: LocalRealtimeInvalidation): string {
  return `id: ${event.event_id}\nevent: invalidation\ndata: ${JSON.stringify(event)}\n\n`;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length >= 20 && value.length <= 40 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) && Number.isFinite(Date.parse(value));
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => key in value);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
