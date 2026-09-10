import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { validAssetScanState } from "../lib/asset-scan-contract.ts";
import { validConfiguredNetworks, validDetectedNetworks, validRoute } from "../lib/scan-network-contract.ts";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const NOW = "2026-09-09T00:00:00.000Z";

test("scan-network frontend contracts accept bounded direct/routed data and reject malformed payloads", () => {
  const direct = network("direct", true);
  const routed = { ...network("routed", true), id: "22222222-2222-4222-8222-222222222222", cidr: "192.168.20.0/24", gateway: "192.168.1.1" };
  assert.equal(validConfiguredNetworks({ data: { networks: [direct, routed] } }), true);
  assert.equal(validConfiguredNetworks({ data: { networks: Array(9).fill(direct) } }), false);
  assert.equal(validConfiguredNetworks({ data: { networks: [{ ...direct, enabled: "yes" }] } }), false);
  assert.equal(validDetectedNetworks({ data: { available: false, networks: [], reason_code: "DETECTOR_UNAVAILABLE" } }), true);
  assert.equal(validDetectedNetworks({ data: { available: true, networks: [{ cidr: "192.168.1.0/24", interface_name: "eth0", source_ip: "192.168.1.2", route_kind: "direct" }], reason_code: null } }), true);
  assert.equal(validRoute({ ...direct, route_kind: "invented" }), false);
});

test("scan state supports a compact single network and labeled multiple-network selector", () => {
  const base = { available: true, current: null, last: null };
  assert.equal(validAssetScanState({ ...base, networks: ["192.168.1.0/24"], network_options: [{ name: "LAN Utama", cidr: "192.168.1.0/24", route_kind: "direct" }] }), true);
  assert.equal(validAssetScanState({ ...base, networks: ["192.168.1.0/24", "192.168.20.0/24"], network_options: [
    { name: "LAN Utama", cidr: "192.168.1.0/24", route_kind: "direct" },
    { name: "VLAN Radiologi", cidr: "192.168.20.0/24", route_kind: "routed" },
  ] }), true);
});

test("settings UI keeps auto-detection optional and exposes one generic manual network workflow", () => {
  const settings = source("../components/assets/scan-network-settings.tsx");
  for (const behavior of ["scanNetworks.detected.unavailable", "scanNetworks.detected.use", "scanNetworks.add.title", "testScanNetworkAction", "updateScanNetworkAction", "deleteScanNetworkAction", "window.confirm"]) {
    assert.match(settings, new RegExp(behavior.replaceAll(".", "\\.")));
  }
  assert.match(settings, /origin: "manual"/);
  assert.match(settings, /origin: "detected"/);
  assert.match(settings, /configuredRoutes/);
  assert.match(settings, /testedRoute/);
  assert.match(settings, /testRoute\(item\.cidr, "configured"\)/);
  assert.match(settings, /testRoute\(cidr, "form"\)/);
  assert.match(settings, /network\.cidr === candidate \? \{ \.\.\.network, \.\.\.testedRoute \}/);
  assert.doesNotMatch(settings, /setCidr\(result\.data\.cidr\)/);
  assert.match(settings, /canManage \?/);
  assert.doesNotMatch(settings, /nmap|snmp|exec\(|spawn\(|--script/i);
});

test("scan modal uses only enabled backend options with one shared target selection", () => {
  const control = source("../components/assets/asset-scan-control.tsx");
  const actions = source("../app/actions/assets.ts");
  const loader = source("../lib/assets.ts");
  assert.match(control, /state\.networks\.map/);
  assert.match(control, /network_options/);
  assert.match(control, /networkLabel/);
  assert.match(control, /scan\.noEnabledNetworks/);
  assert.match(control, /ScanNetworkSettings/);
  assert.match(actions, /getScanNetworksAction[\s\S]*requireApprovedProfile/);
  assert.match(actions, /createScanNetworkAction[\s\S]*requireOperatorProfile/);
  assert.match(actions, /updateScanNetworkAction[\s\S]*requireOperatorProfile/);
  assert.match(actions, /deleteScanNetworkAction[\s\S]*requireOperatorProfile/);
  assert.match(loader, /\/api\/assets\/scan-networks/);
  assert.doesNotMatch(control, /<input[^>]+name=["']network/);
});

test("Indonesian and English catalogs pair every P10D3 UX state", () => {
  const id = JSON.parse(source("../i18n/id/assets.json"));
  const en = JSON.parse(source("../i18n/en/assets.json"));
  for (const path of [
    "action", "detected.title", "detected.use", "detected.unavailable", "configured.title", "add.title", "add.help",
    "test", "enable", "disable", "route.direct", "route.routed", "route.unreachable", "route.unknown",
    "routeFeedback.direct", "routeFeedback.routed", "routeFeedback.unreachable", "errors.SCAN_NETWORK_DUPLICATE",
  ]) {
    assert.equal(typeof get(id.scanNetworks, path), "string", `id ${path}`);
    assert.equal(typeof get(en.scanNetworks, path), "string", `en ${path}`);
  }
  assert.doesNotMatch(JSON.stringify(id.scanNetworks), /VLAN/i);
  assert.doesNotMatch(JSON.stringify(en.scanNetworks), /VLAN/i);
  assert.match(String(get(id.scanNetworks, "add.help")), /kanonik/);
  assert.match(String(get(en.scanNetworks, "add.help")), /canonical/);
});

function network(route_kind: "direct" | "routed" | "unreachable" | "unknown", enabled: boolean) {
  return { id: "11111111-1111-4111-8111-111111111111", name: "Main", cidr: "192.168.1.0/24", enabled, origin: "manual", created_at: NOW, updated_at: NOW, route_kind, interface_name: "eth0", source_ip: "192.168.1.2", gateway: null, reason_code: route_kind === "direct" || route_kind === "routed" ? "ROUTE_AVAILABLE" : route_kind === "unreachable" ? "ROUTE_UNAVAILABLE" : "ROUTE_UNKNOWN" };
}

function get(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => typeof current === "object" && current !== null ? (current as Record<string, unknown>)[key] : undefined, value);
}
