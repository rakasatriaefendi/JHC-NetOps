import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { Client } from "pg";
import { applyEndpointObservation, endpointContinuityAnchor, normalizeIdentityEvidence, provisionalObservationKey, resolveDeviceIdentity,
  type EndpointAssignment, type EvidenceType, type IdentityCandidate, type IdentityEvidence } from "../src/assets/identity.js";
import { AssetIdentityRepository, observationIdentityEvidence } from "../src/assets/identity-repository.js";
import { buildAssetObservations } from "../src/assets/evidence.js";
import { diffAssetSnapshots, normalizeAssetChangeSnapshot, prepareAssetChangeEvent } from "../src/assets/change.js";
import { mergeActiveScanObservation, normalizeScannedHost } from "../src/assets/scan-normalize.js";
import type { AssetRepository } from "../src/assets/repository.js";
import { buildServer } from "../src/server.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const NODE = "33333333-3333-4333-8333-333333333333";
const TARGET = "44444444-4444-4444-8444-444444444444";
const T0 = "2026-10-09T00:00:00.000Z";
const T1 = "2026-10-09T00:01:00.000Z";
const MAC = "00:11:22:33:44:55";
const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
function evidence(type: EvidenceType, value: string): IdentityEvidence {
  const result = normalizeIdentityEvidence(type, value);
  assert.ok(result);
  return result;
}
const candidate = (id: string, values: IdentityEvidence[], node: string | null = null): IdentityCandidate =>
  ({ id, network_node_ref: node, evidence: values });
function scan(ip: string, mac: string | null = MAC, timestamp = T0) {
  return normalizeScannedHost({ ip_address: ip, mac_address: mac, vendor: null, hostname: null,
    latency_ms: 1, services: [], os_matches: [] }, null, timestamp);
}
function endpoint(assetId: string, ip: string, time = T0, anchor = `global_mac:${MAC}`): EndpointAssignment {
  return { id: `${assetId}:${ip}:${time}`, asset_id: assetId, ip_address: ip, state: "current", confidence: "high",
    source: "active_scan", first_seen_at: time, last_seen_at: time, ended_at: null,
    network_node_ref: null, identity_key: anchor };
}

function identityDatabase(context: TestContext, fixtures: {
  candidates: Record<string, unknown>[]; evidence: Record<string, unknown>[]; endpoints?: EndpointAssignment[];
}) {
  // No connect: every query on this typed pg client is intercepted locally.
  const client = new Client();
  const calls: { text: string; values: unknown[] }[] = [];
  context.mock.method(client, "query", async (input: unknown) => {
    const text = typeof input === "string" ? input : input && typeof input === "object" && "text" in input ? input.text : null;
    const values = input && typeof input === "object" && "values" in input ? input.values : [];
    assert.ok(typeof text === "string");
    assert.ok(Array.isArray(values));
    calls.push({ text, values });
    const rows = text.includes("FROM asset.assets WHERE") ? fixtures.candidates
      : text.includes("SELECT asset_id::text,evidence_type") ? fixtures.evidence
        : text.includes("FROM asset.endpoint_assignments WHERE") ? fixtures.endpoints ?? [] : [];
    return { rows, command: "SELECT", rowCount: rows.length, oid: 0, fields: [] };
  });
  return { repository: new AssetIdentityRepository(client), calls };
}

function writtenEndpoints(calls: { text: string; values: unknown[] }[]): EndpointAssignment[] {
  const upsert = calls.filter((call) => call.text.includes("INSERT INTO asset.endpoint_assignments")).at(-1);
  assert.ok(upsert);
  assert.ok(typeof upsert.values[0] === "string");
  return JSON.parse(upsert.values[0]);
}

test("same unique global MAC at a new IP preserves canonical asset identity", () => {
  const existing = candidate(A, [evidence("global_mac", MAC)]);
  for (const ip of ["192.168.1.20", "192.168.1.100"]) {
    const result = resolveDeviceIdentity(observationIdentityEvidence(scan(ip)), [existing]);
    assert.equal(result.assetId, A);
    assert.equal(result.state, "resolved");
  }
});

test("same IP with different strong identity cannot select or overwrite the old canonical asset", () => {
  const first = scan("192.168.1.20");
  const second = scan(first.ip_address!, "04:11:22:33:44:66");
  const result = resolveDeviceIdentity(observationIdentityEvidence(second), [candidate(A, observationIdentityEvidence(first))]);
  assert.equal(result.assetId, null);
  assert.equal(result.state, "resolved"); // A new canonical asset is required.
  const timeline = applyEndpointObservation([endpoint(A, first.ip_address!)], endpoint(B, second.ip_address!, T1, result.anchor!));
  assert.equal(timeline.find((row) => row.asset_id === A)?.state, "historical");
  assert.equal(timeline.find((row) => row.asset_id === B)?.state, "current");
});

test("duplicate global MAC returns conflict and all affected IDs, never a first-row winner", () => {
  const mac = evidence("global_mac", MAC);
  for (const rows of [[candidate(A, [mac]), candidate(B, [mac])], [candidate(B, [mac]), candidate(A, [mac])]]) {
    const result = resolveDeviceIdentity([mac], rows);
    assert.equal(result.assetId, null);
    assert.equal(result.state, "conflict");
    assert.deepEqual(result.conflictIds, [A, B]);
  }
});

test("local/random MAC is always weak, even when incorrectly labelled strong by a caller", () => {
  const local = evidence("global_mac", "02:11:22:33:44:55");
  assert.equal(local.evidence_type, "local_mac");
  assert.equal(local.strength, "weak");
  const result = resolveDeviceIdentity([{ ...local, strength: "strong" }], [candidate(A, [local])]);
  assert.equal(result.assetId, null);
  assert.equal(result.state, "provisional");
});

test("IP-only observations cannot select a canonical asset or claim current endpoint ownership", () => {
  const result = resolveDeviceIdentity(observationIdentityEvidence(scan("192.168.1.20", null)), [candidate(A, [])]);
  assert.equal(result.assetId, null);
  assert.equal(result.state, "provisional");
  const timeline = applyEndpointObservation([endpoint(A, "192.168.1.20")],
    { ...endpoint(B, "192.168.1.20", T1), state: "unresolved", confidence: "low", identity_key: null });
  assert.equal(timeline[0]?.state, "current");
  assert.equal(timeline[1]?.state, "unresolved");
});

test("explicit existing network-node binding wins over serial or MAC evidence", () => {
  const result = resolveDeviceIdentity([evidence("network_node_binding", NODE), evidence("snmp_serial", "SERIAL-42"), evidence("global_mac", MAC)],
    [candidate(A, [], NODE), candidate(B, [evidence("snmp_serial", "SERIAL-42"), evidence("global_mac", MAC)])]);
  assert.equal(result.assetId, A);
  assert.equal(result.anchor, `network_node_binding:${NODE}`);
});

test("a new explicit binding still resolves a unique existing strong identity before creating an asset", () => {
  const result = resolveDeviceIdentity([evidence("network_node_binding", NODE), evidence("global_mac", MAC)],
    [candidate(A, [evidence("global_mac", MAC)])]);
  assert.equal(result.assetId, A);
  assert.equal(result.anchor, `global_mac:${MAC}`);
  const duplicate = resolveDeviceIdentity([evidence("network_node_binding", NODE), evidence("global_mac", MAC)],
    [candidate(A, [evidence("global_mac", MAC)]), candidate(B, [evidence("global_mac", MAC)])]);
  assert.equal(duplicate.state, "conflict");
  assert.equal(duplicate.assetId, null);
});

test("endpoint anchor uses the evidence value that actually matched the canonical asset", () => {
  const result = resolveDeviceIdentity([evidence("global_mac", "04:11:22:33:44:66"), evidence("global_mac", MAC)],
    [candidate(A, [evidence("global_mac", MAC)])]);
  assert.equal(result.anchor, `global_mac:${MAC}`);
});

test("a new node sharing strong evidence cannot replace a different existing explicit binding", () => {
  const result = resolveDeviceIdentity([evidence("network_node_binding", NODE), evidence("global_mac", MAC)],
    [candidate(A, [evidence("global_mac", MAC)], TARGET)]);
  assert.equal(result.assetId, null);
  assert.equal(result.state, "conflict");
  assert.deepEqual(result.conflictIds, [A]);
});

test("unique usable SNMP serial resolves identity before a MAC match", () => {
  const serial = evidence("snmp_serial", "  Serial-42  ");
  assert.equal(serial.normalized_value, "SERIAL-42");
  assert.equal(serial.strength, "strong");
  assert.equal(resolveDeviceIdentity([serial, evidence("global_mac", MAC)],
    [candidate(A, [serial]), candidate(B, [evidence("global_mac", MAC)])]).assetId, A);
});

test("sysObjectID/manufacturer/model and hostname/sysName/NetBIOS alone never resolve identity", () => {
  for (const [type, value] of [["sys_object_id", "1.3.6.1.4.1.8072.3.2.10"], ["manufacturer", "Ruijie"], ["model", "RG-EG1510XS"],
    ["hostname", "router-01"], ["sys_name", "router-01"], ["netbios_name", "LAB-PC"]] as const) {
    const item = evidence(type, value);
    const result = resolveDeviceIdentity([item], [candidate(A, [item])]);
    assert.equal(result.state, "provisional");
    assert.equal(result.assetId, null);
  }
});

test("garbage, malformed, multicast, and secret-shaped evidence is ignored", () => {
  for (const value of ["", " ", "-", "0x", "0x00", "0000", "unknown", "n/a", "none", "not specified", "?", "x\nvalue",
    "x".repeat(257), "password=hidden", "community=hidden", "Bearer hidden"]) {
    assert.equal(normalizeIdentityEvidence("snmp_serial", value), null, value);
  }
  for (const value of ["00:00:00:00:00:00", "FF:FF:FF:FF:FF:FF", "01:11:22:33:44:55", "bad-mac"]) {
    assert.equal(normalizeIdentityEvidence("global_mac", value), null);
  }
  assert.equal(normalizeIdentityEvidence("sys_object_id", "not-an-oid"), null);
  assert.equal(normalizeIdentityEvidence("network_node_binding", "not-a-uuid"), null);
});

test("endpoint moves close the old current assignment and open the new one without mutating input", () => {
  const original = endpoint(A, "192.168.1.20");
  const result = applyEndpointObservation([original], endpoint(A, "192.168.1.100", T1));
  assert.equal(original.state, "current");
  assert.equal(result[0]?.state, "historical");
  assert.equal(result[0]?.ended_at, T1);
  assert.equal(result[0]?.first_seen_at, T0);
  assert.equal(result[1]?.state, "current");
  const refreshed = applyEndpointObservation(result, endpoint(A, "192.168.1.100", "2026-10-09T00:02:00.000Z"));
  assert.equal(refreshed.length, 2);
  assert.equal(refreshed[1]?.first_seen_at, T1);
});

test("different interface anchors retain multiple endpoints and delayed evidence cannot steal a newer owner", () => {
  const first = endpoint(A, "192.168.1.20");
  const second = endpoint(A, "192.168.1.21", T1, "global_mac:04:11:22:33:44:66");
  const multi = applyEndpointObservation([first], second);
  assert.equal(multi.filter((row) => row.state === "current").length, 2);
  const delayed = applyEndpointObservation([endpoint(B, "192.168.1.20", T1)], first);
  assert.equal(delayed[0]?.state, "current");
  assert.equal(delayed[1]?.state, "unresolved");
});

test("promoting the same unresolved endpoint observation never duplicates its row ID", () => {
  const current = endpoint(A, "192.168.1.20");
  const result = applyEndpointObservation([{ ...current, state: "unresolved", confidence: "low" }], current);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.state, "current");
});

test("repository promotes an unresolved endpoint with complete current fields and preserves its first observation", async (context) => {
  const unresolved = { ...endpoint(A, "192.168.1.20"), id: TARGET, state: "unresolved" as const,
    confidence: "low" as const, identity_key: null, network_node_ref: null };
  const endpoints: EndpointAssignment[] = [unresolved];
  const { repository, calls } = identityDatabase(context, {
    candidates: [{ id: A, stable_source_key: "node:legacy", network_node_ref: NODE, identity_state: "resolved", mac_address: MAC }],
    evidence: [{ asset_id: A, ...evidence("global_mac", MAC) }], endpoints,
  });
  const signal = new AbortController().signal;
  const prepared = await repository.prepare([{ ...scan("192.168.1.20", MAC, T1), network_node_ref: NODE }], null, signal);
  await repository.persist(prepared, signal);
  const promoted = writtenEndpoints(calls).find((row) => row.id === TARGET);
  assert.ok(promoted);
  assert.equal(promoted.state, "current");
  assert.equal(promoted.confidence, "authoritative");
  assert.equal(promoted.first_seen_at, T0);
  assert.equal(promoted.last_seen_at, T1);
  assert.equal(promoted.ended_at, null);
  assert.equal(promoted.network_node_ref, NODE);
  assert.equal(promoted.identity_key, `network_node_binding:${NODE}`);
  const upsert = calls.find((call) => call.text.includes("INSERT INTO asset.endpoint_assignments"))!;
  const update = upsert.text.slice(upsert.text.indexOf("ON CONFLICT (id) DO UPDATE"));
  for (const field of ["state", "confidence", "ended_at", "network_node_ref", "identity_key"]) {
    assert.ok(update.includes(`${field}=EXCLUDED.${field}`), field);
  }
  assert.match(update, /last_seen_at=greatest\(asset\.endpoint_assignments\.last_seen_at,EXCLUDED\.last_seen_at\)/);
  assert.doesNotMatch(update, /first_seen_at\s*=/);
  assert.equal(update.slice(update.indexOf("WHERE")).replace(/\s+/g, " ").trim(),
    "WHERE asset.endpoint_assignments.state='current' OR (asset.endpoint_assignments.state='unresolved' AND EXCLUDED.state IN ('unresolved','current')) OR (asset.endpoint_assignments.state='historical' AND EXCLUDED.state='historical')");
  // Represent the successful previous write, then exercise current -> current.
  endpoints[0] = promoted;
  const nextSeen = "2026-10-09T00:02:00.000Z";
  await repository.persist(await repository.prepare([
    { ...scan("192.168.1.20", MAC, nextSeen), network_node_ref: NODE },
  ], null, signal), signal);
  const refreshed = writtenEndpoints(calls).find((row) => row.id === TARGET);
  assert.equal(refreshed?.state, "current");
  assert.equal(refreshed?.first_seen_at, T0);
  assert.equal(refreshed?.last_seen_at, nextSeen);
  assert.equal(refreshed?.confidence, "authoritative");
  assert.equal(refreshed?.network_node_ref, NODE);
  assert.equal(refreshed?.identity_key, `network_node_binding:${NODE}`);
});

test("repository never resurrects an already historical endpoint on snapshot replay", async (context) => {
  const historical = { ...endpoint(A, "192.168.1.20"), id: TARGET, state: "historical" as const, ended_at: T1 };
  const { repository, calls } = identityDatabase(context, {
    candidates: [{ id: A, stable_source_key: "legacy", network_node_ref: null, identity_state: "resolved", mac_address: MAC }],
    evidence: [{ asset_id: A, ...evidence("global_mac", MAC) }], endpoints: [historical],
  });
  const signal = new AbortController().signal;
  await repository.persist(await repository.prepare([scan("192.168.1.20")], null, signal), signal);
  const rows = writtenEndpoints(calls);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.state, "historical");
  assert.equal(rows[0]?.ended_at, T1);
});

test("repeated duplicate-MAC snapshots, including a new explicit node, only mark existing candidates conflict", async (context) => {
  const { repository, calls } = identityDatabase(context, {
    candidates: [A, B].map((id) => ({ id, stable_source_key: `legacy:${id}`, network_node_ref: null,
      identity_state: "resolved", mac_address: MAC })),
    evidence: [A, B].map((asset_id) => ({ asset_id, ...evidence("global_mac", MAC) })),
  });
  const signal = new AbortController().signal;
  for (const time of [T0, T1, "2026-10-09T00:02:00.000Z"]) {
    for (const network_node_ref of [null, NODE]) {
      const prepared = await repository.prepare([{ ...scan("192.168.1.20", MAC, time), network_node_ref }], null, signal);
      assert.equal(prepared.length, 1);
      assert.equal(prepared[0]?.disposition, "conflict");
      assert.equal(prepared[0]?.assetId, null);
      assert.deepEqual(prepared[0]?.resolution.conflictIds, [A, B]);
      await repository.persist(prepared, signal);
    }
  }
  const updates = calls.filter((call) => call.text.includes("UPDATE asset.assets a SET identity_state"));
  assert.equal(updates.length, 6);
  for (const update of updates) {
    assert.equal(typeof update.values[0], "string");
    assert.deepEqual(JSON.parse(String(update.values[0])), [{ id: A, state: "conflict" }, { id: B, state: "conflict" }]);
  }
  assert.equal(calls.some((call) => /INSERT INTO asset\.(assets|identity_evidence|endpoint_assignments)/.test(call.text)), false);
  const parent = source("../src/assets/repository.ts");
  assert.match(parent, /item\.disposition === "ingest"/);
  assert.match(parent, /observations = ingestible\.map/);
  assert.match(parent, /if \(!observations\.length\) \{[\s\S]*?identity\.persist\(prepared, signal\);[\s\S]*?return 0;/);
});

test("same serial with different interface MACs persists two current endpoints for one canonical asset", async (context) => {
  const serial = evidence("snmp_serial", "SERIAL-42");
  const secondMac = "04:11:22:33:44:66";
  const { repository, calls } = identityDatabase(context, {
    candidates: [{ id: A, stable_source_key: "legacy", network_node_ref: null, identity_state: "resolved", mac_address: MAC }],
    evidence: [{ asset_id: A, ...serial }, { asset_id: A, ...evidence("global_mac", MAC) }],
  });
  const signal = new AbortController().signal;
  const prepared = await repository.prepare([
    { ...scan("192.168.1.20"), identity_evidence: [serial] },
    { ...scan("192.168.1.21", secondMac, T1), identity_evidence: [serial] },
  ], null, signal);
  for (const item of prepared) {
    assert.equal(item.assetId, A);
    assert.equal(item.resolution.anchor, "snmp_serial:SERIAL-42");
  }
  await repository.persist(prepared, signal);
  const rows = writtenEndpoints(calls);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.asset_id === A && row.state === "current"));
  assert.deepEqual(rows.map((row) => row.identity_key), [`global_mac:${MAC}`, `global_mac:${secondMac}`]);
});

test("same serial and interface MAC moving IP closes only that interface's old endpoint", async (context) => {
  const serial = evidence("snmp_serial", "SERIAL-42");
  const otherMac = "04:11:22:33:44:66";
  const { repository, calls } = identityDatabase(context, {
    candidates: [{ id: A, stable_source_key: "legacy", network_node_ref: null, identity_state: "resolved", mac_address: MAC }],
    evidence: [{ asset_id: A, ...serial }, { asset_id: A, ...evidence("global_mac", MAC) }],
    endpoints: [{ ...endpoint(A, "192.168.1.20"), id: TARGET },
      { ...endpoint(A, "192.168.1.21", T0, `global_mac:${otherMac}`), id: NODE }],
  });
  const signal = new AbortController().signal;
  const prepared = await repository.prepare([{ ...scan("192.168.1.100", MAC, T1), identity_evidence: [serial] }], null, signal);
  assert.equal(prepared[0]?.assetId, A);
  assert.equal(prepared[0]?.resolution.anchor, "snmp_serial:SERIAL-42");
  await repository.persist(prepared, signal);
  const rows = writtenEndpoints(calls);
  assert.equal(rows.find((row) => row.ip_address === "192.168.1.20")?.state, "historical");
  assert.equal(rows.find((row) => row.ip_address === "192.168.1.20")?.ended_at, T1);
  assert.equal(rows.find((row) => row.ip_address === "192.168.1.100")?.state, "current");
  assert.equal(rows.find((row) => row.ip_address === "192.168.1.21")?.state, "current");
});

test("endpoint continuity prefers a node binding or global interface MAC, never IP or weak evidence", () => {
  const serial = evidence("snmp_serial", "SERIAL-42");
  assert.equal(endpointContinuityAnchor([serial, evidence("global_mac", MAC)]), `global_mac:${MAC}`);
  assert.equal(endpointContinuityAnchor([serial, evidence("global_mac", MAC), evidence("network_node_binding", NODE)]), `network_node_binding:${NODE}`);
  assert.equal(endpointContinuityAnchor([serial]), "snmp_serial:SERIAL-42");
  assert.equal(endpointContinuityAnchor(observationIdentityEvidence(scan("192.168.1.20", null))), null);
  assert.equal(endpointContinuityAnchor([evidence("local_mac", "02:11:22:33:44:55")]), null);
});

test("recorded strong-MAC continuity can close a legacy binding endpoint without closing another asset or interface", () => {
  const legacy = endpoint(A, "192.168.1.20", T0, `network_node_binding:${NODE}`);
  const otherAsset = endpoint(B, "192.168.1.21", T0, `network_node_binding:${NODE}`);
  const otherInterface = endpoint(A, "192.168.1.22", T0, "global_mac:04:11:22:33:44:66");
  const result = applyEndpointObservation([legacy, otherAsset, otherInterface], endpoint(A, "192.168.1.100", T1),
    [`network_node_binding:${NODE}`]);
  assert.equal(result.find((row) => row.id === legacy.id)?.state, "historical");
  assert.equal(result.find((row) => row.id === otherAsset.id)?.state, "current");
  assert.equal(result.find((row) => row.id === otherInterface.id)?.state, "current");
  assert.equal(result.at(-1)?.ip_address, "192.168.1.100");
  const repository = source("../src/assets/identity-repository.ts");
  assert.match(repository, /item\.normalized_value === existing\?\.mac_address/);
  assert.match(repository, /resolution\.state === "resolved" && sameMac/);
});

test("provisional keys identify an immutable source observation, not IP continuity across snapshots", () => {
  const input = { sourceKey: "observed:target:192.168.1.20", ip: "192.168.1.20", mac: null, observedAt: T0, scanRunId: null };
  assert.equal(provisionalObservationKey(input), provisionalObservationKey({ ...input }));
  assert.notEqual(provisionalObservationKey(input), provisionalObservationKey({ ...input, observedAt: T1 }));
  assert.notEqual(provisionalObservationKey(input), provisionalObservationKey({ ...input, mac: "02:11:22:33:44:55" }));
  assert.notEqual(provisionalObservationKey(input), provisionalObservationKey({ ...input, scanRunId: A }));
  assert.match(provisionalObservationKey(input), /^provisional:[0-9a-f]{64}$/);
});

test("managed telemetry feeds captured serial/ObjectID evidence; neighbor node_id remains IP correlation only", () => {
  const observations = buildAssetObservations({
    nodes: [{ id: NODE, ip_address: "192.168.1.8", name: "Core", updated_at: T0 }], healthTargets: [],
    managedTargets: [{ id: TARGET, node_id: NODE, managed_device_latest: { status: "connected", last_polled_at: T0,
      serial_number: "SERIAL-42", sys_object_id: "1.3.6.1.4.1.8072.3.2.10", manufacturer: "Ruijie", model: "Lab", sys_name: "router" } }],
    observedHosts: [{ target_id: TARGET, node_id: NODE, ip_address: "192.168.1.8", mac_address: "02:11:22:33:44:55",
      first_seen_at: T0, last_seen_at: T0, status: "current" }],
  });
  assert.equal(observations.length, 2);
  const node = observations.find((row) => row.network_node_ref === NODE)!;
  assert.ok(observationIdentityEvidence(node).some((row) => row.evidence_type === "snmp_serial" && row.strength === "strong"));
  const neighbor = observations.find((row) => row.source === "observed_host")!;
  assert.equal(neighbor.network_node_ref, null);
  assert.equal(resolveDeviceIdentity(observationIdentityEvidence(neighbor), [candidate(A, [], NODE)]).state, "provisional");
  assert.doesNotMatch(JSON.stringify(observations), /engine.?id/i);
});

test("migration 019 is exact-target guarded and preserves legacy asset IDs/source keys and duplicates", () => {
  const sql = source("../migrations/019_stable_device_identity.sql").replace(/--[^\r\n]*/g, "");
  for (const guard of ["current_database() <> 'jhc_netops'", "current_setting('port')::integer <> 5433",
    "NOT BETWEEN 160000 AND 169999", "'/var/lib/postgresql/16/jhcnetops'", "session_user <> 'postgres'",
    "to_regclass('asset.assets') IS NULL", "to_regclass('public.application_schema_migrations') IS NULL",
    "WHERE version = 18", "max(version) FROM public.application_schema_migrations) <> 18"]) assert.ok(sql.includes(guard), guard);
  assert.match(sql, /BEGIN;[\s\S]*SET ROLE jhc_netops_owner;[\s\S]*VALUES \(19\);\s*RESET ROLE;\s*COMMIT;/);
  assert.match(sql, /identity_state IN \('resolved','provisional','conflict'\)/);
  assert.match(sql, /UNIQUE \(asset_id,evidence_type,normalized_value,source\)/);
  assert.doesNotMatch(sql, /UNIQUE\s*\(\s*evidence_type\s*,\s*normalized_value\s*\)/);
  assert.match(sql, /CREATE UNIQUE INDEX endpoint_current_ip_unique[\s\S]*WHERE state='current'/);
  assert.match(sql, /CHECK \(first_seen_at <= last_seen_at\)/);
  assert.match(sql, /REVOKE ALL ON asset\.identity_evidence,asset\.endpoint_assignments FROM PUBLIC,jhc_netops_app/);
  assert.match(sql, /GRANT SELECT,INSERT,UPDATE ON asset\.identity_evidence,asset\.endpoint_assignments TO jhc_netops_app/);
  assert.doesNotMatch(sql, /DELETE FROM asset\.assets|MERGE INTO|TRUNCATE|SET\s+(?:id|stable_source_key)\s*=|GRANT[^;]*DELETE/i);
  assert.match(sql, /'current','authoritative','network_node'/);
  assert.match(sql, /'unresolved','low','legacy_asset'/);
  assert.match(sql, /get_byte\(decode\(replace\(mac_address::text,':',''\),'hex'\),0\) & 2/);
  assert.match(sql, /evidence_type='global_mac' AND \(get_byte\(decode\(replace\(normalized_value,':',''\),'hex'\),0\) & 2\)=0/);
  assert.match(sql, /evidence_type='local_mac' AND \(get_byte\(decode\(replace\(normalized_value,':',''\),'hex'\),0\) & 2\)=2/);
  assert.match(sql, /Ambiguous explicit endpoint bindings require operator review/);
  assert.match(sql, /FROM valid GROUP BY id,kind/);
});

test("both scan modes use transactionally serialized identity selection before reconciliation and history", () => {
  const scanRepository = source("../src/assets/scan-repository.ts");
  const repository = source("../src/assets/repository.ts");
  const identity = source("../src/assets/identity-repository.ts");
  assert.doesNotMatch(scanRepository, /byIp|byMac|host\(ip_address\) = ANY/);
  assert.doesNotMatch(source("../src/assets/scan-normalize.ts"), /active_scan:ip:/);
  assert.ok(repository.indexOf('client.query("BEGIN")') < repository.indexOf("identity.prepare("));
  assert.ok(repository.indexOf("identity.prepare(") < repository.indexOf("const beforeResult"));
  assert.ok(repository.indexOf("identity.persist(") < repository.indexOf("insertAssetChangeEvents(client, events)"));
  assert.ok(repository.indexOf("insertAssetChangeEvents(client, events)") < repository.lastIndexOf('client.query("COMMIT")'));
  assert.match(repository, /client\.query\("ROLLBACK"\)/);
  assert.match(identity, /pg_advisory_xact_lock[\s\S]*asset\.identity-resolution\.v1/);
  const candidates = identity.slice(identity.indexOf("const rows ="), identity.indexOf("const evidenceRows"));
  assert.doesNotMatch(candidates, /ip_address|hostname|sys_name|sys_object_id/);
  assert.match(identity, /conflictIds\) stateById\.set\(id, "conflict"\)/);
  assert.ok(identity.indexOf("const closed =") < identity.indexOf("INSERT INTO asset.endpoint_assignments"));
  assert.match(identity, /ASSET_EVIDENCE_ROW_LIMIT|LIMIT 4001/);
  assert.match(repository, /Date\.parse\(incomingSeen\) < Date\.parse\(beforeSeen\)/);
  assert.match(repository, /ip_address: before\.ip_address, mac_address: before\.mac_address/);
});

test("classification and created/change-history semantics remain intact after identity selection", () => {
  const old = { ...scan("192.168.1.20"), name: "Operator Name", source: "manual" as const, network_node_ref: NODE,
    device_type: "switch_network", open_ports: [22, 443] };
  const merged = mergeActiveScanObservation(old, scan("192.168.1.100", MAC, T1));
  assert.equal(merged.name, old.name);
  assert.equal(merged.device_type, old.device_type);
  assert.deepEqual(merged.open_ports, old.open_ports);
  assert.deepEqual(diffAssetSnapshots(normalizeAssetChangeSnapshot(old), normalizeAssetChangeSnapshot(merged)), ["ip_address"]);
  const created = prepareAssetChangeEvent({ assetId: A, stableKey: old.stable_source_key, source: "active_scan", scanRunId: B,
    observedAt: T0, before: null, after: normalizeAssetChangeSnapshot(old) });
  assert.equal(created?.event_type, "created");
  assert.deepEqual(created?.changed_fields, []);
});

test("Health/SNMP execution still resolves network_nodes.ip_address and no identity failure gate is introduced", () => {
  for (const path of ["../src/persistence/network-health.ts", "../src/persistence/managed-telemetry.ts"]) {
    const text = source(path);
    assert.match(text, /host\(n\.ip_address\) AS ip_address/);
    assert.doesNotMatch(text, /IDENTITY_CONFLICT|IDENTITY_UNRESOLVED|asset\.identity_evidence/);
  }
});

test("read-only identity route requires server bearer auth and validates immutable asset UUID", async () => {
  const token = "t".repeat(32);
  const calls: string[] = [];
  const repository: AssetRepository = {
    async list() { throw new Error("not used"); }, async detail() { return null; },
    async ingest() { throw new Error("read-only route must not ingest"); },
    async identity(id, signal) { signal.throwIfAborted(); calls.push(id); return id === A
      ? { asset_id: A, identity_state: "resolved", evidence: [], endpoints: [], evidence_truncated: false, endpoints_truncated: false } : null; },
  };
  const server = buildServer({ logger: false, assets: { token, repository } });
  try {
    assert.equal((await server.inject({ method: "GET", url: `/api/assets/${A}/identity` })).statusCode, 401);
    const headers = { authorization: `Bearer ${token}` };
    assert.equal((await server.inject({ method: "GET", url: "/api/assets/not-a-uuid/identity", headers })).statusCode, 400);
    const response = await server.inject({ method: "GET", url: `/api/assets/${A}/identity`, headers });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.asset_id, A);
    assert.equal((await server.inject({ method: "GET", url: `/api/assets/${B}/identity`, headers })).statusCode, 404);
    assert.deepEqual(calls, [A, B]);
  } finally { await server.close(); }
});
