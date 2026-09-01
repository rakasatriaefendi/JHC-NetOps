import assert from "node:assert/strict";
import test from "node:test";
import { normalizeObservedHosts, prepareObservedHostRows } from "./observed-hosts.ts";

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
