import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  normalizeObservedHosts,
  observedHostNotInFilter,
  persistObservedHostRows,
  prepareObservedHostRows,
} from "./observed-hosts.ts";

const TARGET = "11111111-1111-4111-8111-111111111111";

function host(overrides: Record<string, unknown> = {}) {
  return { target_id: TARGET, ip_address: "192.168.10.25", mac_address: "00:11:22:33:44:55",
    netbios_name: "HOST-25", observation_source: "ip_net_to_physical", enrichment_status: "resolved", ...overrides };
}

test("observed hosts validate, coalesce, and preserve SNMP MAC", () => {
  const rows = normalizeObservedHosts([
    host({ mac_address: null, netbios_name: null, enrichment_status: "unavailable" }),
    host(),
  ], TARGET);
  assert.equal(rows?.length, 1);
  assert.equal(rows?.[0].mac_address, "00:11:22:33:44:55");
  assert.equal(rows?.[0].netbios_name, "HOST-25");
});

test("zero MAC, public IP, arbitrary fields, and secret-shaped fields are rejected", () => {
  assert.equal(normalizeObservedHosts([host({ mac_address: "00:00:00:00:00:00" })], TARGET), null);
  assert.equal(normalizeObservedHosts([host({ ip_address: "8.8.8.8" })], TARGET), null);
  assert.equal(normalizeObservedHosts([host({ subnet: "192.168.10.0/24" })], TARGET), null);
  assert.equal(normalizeObservedHosts([host({ community: "secret" })], TARGET), null);
});

test("inventory correlation reuses exact node and first-seen timestamps", () => {
  const normalized = normalizeObservedHosts([host()], TARGET) ?? [];
  const rows = prepareObservedHostRows(
    normalized, TARGET, "2026-08-31T10:00:00.000Z",
    [{ ip_address: "192.168.10.25", first_seen_at: "2026-08-30T10:00:00.000Z", netbios_name: null, enrichment_status: "not_attempted" },
      { ip_address: "192.168.10.26", first_seen_at: "2026-08-30T10:00:00.000Z", netbios_name: null, enrichment_status: "not_attempted" }],
    [{ id: "22222222-2222-4222-8222-222222222222", ip_address: "192.168.10.25" }],
  );
  assert.equal(rows.current[0].node_id, "22222222-2222-4222-8222-222222222222");
  assert.equal(rows.current[0].first_seen_at, "2026-08-30T10:00:00.000Z");
  assert.deepEqual(rows.stale, [{ target_id: TARGET, ip_address: "192.168.10.26", status: "stale", updated_at: "2026-08-31T10:00:00.000Z" }]);
});

test("a previously resolved name survives later unavailable or unattempted enrichment", () => {
  for (const enrichment_status of ["unavailable", "not_attempted"] as const) {
    const normalized = normalizeObservedHosts([host({ netbios_name: null, enrichment_status })], TARGET) ?? [];
    const rows = prepareObservedHostRows(
      normalized, TARGET, "2026-08-31T10:00:00.000Z",
      [{ ip_address: "192.168.10.25", first_seen_at: "2026-08-30T10:00:00.000Z", netbios_name: "KNOWN-HOST", enrichment_status: "resolved" }],
      [],
    );
    assert.equal(rows.current[0].netbios_name, "KNOWN-HOST");
    assert.equal(rows.current[0].enrichment_status, "resolved");
  }
});

test("a new trustworthy resolved name may replace the previous resolved name without changing SNMP MAC", () => {
  const normalized = normalizeObservedHosts([host({ netbios_name: "NEW-HOST", enrichment_status: "resolved" })], TARGET) ?? [];
  const rows = prepareObservedHostRows(
    normalized, TARGET, "2026-08-31T10:00:00.000Z",
    [{ ip_address: "192.168.10.25", first_seen_at: "2026-08-30T10:00:00.000Z", netbios_name: "OLD-HOST", enrichment_status: "resolved" }],
    [],
  );
  assert.equal(rows.current[0].netbios_name, "NEW-HOST");
  assert.equal(rows.current[0].mac_address, "00:11:22:33:44:55");
});

test("observed host payload accepts more than 128 rows up to the 256 bound", () => {
  const rows = Array.from({ length: 196 }, (_, index) =>
    host({
      ip_address: `10.0.0.${index + 1}`,
      netbios_name: null,
      enrichment_status: "not_attempted",
    })
  );

  const normalized = normalizeObservedHosts(rows, TARGET);
  assert.equal(normalized?.length, 196);
});

test("observed host payload rejects more than 256 rows", () => {
  const rows = Array.from({ length: 257 }, (_, index) =>
    host({
      ip_address: `10.${Math.floor(index / 254)}.0.${(index % 254) + 1}`,
      netbios_name: null,
      enrichment_status: "not_attempted",
    })
  );

  assert.equal(normalizeObservedHosts(rows, TARGET), null);
});

test("many existing hosts with no current observations use one bounded stale operation", async () => {
  const observedAt = "2026-09-01T10:00:00.000Z";
  const existing = Array.from({ length: 256 }, (_, index) => ({
    ip_address: `10.0.${Math.floor(index / 254)}.${(index % 254) + 1}`,
    first_seen_at: "2026-08-30T10:00:00.000Z",
    netbios_name: null,
    enrichment_status: "not_attempted" as const,
  }));
  const rows = prepareObservedHostRows([], TARGET, observedAt, existing, []);
  const staleCalls: unknown[][] = [];
  let upsertCalls = 0;

  const error = await persistObservedHostRows({
    markStale: async (...args) => {
      staleCalls.push(args);
      return { error: null };
    },
    upsertCurrent: async () => {
      upsertCalls += 1;
      return { error: null };
    },
  }, rows, TARGET, observedAt);

  assert.equal(error, null);
  assert.equal(rows.stale.length, 256);
  assert.deepEqual(staleCalls, [[TARGET, observedAt, null]]);
  assert.equal(upsertCalls, 0);
});

test("bulk stale handling preserves mixed current and stale final semantics", async () => {
  const observedAt = "2026-09-01T10:00:00.000Z";
  const firstSeenAt = "2026-08-30T10:00:00.000Z";
  const nodeId = "22222222-2222-4222-8222-222222222222";
  const normalized = normalizeObservedHosts([
    host(),
    host({ ip_address: "192.168.10.27", netbios_name: null, enrichment_status: "not_attempted" }),
  ], TARGET) ?? [];
  const rows = prepareObservedHostRows(
    normalized,
    TARGET,
    observedAt,
    [
      { ip_address: "192.168.10.25", first_seen_at: firstSeenAt, netbios_name: "HOST-25", enrichment_status: "resolved" },
      { ip_address: "192.168.10.26", first_seen_at: firstSeenAt, netbios_name: null, enrichment_status: "not_attempted" },
    ],
    [{ id: nodeId, ip_address: "192.168.10.25" }],
  );
  const persisted = new Map<string, Record<string, unknown>>([
    ["192.168.10.25", { target_id: TARGET, ip_address: "192.168.10.25", first_seen_at: firstSeenAt, status: "current" }],
    ["192.168.10.26", { target_id: TARGET, ip_address: "192.168.10.26", first_seen_at: firstSeenAt, status: "current" }],
  ]);
  let staleCalls = 0;
  let upsertCalls = 0;

  const error = await persistObservedHostRows({
    markStale: async (targetId, updatedAt, currentIpFilter) => {
      staleCalls += 1;
      const currentIps = new Set(
        [...(currentIpFilter ?? "").matchAll(/"([0-9.]+)"/g)].map((match) => match[1]),
      );
      for (const [ipAddress, row] of persisted) {
        if (row.target_id === targetId && !currentIps.has(ipAddress)) {
          persisted.set(ipAddress, { ...row, status: "stale", updated_at: updatedAt });
        }
      }
      return { error: null };
    },
    upsertCurrent: async (currentRows) => {
      upsertCalls += 1;
      for (const row of currentRows) persisted.set(row.ip_address, { ...persisted.get(row.ip_address), ...row });
      return { error: null };
    },
  }, rows, TARGET, observedAt);

  assert.equal(error, null);
  assert.equal(staleCalls, 1);
  assert.equal(upsertCalls, 1);
  assert.equal(persisted.get("192.168.10.25")?.status, "current");
  assert.equal(persisted.get("192.168.10.25")?.first_seen_at, firstSeenAt);
  assert.equal(persisted.get("192.168.10.25")?.node_id, nodeId);
  assert.equal(persisted.get("192.168.10.26")?.status, "stale");
  assert.equal(persisted.get("192.168.10.26")?.first_seen_at, firstSeenAt);
  assert.equal(persisted.get("192.168.10.27")?.status, "current");
  assert.equal(persisted.get("192.168.10.27")?.first_seen_at, observedAt);
  assert.equal(persisted.get("192.168.10.27")?.node_id, null);
});

test("empty existing and current observations issue no persistence operations", async () => {
  const rows = prepareObservedHostRows([], TARGET, "2026-09-01T10:00:00.000Z", [], []);
  let calls = 0;

  const error = await persistObservedHostRows({
    markStale: async () => {
      calls += 1;
      return { error: null };
    },
    upsertCurrent: async () => {
      calls += 1;
      return { error: null };
    },
  }, rows, TARGET, "2026-09-01T10:00:00.000Z");

  assert.equal(error, null);
  assert.equal(calls, 0);
});

test("current host exclusion filter remains private, unique, and bounded", () => {
  assert.equal(observedHostNotInFilter([]), null);
  assert.equal(observedHostNotInFilter(["192.168.10.25", "10.0.0.1"]), '("192.168.10.25","10.0.0.1")');
  assert.throws(() => observedHostNotInFilter(["8.8.8.8"]), /Invalid normalized observed host set/);
  assert.throws(() => observedHostNotInFilter(["10.0.0.1", "10.0.0.1"]), /Invalid normalized observed host set/);
});

test("managed telemetry request payload bound remains 128 KiB", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(source, /byteLength > 128 \* 1024/);
});
