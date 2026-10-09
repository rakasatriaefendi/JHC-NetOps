import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validAssetIdentity, type AssetIdentityData } from "../lib/asset-identity-contract.ts";

const ID = "11111111-1111-4111-8111-111111111111";
const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const data: AssetIdentityData = { asset_id: ID, identity_state: "provisional", evidence: [], endpoints: [],
  evidence_truncated: false, endpoints_truncated: false };

test("identity read contract supports distinct resolved/provisional/conflict states and bounded history", () => {
  for (const identity_state of ["resolved", "provisional", "conflict"]) assert.equal(validAssetIdentity({ data: { ...data, identity_state } }, ID), true);
  assert.equal(validAssetIdentity({ data: { ...data, identity_state: "online" } }, ID), false);
  assert.equal(validAssetIdentity({ data }, "22222222-2222-4222-8222-222222222222"), false);
  assert.equal(validAssetIdentity({ data: { ...data, evidence: Array(129).fill({}) } }, ID), false);
  assert.equal(validAssetIdentity({ data: { ...data, endpoints: Array(201).fill({}) } }, ID), false);
});

test("identity read contract accepts a valid endpoint timeline and rejects malformed or reversed history", () => {
  const endpoint = { id: ID, asset_id: ID, ip_address: "192.168.1.20", state: "current", confidence: "high",
    source: "active_scan", first_seen_at: "2026-10-09T00:00:00Z", last_seen_at: "2026-10-09T00:01:00Z",
    ended_at: null, network_node_ref: null, identity_key: "global_mac:00:11:22:33:44:55" };
  const valid = (row: unknown) => validAssetIdentity({ data: { ...data, endpoints: [row] } }, ID);
  assert.equal(valid(endpoint), true);
  assert.equal(valid({ ...endpoint, state: "historical", ended_at: "2026-10-09T00:02:00Z" }), true);
  for (const ip_address of ["not-an-ip", "192.168.1.256", "192.168.1.20/24"]) assert.equal(valid({ ...endpoint, ip_address }), false);
  assert.equal(valid({ ...endpoint, first_seen_at: "2026-10-09T00:02:00Z" }), false);
  assert.equal(valid({ ...endpoint, state: "historical" }), false);
  assert.equal(valid({ ...endpoint, state: "historical", ended_at: "2026-10-08T00:00:00Z" }), false);
});

test("asset detail adds a read-only identity panel without changing Inspector or history controls", () => {
  const component = source("../components/assets/asset-inventory.tsx");
  const panel = source("../components/assets/asset-identity-panel.tsx");
  assert.match(component, /<AssetIdentityPanel key=\{asset\.id\} assetId=\{asset\.id\}/);
  assert.match(component, /AssetDetailHistory/);
  assert.match(panel, /getAssetIdentityAction\(assetId\)/);
  assert.match(panel, /data\.asset_id/);
  assert.match(panel, /data\.endpoints\.map/);
  assert.match(panel, /data\.evidence\.map/);
  assert.match(panel, /identity\.strength/);
  assert.match(panel, /endpoints_truncated \|\| data\.evidence_truncated/);
  assert.doesNotMatch(panel, /LOCAL_BACKEND|DATABASE_URL|fetch\(|startInspection|requestAssetScan|<form|type="submit"/);
});

test("identity action requires approved auth, validates UUID and keeps backend credentials server-only", () => {
  const actions = source("../app/actions/assets.ts");
  const action = actions.slice(actions.indexOf("export async function getAssetIdentityAction"), actions.indexOf("export async function startAssetScanAction"));
  assert.match(action, /requireApprovedProfile\(\)/);
  assert.match(action, /typeof assetId !== "string"/);
  assert.match(action, /loadAssetIdentity\(assetId\)/);
  const loader = source("../lib/assets.ts");
  assert.match(loader, /import "server-only"/);
  assert.match(loader, /\/api\/assets\/\$\{encodeURIComponent\(id\)\}\/identity/);
  assert.match(loader, /validAssetIdentity\(payload, id\)/);
  assert.doesNotMatch(action, /token|DATABASE_URL/);
});

test("English and Indonesian catalogs explain endpoint history and evidence strength without asserting identity from IP", () => {
  for (const language of ["en", "id"]) {
    const catalog = JSON.parse(source(`../i18n/${language}/assets.json`));
    for (const state of ["resolved", "provisional", "conflict"]) assert.equal(typeof catalog.identity.state[state], "string");
    for (const state of ["current", "historical", "unresolved"]) assert.equal(typeof catalog.identity.endpointState[state], "string");
    for (const strength of ["strong", "corroborating", "weak"]) assert.equal(typeof catalog.identity.strength[strength], "string");
    assert.equal(typeof catalog.identity.canonicalId, "string");
    assert.equal(typeof catalog.identity.truncated, "string");
    assert.match(catalog.identity.help, language === "en" ? /not proof of identity/ : /bukan bukti identitas/);
  }
});
