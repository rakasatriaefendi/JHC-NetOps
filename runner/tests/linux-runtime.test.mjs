import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { loadRunnerConfig } from "../src/config.mjs";
import { collectInspectionContext } from "../src/device-inspector.mjs";
import {
  buildLinuxDiscoveryPayload,
  checkTcpReadiness,
  collectLinuxDiagnosticContext,
  collectLinuxNetworkState,
  normalizeLinuxNetworkState,
  runBoundedJsonCommand,
} from "../src/linux-network-context.mjs";
import { collectDiscoveryContext, validateDiscoveryContext } from "../src/network-discovery.mjs";
import { buildPingInvocation, pingTarget } from "../src/network-health.mjs";
import { resolveNetworkScopes } from "../src/network-scope.mjs";
import { resolvePlatform } from "../src/platform.mjs";
import {
  buildAgentInvocation,
  buildInspectionInvocation,
  buildSnmpInvocation,
  buildTrafficInvocation,
  runInspectionAgent,
  runPreflight,
} from "../src/wsl.mjs";

const UUID = "11111111-1111-4111-8111-111111111111";

function rawLinuxState({ address = "192.168.50.130", prefix = 24 } = {}) {
  const network = prefix === 24 ? "192.168.50.0/24" : prefix === 23 ? "192.168.50.0/23" : "192.168.0.0/16";
  return {
    links: [
      { ifindex: 1, ifname: "lo", operstate: "UNKNOWN", flags: ["LOOPBACK", "UP", "LOWER_UP"], link_type: "loopback" },
      { ifindex: 2, ifname: "enp1s0", operstate: "UP", flags: ["BROADCAST", "UP", "LOWER_UP"], link_type: "ether" },
      { ifindex: 3, ifname: "wlp2s0", operstate: "DOWN", flags: ["BROADCAST", "MULTICAST"], link_type: "ether" },
      { ifindex: 4, ifname: "docker0", operstate: "DOWN", flags: ["BROADCAST", "MULTICAST", "UP"], link_type: "ether",
        linkinfo: { info_kind: "bridge" } },
    ],
    addresses: [
      { ifindex: 1, ifname: "lo", addr_info: [{ family: "inet", local: "127.0.0.1", prefixlen: 8 }] },
      { ifindex: 2, ifname: "enp1s0", addr_info: [{ family: "inet", local: address, prefixlen: prefix }] },
      { ifindex: 4, ifname: "docker0", addr_info: [{ family: "inet", local: "172.17.0.1", prefixlen: 16 }] },
    ],
    routes: [
      { dst: "default", gateway: "192.168.50.1", dev: "enp1s0", prefsrc: address, metric: 100 },
      { dst: network, dev: "enp1s0", prefsrc: address, metric: 100 },
      { dst: "172.17.0.0/16", dev: "docker0", prefsrc: "172.17.0.1" },
    ],
    neighbors: [
      { dst: "192.168.50.1", dev: "enp1s0", lladdr: "00:11:22:33:44:55", state: ["REACHABLE"] },
      { dst: "192.168.50.20", dev: "enp1s0", lladdr: "00:00:00:00:00:00", state: ["STALE"] },
      { dst: "172.17.0.2", dev: "docker0", lladdr: "02:42:ac:11:00:02", state: ["STALE"] },
    ],
  };
}

function normalizedState(options = {}) {
  return normalizeLinuxNetworkState(rawLinuxState(options), {
    isWirelessInterface: (name) => name === "wlp2s0",
  });
}

function fakeChild(onStart) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  queueMicrotask(() => onStart(child));
  return child;
}

test("platform selection supports only Windows and native Linux", () => {
  assert.equal(resolvePlatform("win32"), "win32");
  assert.equal(resolvePlatform("linux"), "linux");
  assert.throws(() => resolvePlatform("darwin"), (error) => error.code === "UNSUPPORTED_PLATFORM");
});

test("real Ubuntu link metadata is merged with address-only IPv4 records before scope selection", () => {
  const state = normalizedState();
  const payload = buildLinuxDiscoveryPayload(state);
  const context = validateDiscoveryContext(payload);
  const resolution = resolveNetworkScopes(payload.context.scope_inputs);
  const ethernet = state.interfaces.find((item) => item.interface_alias === "enp1s0");
  const wifi = state.interfaces.find((item) => item.interface_alias === "wlp2s0");
  const bridge = state.interfaces.find((item) => item.interface_alias === "docker0");
  const loopback = state.interfaces.find((item) => item.interface_alias === "lo");
  assert.deepEqual({ kind: ethernet.interface_kind, connection: ethernet.connection_type, status: ethernet.operational_status,
    addresses: ethernet.addresses }, { kind: "physical", connection: "ethernet", status: "up",
    addresses: [{ ip_address: "192.168.50.130", prefix_length: 24 }] });
  assert.deepEqual({ kind: wifi.interface_kind, connection: wifi.connection_type, status: wifi.operational_status,
    addresses: wifi.addresses }, { kind: "physical", connection: "wifi", status: "down", addresses: [] });
  assert.deepEqual({ kind: bridge.interface_kind, status: bridge.operational_status }, { kind: "virtual_internal", status: "down" });
  assert.equal(loopback.interface_kind, "virtual_internal");
  assert.equal(context.interface_alias, "enp1s0");
  assert.equal(context.connection_type, "ethernet");
  assert.equal(context.subnet_cidr, "192.168.50.0/24");
  assert.equal(context.default_gateway, "192.168.50.1");
  assert.equal(context.total_hosts, 254);
  assert.ok(resolution.exclusions.some((item) => item.source_interface === "lo" && item.reason === "virtual_internal_interface"));
  assert.ok(resolution.exclusions.some((item) => item.source_interface === "wlp2s0" && item.reason === "inactive_interface"));
  assert.ok(resolution.exclusions.some((item) => item.source_interface === "docker0"));
  assert.ok(resolution.exclusions.some((item) => item.reason === "default_route"));
  assert.deepEqual(context.neighbors.map((item) => item.ip), ["192.168.50.1", "192.168.50.20"]);
});

test("Linux context preserves non-/24 prefixes while Discovery stays bounded", () => {
  for (const fixture of [
    { address: "192.168.51.130", prefix: 23, cidr: "192.168.50.0/23" },
    { address: "192.168.50.130", prefix: 16, cidr: "192.168.0.0/16" },
  ]) {
    const context = validateDiscoveryContext(buildLinuxDiscoveryPayload(normalizedState(fixture)));
    assert.equal(context.prefix_length, fixture.prefix);
    assert.equal(context.subnet_cidr, fixture.cidr);
    assert.equal(context.total_hosts, 254);
  }
});

test("Linux OS provider uses bounded structured ip JSON commands without a shell", async () => {
  const raw = rawLinuxState();
  const calls = [];
  const spawnProcess = (executable, args, options) => fakeChild((child) => {
    calls.push({ executable, args, options });
    const key = args[2];
    child.stdout.end(JSON.stringify(key === "link" ? raw.links : key === "address" ? raw.addresses : key === "route" ? raw.routes : raw.neighbors));
    child.emit("close", 0);
  });
  const result = await collectLinuxNetworkState({ spawnProcess, isWirelessInterface: () => false });
  assert.equal(result.default_interface_index, 2);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((call) => call.args), [
    ["-j", "-d", "link", "show"],
    ["-j", "-4", "address", "show"],
    ["-j", "-4", "route", "show", "table", "main"],
    ["-j", "-4", "neighbor", "show"],
  ]);
  assert.ok(calls.every((call) => call.executable === "ip"));
  assert.ok(calls.every((call) => call.options.shell === false));
});

test("link/address merge requires matching stable interface index and safe name", () => {
  const raw = rawLinuxState();
  raw.addresses = raw.addresses.map((item) => item.ifindex === 2 ? { ...item, ifname: "renamed0" } : item);
  const state = normalizeLinuxNetworkState(raw, { isWirelessInterface: () => false });
  const ethernet = state.interfaces.find((item) => item.interface_alias === "enp1s0");
  assert.deepEqual(ethernet.addresses, []);
  assert.throws(() => buildLinuxDiscoveryPayload(state), (error) => error.code === "DISCOVERY_CONTEXT_UNAVAILABLE");
});

test("Linux command adapter rejects malformed output and kills a bounded timeout", async () => {
  await assert.rejects(
    runBoundedJsonCommand("ip", ["-j"], { spawnProcess: () => fakeChild((child) => {
      child.stdout.end("not-json"); child.emit("close", 0);
    }) }),
    (error) => error.code === "LINUX_CONTEXT_INVALID",
  );
  let child;
  await assert.rejects(
    runBoundedJsonCommand("ip", ["-j"], { timeoutMs: 10, spawnProcess: () => (child = fakeChild(() => {})) }),
    (error) => error.code === "LINUX_CONTEXT_UNAVAILABLE",
  );
  assert.equal(child.killed, true);
});

test("Linux Discovery and Inspector adapters consume the shared normalized contract without probing", async () => {
  const state = normalizedState();
  const discovery = await collectDiscoveryContext(undefined, { platform: "linux", collectLinuxState: async () => state });
  assert.equal(discovery.subnet_cidr, "192.168.50.0/24");
  const inspection = await collectInspectionContext("192.168.50.20", undefined, {
    platform: "linux",
    collectState: async () => state,
    ping: async () => ({ success: true, latency_ms: 0.5 }),
  });
  assert.equal(inspection.route_role, "on_link");
  assert.equal(inspection.interface_alias, "enp1s0");
  assert.equal(inspection.mac, null);
  assert.equal(inspection.reachable, true);
});

test("Linux diagnostic context preserves route data with injected non-network checks", async () => {
  const result = await collectLinuxDiagnosticContext({ id: "lab", host: "192.168.50.20", iperf_port: 5201 }, {
    collectState: async () => normalizedState(),
    lookup: async () => ({ address: "192.168.50.20", family: 4 }),
    dnsServers: ["192.168.50.1"],
    ping: async () => ({ success: true, latency_ms: 1.25 }),
    tcpReady: async () => false,
  });
  assert.equal(result.network_context.subnet_cidr, "192.168.50.0/24");
  assert.equal(result.route_context.route_type, "on_link");
  assert.equal(result.preflight.target.status, "responded");
  assert.equal(result.preflight.iperf.ready, false);
});

test("native config resolves agent and relocatable state paths, including project paths with spaces", () => {
  const example = JSON.parse(readFileSync(new URL("../config.example.json", import.meta.url), "utf8"));
  const directory = mkdtempSync(path.join(os.tmpdir(), "native runner config "));
  const configPath = path.join(directory, "config.json");
  writeFileSync(configPath, JSON.stringify({ ...example, native_project_root: "/opt/JHC NetOps/current",
    data_directory: "../shared/state", log_directory: "../shared/logs" }));
  const config = loadRunnerConfig(configPath, "linux");
  assert.equal(config.agent_path, "/opt/JHC NetOps/current/agent/.venv/bin/network-monitor");
  assert.equal(config.python_path, "/opt/JHC NetOps/current/agent/.venv/bin/python");
  assert.equal(config.data_directory, path.resolve(directory, "../shared/state"));
  assert.equal(config.log_directory, path.resolve(directory, "../shared/logs"));
  assert.equal(config.runtime_platform, "linux");
});

test("native agent builders omit WSL while the default Windows regression path stays unchanged", () => {
  const linux = { runtime_platform: "linux", runner_id: "native-runner", agent_path: "/opt/JHC NetOps/current/agent/.venv/bin/network-monitor", traffic_interface: "enp1s0" };
  const windows = { ...linux, runtime_platform: "win32", wsl_distro: "Ubuntu-22.04" };
  const job = { id: UUID, source_label: "Lab", connection_type: "ethernet", duration_seconds: 5,
    target: { host: "127.0.0.1", label: "Loopback", environment: "localhost_demo", iperf_port: 5201 } };
  const session = { id: UUID, duration_seconds: 300, target_ip: "192.168.50.20" };
  const context = { route_role: "on_link", same_subnet: true, reachable: true, is_this_device: false,
    interface_index: 2, interface_alias: "enp1s0", interface_description: "Linux ether interface", interface_type: "physical",
    default_gateway: "192.168.50.1", mac: null };
  const target = { id: UUID, node_id: UUID, ip_address: "192.168.50.20", credential_profile_ref: "fixture", snmp_version: "3", snmp_port: 161 };
  assert.equal(buildAgentInvocation(linux, job)[0], "diagnostic-run");
  assert.equal(buildTrafficInvocation(linux, session)[0], "traffic-live");
  assert.equal(buildInspectionInvocation(linux, session, context)[0], "device-inspect");
  assert.equal(buildSnmpInvocation(linux, target, { version: "3" })[0], "managed-telemetry-poll");
  assert.deepEqual(buildAgentInvocation(windows, job).slice(0, 5), ["-d", "Ubuntu-22.04", "--exec", windows.agent_path, "diagnostic-run"]);
});

test("native Device Inspector spawns the configured executable directly and skips WSL readiness", async () => {
  const calls = [];
  const config = { runtime_platform: "linux", agent_path: "/opt/JHC NetOps/current/agent/.venv/bin/network-monitor" };
  const context = { route_role: "on_link", same_subnet: true, reachable: true, is_this_device: false,
    interface_index: 2, interface_alias: "enp1s0", interface_description: "Linux ether interface", interface_type: "physical",
    default_gateway: "192.168.50.1", mac: null };
  await runInspectionAgent(config, { target_ip: "192.168.50.20" }, context, async () => {}, 100, (executable, args, options) => {
    calls.push({ executable, args, options });
    return fakeChild((child) => { child.stdout.end(); child.stderr.end(); child.emit("close", 0); });
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, config.agent_path);
  assert.equal(calls[0].args[0], "device-inspect");
  assert.equal(calls[0].options.shell, false);
});

test("Linux ping uses fixed arguments and normalizes iputils output", async () => {
  const invocation = buildPingInvocation("192.168.50.20", 400, "linux");
  assert.equal(invocation.executable, "ping");
  assert.deepEqual(invocation.args, ["-4", "-n", "-c", "1", "-W", "1", "192.168.50.20"]);
  assert.equal(invocation.options.shell, false);
  const result = await pingTarget("192.168.50.20", 400, undefined, () => fakeChild((child) => {
    child.stdout.end("64 bytes from 192.168.50.20: icmp_seq=1 ttl=64 time=0.742 ms\n");
    child.emit("close", 0);
  }), "linux");
  assert.deepEqual(result, { success: true, latency_ms: 0.742 });
  assert.throws(() => buildPingInvocation("192.168.50.20;id", 400, "linux"));
});

test("native preflight keeps optional diagnostics unavailable without taking down the runner", () => {
  const oldUrl = process.env.SUPABASE_URL;
  const oldKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = "https://fixture.invalid";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fixture-value-not-logged";
  const inspector = { schema_version: 1, available: true, probe_engine: "python_socket", python_version: "3.12",
    required: { python_socket: true }, optional: { openssl: true }, available_but_unused: {}, optional_not_required: {} };
  const calls = [];
  const config = { runtime_platform: "linux", python_path: "/opt/app/agent/.venv/bin/python",
    agent_path: "/opt/app/agent/.venv/bin/network-monitor", traffic_interface: "enp1s0", enable_manual_ping: true };
  try {
    const result = runPreflight(config, (executable, args, options) => {
      calls.push({ executable, args, options });
      if (executable === config.python_path && args[0] === "--version") return { status: 0, stdout: "Python 3.12.3\n", stderr: "" };
      if (executable === config.agent_path && args[0] === "capabilities") return { status: 0, stdout: JSON.stringify(inspector), stderr: "" };
      if (executable === "iperf3") return { status: null, stdout: "", stderr: "", error: { code: "ENOENT" } };
      return { status: 0, stdout: "tool version\n", stderr: "" };
    });
    assert.equal(result.platform, "linux");
    assert.equal(result.linux_network_context, true);
    assert.equal(result.ping, true);
    assert.equal(result.iperf3, null);
    assert.equal(result.diagnostics, false);
    assert.equal(result.traffic, true);
    assert.ok(result.operations.includes("network_discovery"));
    assert.ok(!result.operations.includes("bandwidth_and_path"));
    assert.ok(calls.every((call) => call.options.shell === false));
    assert.ok(calls.some((call) => call.executable === "ip" && call.args[0] === "-V"));

    const withoutPing = runPreflight(config, (executable, args) => {
      if (executable === config.python_path && args[0] === "--version") return { status: 0, stdout: "Python 3.12.3\n", stderr: "" };
      if (executable === config.agent_path && args[0] === "capabilities") return { status: 0, stdout: JSON.stringify(inspector), stderr: "" };
      if (executable === "ping") return { status: null, stdout: "", stderr: "", error: { code: "ENOENT" } };
      if (executable === "iperf3") return { status: 0, stdout: "iperf 3.21\n", stderr: "" };
      return { status: 0, stdout: "tool version\n", stderr: "" };
    });
    assert.equal(withoutPing.ping, false);
    assert.ok(!withoutPing.operations.includes("network_discovery"));
    assert.ok(!withoutPing.operations.includes("manual_ping"));
    assert.equal(withoutPing.diagnostics, true);
  } finally {
    if (oldUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = oldUrl;
    if (oldKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = oldKey;
  }
});

test("TCP readiness handles a missing or synchronously failing optional socket safely", async () => {
  assert.equal(await checkTcpReadiness("192.168.50.20", 5201, 10, () => { throw new Error("fixture"); }), false);
  assert.equal(await checkTcpReadiness("not-an-ip", 5201), false);
});
