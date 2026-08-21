import assert from "node:assert/strict";
import test from "node:test";
import { startHeartbeatLoop } from "../src/heartbeat.mjs";

import {
  buildDiscoveryContextInvocation,
  discoveryWorstCaseWallMs,
  runNetworkDiscovery,
  usableAddresses,
  validateDiscoveryContext,
} from "../src/network-discovery.mjs";

const rawContext = {
  ok: true,
  context: {
    connection_type: "wifi",
    interface_alias: "Wi-Fi",
    local_ipv4: "192.168.188.1",
    subnet_cidr: "192.168.188.0/30",
    prefix_length: 30,
    default_gateway: "192.168.188.2",
    neighbors: ["192.168.188.2", "192.168.188.2", "192.168.188.3", "10.0.0.1"],
  },
};

test("discovery helper has a fixed shell-free interface with no browser scope", () => {
  assert.deepEqual(buildDiscoveryContextInvocation("C:\\fixed\\get-discovery-context.ps1"), [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    "C:\\fixed\\get-discovery-context.ps1",
  ]);
});

test("synthetic /24 uses at most four workers and has a bounded worst case", async () => {
  const context = validateDiscoveryContext({ ok: true, context: {
    ...rawContext.context,
    local_ipv4: "192.168.188.1",
    subnet_cidr: "192.168.188.0/24",
    prefix_length: 24,
    default_gateway: "192.168.188.254",
    neighbors: [],
  } });
  let active = 0;
  let peak = 0;
  const started = Date.now();
  const result = await runNetworkDiscovery(context, async () => {}, {
    ping: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return { success: false, latency_ms: null };
    },
  });
  assert.equal(result.scanned_hosts, 254);
  assert.equal(peak, 4);
  assert.ok(Date.now() - started < 2_000);
  assert.equal(discoveryWorstCaseWallMs(254), 41_600);
});

test("runner accepts only its current bounded IPv4 subnet", () => {
  const context = validateDiscoveryContext(rawContext);
  assert.equal(context.subnet_cidr, "192.168.188.0/30");
  assert.equal(context.total_hosts, 2);
  assert.deepEqual(context.neighbors, ["192.168.188.2"]);
  assert.throws(() => validateDiscoveryContext({
    ...rawContext,
    context: { ...rawContext.context, subnet_cidr: "192.168.0.0/16", prefix_length: 16 },
  }), /authorized discovery limit/i);
  assert.throws(() => validateDiscoveryContext({
    ...rawContext,
    context: { ...rawContext.context, subnet_cidr: "10.0.0.0/24", prefix_length: 24 },
  }));
});

test("usable address generation excludes network and broadcast", () => {
  assert.deepEqual(usableAddresses("192.168.188.0/30"), ["192.168.188.1", "192.168.188.2"]);
});

test("neighbor and ICMP observations are deduplicated into bounded progressive results", async () => {
  const context = validateDiscoveryContext(rawContext);
  const updates = [];
  const result = await runNetworkDiscovery(context, async (progress) => updates.push(progress), {
    concurrency: 2,
    timeoutMs: 400,
    ping: async (ip) => ({ success: ip === "192.168.188.2", latency_ms: 1.25 }),
  });
  assert.equal(result.scanned_hosts, 2);
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].is_this_device, true);
  assert.equal(result.results[1].is_gateway, true);
  assert.deepEqual(result.results[1].evidence, ["icmp", "neighbor"]);
  assert.equal(result.results[1].latency_ms, 1.25);
  assert.ok(updates.length <= 2);
  assert.equal(updates.at(-1).scanned_hosts, 2);
});

test("heartbeat continues during a simulated long asynchronous Discovery", async () => {
  const context = validateDiscoveryContext(rawContext);
  let heartbeats = 0;
  const stop = startHeartbeatLoop(async () => { heartbeats += 1; }, 10);
  try {
    await runNetworkDiscovery(context, async () => {}, {
      ping: async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return { success: false, latency_ms: null };
      },
    });
    assert.ok(heartbeats >= 3);
  } finally { stop(); }
});
