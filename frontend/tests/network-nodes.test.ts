import assert from "node:assert/strict";
import test from "node:test";

import {
  NETWORK_NODE_TYPES,
  findNetworkNode,
  networkNodeDisplayName,
  normalizeNetworkNodeIp,
  validateNetworkNodeInput,
  type NetworkNode,
} from "../lib/network-nodes.ts";

const node: NetworkNode = {
  id: "00000000-0000-4000-8000-000000000001",
  ip_address: "192.168.2.3",
  name: "Router Lantai 4",
  device_type: "router",
  location: "Lantai 4",
      notes: null,
      detected_fingerprint: null,
      last_inspected_at: null,
  created_by: null,
  created_at: "2026-08-14T00:00:00Z",
  updated_at: "2026-08-14T00:00:00Z",
};

test("unknown IP stays unresolved until a reusable node exists", () => {
  assert.equal(findNetworkNode([], "192.168.2.3"), undefined);
  assert.equal(networkNodeDisplayName(undefined), "Unknown node");
  assert.equal(findNetworkNode([node], "192.168.2.3")?.name, "Router Lantai 4");
  assert.equal(networkNodeDisplayName(node), "Router Lantai 4");
  assert.equal(networkNodeDisplayName(node, "Server 253"), "Server 253");
});

test("rename and delete affect lookup without rewriting a hop measurement", () => {
  const renamed = { ...node, name: "Core Router", updated_at: "2026-08-14T01:00:00Z" };
  assert.equal(findNetworkNode([renamed], node.ip_address)?.name, "Core Router");
  assert.equal(findNetworkNode([], node.ip_address), undefined);
});

test("IPv4 validation canonicalizes octets and rejects invalid hosts or CIDR", () => {
  assert.equal(normalizeNetworkNodeIp("192.168.002.003"), "192.168.2.3");
  assert.equal(normalizeNetworkNodeIp("192.168.2.256"), null);
  assert.equal(normalizeNetworkNodeIp("192.168.2.3/24"), null);
  assert.equal(normalizeNetworkNodeIp("router.local"), null);
});

test("IPv6 remains compatible and equivalent spellings resolve one node", () => {
  const ipv6Node = { ...node, ip_address: "2001:db8::1", name: "IPv6 Router" };
  assert.equal(normalizeNetworkNodeIp("2001:0DB8:0:0:0:0:0:1"), "[2001:db8::1]".replace(/^\[|\]$/g, ""));
  assert.equal(findNetworkNode([ipv6Node], "2001:0DB8:0:0:0:0:0:1")?.name, "IPv6 Router");
});

test("node form requires a valid IP and non-empty name", () => {
  assert.equal(validateNetworkNodeInput({ ip_address: "192.168.2.3", name: "Router", device_type: "router", location: null, notes: null }), null);
  assert.match(validateNetworkNodeInput({ ip_address: "bad", name: "Router", device_type: null, location: null, notes: null }) ?? "", /IP/);
  assert.match(validateNetworkNodeInput({ ip_address: "192.168.2.3", name: " ", device_type: null, location: null, notes: null }) ?? "", /wajib/);
});

test("discovery identities support workstation and printer without a second inventory", () => {
  assert.ok(NETWORK_NODE_TYPES.includes("workstation"));
  assert.ok(NETWORK_NODE_TYPES.includes("printer"));
  assert.equal(validateNetworkNodeInput({ ip_address: "192.168.2.73", name: "Nurse Station B", device_type: "workstation", location: "Cathlab Lt.3", notes: null }), null);
});
