import assert from "node:assert/strict";
import test from "node:test";

import {
  boundedDiscoveryRange,
  discoveryRangeAddresses,
  resolveNetworkScopes,
  selectPrimaryDiscoveryScope,
} from "../src/network-scope.mjs";

function networkState({ addresses, interfaces = [], routes = [], defaultInterfaceIndex = 7 } = {}) {
  return {
    default_interface_index: defaultInterfaceIndex,
    interfaces: [{
      interface_index: 7,
      interface_alias: "Primary adapter",
      operational_status: "up",
      interface_kind: "physical",
      connection_type: "ethernet",
      addresses: addresses ?? [{ ip_address: "10.20.30.17", prefix_length: 24 }],
    }, ...interfaces],
    routes,
  };
}

test("connected /24, /23, and /16 scopes use the actual prefix", () => {
  const cases = [
    ["192.168.20.17", 24, "192.168.20.0/24"],
    ["10.20.31.17", 23, "10.20.30.0/23"],
    ["10.50.1.4", 16, "10.50.0.0/16"],
  ];
  for (const [ip, prefix, expected] of cases) {
    const resolved = resolveNetworkScopes(networkState({ addresses: [{ ip_address: ip, prefix_length: prefix }] }));
    assert.equal(selectPrimaryDiscoveryScope(resolved)?.cidr, expected);
  }
});

test("moving networks replaces the connected candidate without source changes", () => {
  const first = resolveNetworkScopes(networkState({ addresses: [{ ip_address: "10.30.4.10", prefix_length: 23 }] }));
  const moved = resolveNetworkScopes(networkState({ addresses: [{ ip_address: "172.20.8.77", prefix_length: 24 }] }));
  assert.deepEqual(first.candidates.map((item) => item.cidr), ["10.30.4.0/23"]);
  assert.deepEqual(moved.candidates.map((item) => item.cidr), ["172.20.8.0/24"]);
});

test("multiple active interfaces yield distinct connected candidates", () => {
  const resolved = resolveNetworkScopes(networkState({
    interfaces: [{
      interface_index: 11,
      interface_alias: "Secondary adapter",
      operational_status: "up",
      interface_kind: "physical",
      connection_type: "wifi",
      addresses: [{ ip_address: "172.22.4.8", prefix_length: 24 }],
    }],
  }));
  assert.deepEqual(resolved.candidates.map((item) => item.cidr), ["10.20.30.0/24", "172.22.4.0/24"]);
});

test("duplicate on-link and explicit routes are deduplicated in favor of connected scope", () => {
  const resolved = resolveNetworkScopes(networkState({
    routes: [
      { destination_cidr: "10.20.30.0/24", interface_index: 7 },
      { destination_cidr: "10.20.30.0/24", interface_index: 7 },
    ],
  }));
  assert.equal(resolved.candidates.length, 1);
  assert.equal(resolved.candidates[0].source_kind, "directly_connected");
});

test("loopback, link-local, inactive, and internal virtual interfaces are excluded", () => {
  const resolved = resolveNetworkScopes(networkState({
    addresses: [
      { ip_address: "127.0.0.1", prefix_length: 8 },
      { ip_address: "169.254.20.4", prefix_length: 16 },
    ],
    interfaces: [
      { interface_index: 8, interface_alias: "Inactive", operational_status: "down", interface_kind: "physical", connection_type: "ethernet", addresses: [{ ip_address: "10.8.0.2", prefix_length: 24 }] },
      { interface_index: 9, interface_alias: "Container bridge", operational_status: "up", interface_kind: "virtual_internal", connection_type: "unknown", addresses: [{ ip_address: "172.18.0.1", prefix_length: 16 }] },
    ],
  }));
  assert.deepEqual(resolved.candidates, []);
  assert.deepEqual(new Set(resolved.exclusions.map((item) => item.reason)), new Set([
    "loopback_or_unspecified", "link_local", "inactive_interface", "virtual_internal_interface",
  ]));
});

test("default and public routes are excluded while a private explicit route is represented", () => {
  const resolved = resolveNetworkScopes(networkState({ routes: [
    { destination_cidr: "0.0.0.0/0", interface_index: 7 },
    { destination_cidr: "8.8.8.0/24", interface_index: 7 },
    { destination_cidr: "10.40.20.0/24", interface_index: 7 },
  ] }));
  const routed = resolved.candidates.find((item) => item.source_kind === "explicit_route");
  assert.equal(routed?.cidr, "10.40.20.0/24");
  assert.ok(!resolved.candidates.some((item) => item.cidr === "0.0.0.0/0" || item.cidr === "8.8.8.0/24"));
});

test("tunnel explicit private routes remain eligible rather than excluding all VPN paths", () => {
  const resolved = resolveNetworkScopes(networkState({
    interfaces: [{
      interface_index: 12,
      interface_alias: "Corporate tunnel",
      operational_status: "up",
      interface_kind: "tunnel",
      connection_type: "unknown",
      addresses: [{ ip_address: "10.200.0.2", prefix_length: 32 }],
    }],
    routes: [{ destination_cidr: "10.70.0.0/16", interface_index: 12 }],
  }));
  assert.ok(resolved.candidates.some((item) => item.cidr === "10.70.0.0/16" && item.source_kind === "explicit_route"));
});

test("large connected scopes produce one bounded local address window, never an RFC1918-wide sweep", () => {
  for (const [ip, prefix] of [
    ["10.55.66.77", 8],
    ["172.20.9.4", 12],
    ["192.168.44.9", 16],
  ]) {
    const primary = selectPrimaryDiscoveryScope(resolveNetworkScopes(networkState({ addresses: [{ ip_address: ip, prefix_length: prefix }] })));
    const range = boundedDiscoveryRange(primary);
    const addresses = discoveryRangeAddresses(range);
    assert.equal(addresses.length, 254);
    assert.ok(addresses.includes(ip));
    assert.ok(!addresses.includes(primary.cidr.split("/")[0]));
  }
});

test("bounded address windows preserve wider-scope hosts that fall on an artificial /24 boundary", () => {
  const primary = selectPrimaryDiscoveryScope(resolveNetworkScopes(networkState({
    addresses: [{ ip_address: "10.20.31.0", prefix_length: 23 }],
  })));
  const addresses = discoveryRangeAddresses(boundedDiscoveryRange(primary));
  assert.ok(addresses.includes("10.20.31.0"));
  assert.ok(addresses.length <= 254);
});

test("scope fixtures are portable and do not require a named organization or current Wi-Fi subnet", () => {
  const source = JSON.stringify(networkState());
  assert.doesNotMatch(source, /JHC|192\.168\.188|192\.168\.1\./i);
});

test("an empty eligible OS network set returns an empty result instead of guessing", () => {
  const resolved = resolveNetworkScopes({ default_interface_index: null, interfaces: [], routes: [] });
  assert.deepEqual(resolved.candidates, []);
  assert.equal(selectPrimaryDiscoveryScope(resolved), null);
});

test("candidate and exclusion output remains bounded under oversized mocked OS state", () => {
  const interfaces = Array.from({ length: 80 }, (_, index) => ({
    interface_index: index + 100,
    interface_alias: `Adapter ${index}`,
    operational_status: "up",
    interface_kind: "physical",
    connection_type: "unknown",
    addresses: Array.from({ length: 20 }, (__, addressIndex) => ({
      ip_address: `10.${index}.${addressIndex}.1`,
      prefix_length: 24,
    })),
  }));
  const routes = Array.from({ length: 400 }, (_, index) => ({
    destination_cidr: `172.${16 + (index % 16)}.${index % 256}.0/24`,
    interface_index: 100 + (index % 64),
  }));
  const resolved = resolveNetworkScopes({ default_interface_index: 100, interfaces, routes });
  assert.ok(resolved.candidates.length <= 256);
  assert.ok(resolved.exclusions.length <= 256);
});
