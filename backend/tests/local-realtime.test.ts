import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { LocalRealtimeBroker } from "../src/realtime/broker.js";
import {
  LOCAL_REALTIME_CHANNEL,
  LOCAL_REALTIME_MAX_NOTIFICATION_BYTES,
  LOCAL_REALTIME_TOPICS,
  createSyncInvalidation,
  parseLocalRealtimeNotification,
  type LocalRealtimeInvalidation,
} from "../src/realtime/contract.js";
import {
  PostgresRealtimeListener,
  type RealtimeListenConnection,
} from "../src/realtime/listener.js";
import { buildServer } from "../src/server.js";

const TOKEN = "f".repeat(32);
const EVENT: LocalRealtimeInvalidation = Object.freeze({
  version: 1,
  event_id: "11111111-1111-4111-8111-111111111111",
  topic: "network_health",
  aggregate_key: "22222222-2222-4222-8222-222222222222",
  occurred_at: "2026-09-23T08:00:00.000Z",
});

test("local realtime protocol accepts only bounded invalidation metadata", () => {
  assert.deepEqual(LOCAL_REALTIME_TOPICS, ["network_health", "diagnostics", "device_inspector", "traffic"]);
  assert.deepEqual(parseLocalRealtimeNotification(JSON.stringify(EVENT)), EVENT);
  assert.equal(parseLocalRealtimeNotification(JSON.stringify({ ...EVENT, topic: "diagnostics" }))?.topic, "diagnostics");
  assert.equal(parseLocalRealtimeNotification(JSON.stringify({ ...EVENT, topic: "device_inspector" }))?.topic, "device_inspector");
  assert.equal(parseLocalRealtimeNotification(JSON.stringify({ ...EVENT, topic: "traffic" }))?.topic, "traffic");
  assert.equal(parseLocalRealtimeNotification("not-json"), null);
  assert.equal(parseLocalRealtimeNotification(JSON.stringify({ ...EVENT, row: { status: "online" } })), null);
  assert.equal(parseLocalRealtimeNotification(JSON.stringify({ ...EVENT, topic: "arbitrary" })), null);
  assert.equal(parseLocalRealtimeNotification(JSON.stringify({ ...EVENT, aggregate_key: "x".repeat(129) })), null);
  assert.equal(parseLocalRealtimeNotification("x".repeat(LOCAL_REALTIME_MAX_NOTIFICATION_BYTES + 1)), null);
  assert.deepEqual(createSyncInvalidation(
    () => new Date("2026-09-23T08:01:00.000Z"),
    () => "33333333-3333-4333-8333-333333333333",
  ), {
    version: 1,
    event_id: "33333333-3333-4333-8333-333333333333",
    topic: "sync",
    aggregate_key: null,
    occurred_at: "2026-09-23T08:01:00.000Z",
  });
});

test("broker bounds subscribers and cleans up disconnects without a queue", () => {
  const broker = new LocalRealtimeBroker(1);
  const received: LocalRealtimeInvalidation[] = [];
  let closed = 0;
  const unsubscribe = broker.subscribe({ send: (event) => { received.push(event); return true; }, close: () => { closed += 1; } });
  assert.ok(unsubscribe);
  assert.equal(broker.subscriberCount, 1);
  assert.equal(broker.subscribe({ send: () => true, close: () => {} }), null);
  broker.publish(EVENT);
  assert.deepEqual(received, [EVENT]);
  unsubscribe();
  assert.equal(broker.subscriberCount, 0);

  broker.subscribe({ send: () => false, close: () => { closed += 1; } });
  broker.publish(EVENT);
  assert.equal(broker.subscriberCount, 0);
  assert.equal(closed, 1);
});

test("dedicated listener LISTENs, validates notifications, and reconnects safely", async () => {
  const broker = new LocalRealtimeBroker();
  const received: LocalRealtimeInvalidation[] = [];
  broker.subscribe({ send: (event) => { received.push(event); return true; }, close: () => {} });
  const first = new FakeListenConnection();
  const second = new FakeListenConnection();
  const connections = [first, second];
  const listener = new PostgresRealtimeListener(async () => {
    const connection = connections.shift();
    if (!connection) throw new Error("unavailable");
    return connection;
  }, broker, 1, 2);

  listener.start();
  await waitFor(() => first.listenChannel === LOCAL_REALTIME_CHANNEL);
  first.notify(LOCAL_REALTIME_CHANNEL, JSON.stringify(EVENT));
  first.notify(LOCAL_REALTIME_CHANNEL, JSON.stringify({ ...EVENT, payload: { secret: true } }));
  assert.deepEqual(received, [EVENT]);
  first.disconnect();
  await waitFor(() => second.listenChannel === LOCAL_REALTIME_CHANNEL);
  assert.equal(listener.isListening(), true);
  await listener.stop();
  assert.equal(listener.isListening(), false);
  assert.equal(first.closed, true);
  assert.equal(second.closed, true);
});

test("backend SSE requires bearer auth", async () => {
  const broker = new LocalRealtimeBroker();
  const server = buildServer({ logger: false, realtime: {
    token: TOKEN,
    broker,
  } });
  const unauthorized = await server.inject({ method: "GET", url: "/api/realtime/events" });
  assert.equal(unauthorized.statusCode, 401);
  await server.close();
});

test("backend SSE survives the finite API timeout and a 15-second heartbeat on one connection", { timeout: 25_000 }, async () => {
  const broker = new LocalRealtimeBroker();
  const server = buildServer({ logger: false, realtime: {
    token: TOKEN,
    broker,
    now: () => new Date("2026-09-23T08:01:00.000Z"),
    eventId: () => "33333333-3333-4333-8333-333333333333",
  } });
  const abort = new AbortController();
  await server.listen({ host: "127.0.0.1", port: 0 });
  const address = server.server.address();
  assert.ok(address && typeof address !== "string");
  assert.equal(server.server.timeout, 5_000, "ordinary API connection timeout must remain unchanged");

  try {
    const startedAt = Date.now();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/realtime/events`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: abort.signal,
    });
    assert.equal(response.status, 200);
    assert.ok(response.body);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let received = "";
    received = await readUntil(reader, decoder, received, (value) => value.includes('"topic":"sync"'));

    await new Promise((resolve) => setTimeout(resolve, 15_250));
    const secondEvent = Object.freeze({
      ...EVENT,
      event_id: "44444444-4444-4444-8444-444444444444",
      aggregate_key: "55555555-5555-4555-8555-555555555555",
    });
    broker.publish(EVENT);
    broker.publish(secondEvent);
    received = await readUntil(reader, decoder, received, (value) =>
      value.includes(": heartbeat ") &&
      value.includes(EVENT.event_id) &&
      value.includes(secondEvent.event_id));

    assert.ok(Date.now() - startedAt > 15_000, "stream must remain alive beyond the former cutoff and heartbeat interval");
    assert.equal(received.match(/"topic":"sync"/g)?.length, 1, "one connection must not receive repeated sync events");
    assert.equal(received.match(/"topic":"network_health"/g)?.length, 2);
    assert.equal(broker.subscriberCount, 1);

    abort.abort();
    await reader.cancel().catch(() => undefined);
    await waitFor(() => broker.subscriberCount === 0);
    assert.equal(server.server.timeout, 5_000, "SSE override must not alter the server-wide API timeout");
  } finally {
    abort.abort();
    broker.close();
    await server.close();
  }
});

test("migration 009 adds only bounded transactional Network Health notifications", () => {
  const migration = readFileSync(new URL("../migrations/009_local_realtime_invalidation.sql", import.meta.url), "utf8");
  assert.match(migration, /CREATE FUNCTION public\.publish_local_realtime_invalidation\(\) RETURNS trigger/);
  assert.match(migration, /PERFORM pg_notify\('jhc_netops_realtime_v1', notification_value\)/);
  assert.match(migration, /octet_length\(notification_value\) > 1024/);
  assert.match(migration, /TG_TABLE_NAME = 'events'[\s\S]+row_value->>'source' <> 'network_health'/);
  const tables = [...migration.matchAll(/CREATE TRIGGER local_realtime_[a-z_]+\s+AFTER INSERT OR UPDATE OR DELETE ON public\.([a-z_]+)/g)]
    .map((match) => match[1]);
  assert.deepEqual(tables, ["network_targets", "network_health_latest", "events"]);
  assert.match(migration, /INSERT INTO public\.application_schema_migrations\(version\) VALUES \(9\)/);
  assert.doesNotMatch(migration, /diagnostics|device_inspector|diagnostic_jobs|device_inspection_sessions/);
  assert.doesNotMatch(migration, /DROP (?:TABLE|FUNCTION|TRIGGER)|ALTER TABLE public\.realtime_outbox|asset\.[a-z_]+\s*(?:INSERT|UPDATE|DELETE)/i);
});

test("migration 010 adds only bounded Diagnostics and Device Inspector invalidations", () => {
  const migration = readFileSync(new URL("../migrations/010_diagnostics_device_inspector_realtime.sql", import.meta.url), "utf8");
  assert.match(migration, /NOT EXISTS \(SELECT 1 FROM public\.application_schema_migrations WHERE version = 9\)/);
  assert.match(migration, /CREATE FUNCTION public\.publish_local_realtime_control_invalidation\(\) RETURNS trigger/);
  assert.match(migration, /PERFORM pg_notify\('jhc_netops_realtime_v1', notification_value\)/);
  assert.match(migration, /octet_length\(notification_value\) > 1024/);
  assert.match(migration, /topic_value = 'diagnostics'[\s\S]+TG_TABLE_NAME = 'diagnostic_runners'[\s\S]+TG_ARGV\[1\] = 'id'/);
  assert.match(migration, /topic_value = 'diagnostics'[\s\S]+TG_TABLE_NAME = 'diagnostic_jobs'[\s\S]+TG_ARGV\[1\] = 'id'/);
  assert.match(migration, /topic_value = 'device_inspector'[\s\S]+TG_TABLE_NAME = 'device_inspection_sessions'[\s\S]+TG_ARGV\[1\] = 'runner_id'/);
  assert.match(migration, /TG_OP = 'DELETE'[\s\S]+OLD\.id::text[\s\S]+OLD\.runner_id::text/);
  assert.match(migration, /ELSE[\s\S]+NEW\.id::text[\s\S]+NEW\.runner_id::text/);

  const triggers = [...migration.matchAll(
    /CREATE TRIGGER local_realtime_[a-z_]+\s+AFTER INSERT OR UPDATE OR DELETE ON public\.([a-z_]+)/g,
  )].map((match) => match[1]);
  assert.deepEqual(triggers, ["diagnostic_runners", "diagnostic_jobs", "device_inspection_sessions"]);

  const notificationFields = migration.match(/notification_value := jsonb_build_object\(([\s\S]*?)\)::text;/)?.[1];
  assert.ok(notificationFields);
  for (const key of ["version", "event_id", "topic", "aggregate_key", "occurred_at"]) {
    assert.match(notificationFields, new RegExp(`'${key}'`));
  }
  assert.doesNotMatch(notificationFields, /row_value|payload|result|requested_by|target_ip/);
  assert.doesNotMatch(migration, /to_jsonb\((?:OLD|NEW)\)/);
  assert.match(migration, /INSERT INTO public\.application_schema_migrations\(version\) VALUES \(10\)/);
  assert.doesNotMatch(migration, /traffic_live|network_discovery|network_health_ping_jobs|managed_(?:device|interface|observed|telemetry)/);
  assert.doesNotMatch(migration, /DROP (?:TABLE|FUNCTION|TRIGGER)|CREATE OR REPLACE|ALTER TABLE public\.realtime_outbox|asset\.[a-z_]+\s*(?:INSERT|UPDATE|DELETE)/i);
});

test("migration 013 adds only bounded Traffic invalidations keyed by runner", () => {
  const migration = readFileSync(new URL("../migrations/013_traffic_realtime.sql", import.meta.url), "utf8");
  assert.match(migration, /NOT EXISTS \(SELECT 1 FROM public\.application_schema_migrations WHERE version = 12\)/);
  assert.match(migration, /CREATE FUNCTION public\.publish_local_realtime_traffic_invalidation\(\) RETURNS trigger/);
  assert.match(migration, /PERFORM pg_notify\('jhc_netops_realtime_v1', notification_value\)/);
  assert.match(migration, /octet_length\(notification_value\) > 1024/);
  assert.match(migration, /topic_value <> 'traffic'/);
  assert.match(migration, /TG_ARGV\[1\] <> 'runner_id'/);
  assert.match(migration, /OLD\.runner_id::text/);
  assert.match(migration, /NEW\.runner_id::text/);

  const triggers = [...migration.matchAll(
    /CREATE TRIGGER local_realtime_[a-z_]+\s+AFTER INSERT OR UPDATE OR DELETE ON public\.([a-z_]+)/g,
  )].map((match) => match[1]);
  assert.deepEqual(triggers, ["traffic_live_sessions", "traffic_live_snapshots"]);

  const notificationFields = migration.match(/notification_value := jsonb_build_object\(([\s\S]*?)\)::text;/)?.[1];
  assert.ok(notificationFields);
  for (const key of ["version", "event_id", "topic", "aggregate_key", "occurred_at"]) {
    assert.match(notificationFields, new RegExp(`'${key}'`));
  }
  assert.doesNotMatch(notificationFields, /payload|snapshot|summary|flows|top_talkers|session_id/);
  assert.match(migration, /INSERT INTO public\.application_schema_migrations\(version\) VALUES \(13\)/);
  assert.doesNotMatch(migration, /network_health|diagnostic_jobs|device_inspection|network_discovery|managed_(?:device|interface|observed|telemetry)/);
  assert.doesNotMatch(migration, /DROP (?:TABLE|FUNCTION|TRIGGER)|CREATE OR REPLACE|ALTER TABLE public\.realtime_outbox|asset\.[a-z_]+\s*(?:INSERT|UPDATE|DELETE)/i);
});

class FakeListenConnection implements RealtimeListenConnection {
  listenChannel: string | null = null;
  closed = false;
  private notificationHandlers: ((channel: string, payload: string | undefined) => void)[] = [];
  private errorHandlers: (() => void)[] = [];
  private endHandlers: (() => void)[] = [];

  async listen(channel: string): Promise<void> { this.listenChannel = channel; }
  onNotification(handler: (channel: string, payload: string | undefined) => void): void { this.notificationHandlers.push(handler); }
  onError(handler: () => void): void { this.errorHandlers.push(handler); }
  onEnd(handler: () => void): void { this.endHandlers.push(handler); }
  async close(): Promise<void> { this.closed = true; }
  notify(channel: string, payload: string): void { for (const handler of this.notificationHandlers) handler(channel, payload); }
  disconnect(): void { for (const handler of this.endHandlers) handler(); }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test state");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  initial: string,
  predicate: (value: string) => boolean,
): Promise<string> {
  let value = initial;
  while (!predicate(value)) {
    const result = await reader.read();
    if (result.done) throw new Error("Realtime stream ended before expected evidence arrived");
    value += decoder.decode(result.value, { stream: true });
  }
  return value;
}
