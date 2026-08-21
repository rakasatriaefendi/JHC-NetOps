import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { validateInspectionSession } from "../src/config.mjs";
import {
  buildInspectionContextInvocation,
  inspectionContextFailureCode,
  validateInspectionContext,
  validateInspectionScope,
} from "../src/device-inspector.mjs";
import {
  buildInspectionInvocation,
  parseInspectionTraceLine,
  runInspectionAgent,
  validateInspectionEvent,
  validateInspectorCapabilities,
} from "../src/wsl.mjs";
import { startHeartbeatLoop } from "../src/heartbeat.mjs";

const config = {
  runner_id: "test-runner",
  wsl_distro: "Ubuntu-22.04",
  agent_path: "/project/agent/.venv/bin/network-monitor",
};
const sessionId = "8b6386f1-a2ef-4c6d-87fd-682100bcdcec";

test("inspection session accepts only private structured targets", () => {
  const session = validateInspectionSession({
    inspection_id: sessionId, runner_id: "test-runner",
    target_ip: "192.168.188.50", authorization_source: "discovery",
  }, config);
  assert.equal(session.target_ip, "192.168.188.50");
  for (const target of ["8.8.8.8", "example.com", "192.168.1.1;whoami"])
    assert.throws(() => validateInspectionSession({ ...session, runner_id: "test-runner", target_ip: target }, config));
});

test("Windows helper invocation is fixed and only receives target IP", () => {
  const args = buildInspectionContextInvocation("192.168.188.50", "C:\\fixed\\get-device-inspection-context.ps1");
  assert.deepEqual(args, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    "C:\\fixed\\get-device-inspection-context.ps1", "-TargetIp", "192.168.188.50"]);
  assert.ok(!args.includes("-Command"));
});

test("Windows helper separates source-address and route CIM objects", () => {
  const script = readFileSync(new URL("../scripts/get-device-inspection-context.ps1", import.meta.url), "utf8");
  assert.match(script, /MSFT_NetIPAddress/);
  assert.match(script, /MSFT_NetRoute/);
  assert.match(script, /Get-NetIPConfiguration -InterfaceIndex \$source\.InterfaceIndex/);
  assert.doesNotMatch(script, /Get-NetIPConfiguration -InterfaceIndex \$route\.InterfaceIndex/);
  assert.match(script, /is_this_device/);
  assert.match(script, /interface_type/);
  assert.doesNotMatch(script, /192\.168\.112\.1/);
});

test("context helper failure is normalized without exposing PowerShell output", () => {
  assert.equal(inspectionContextFailureCode('{"ok":false,"error_code":"INSPECTION_NETWORK_CONTEXT_UNAVAILABLE"}'),
    "INSPECTION_NETWORK_CONTEXT_UNAVAILABLE");
  assert.equal(inspectionContextFailureCode("arbitrary failure text"), "INSPECTION_NETWORK_CONTEXT_UNAVAILABLE");
});

test("Device Inspector capabilities allow absent optional and unused tools", () => {
  const value = validateInspectorCapabilities({
    schema_version: 1, available: true, probe_engine: "python_socket", python_version: "3.12.13",
    required: { python_socket: true }, optional: { openssl: false, scapy_oui: true },
    available_but_unused: { nmap: false, curl: false },
    optional_not_required: { arp_scan: false, nbtscan: false, mdns: false },
  });
  assert.equal(value.available, true);
  assert.equal(value.available_but_unused.nmap, false);
  assert.equal(value.collectors.netbios_node_status, true);
});

test("routed context discards a supplied next-hop MAC", () => {
  const value = validateInspectionContext({ ok: true, context: {
    target_ip: "192.168.112.1", local_ip: "192.168.188.180", prefix_length: 24,
    default_gateway: "192.168.188.50", same_subnet: false, route_role: "routed",
    mac: "EC-75-0C-BE-85-50", reachable: true, is_this_device: false,
    interface_index: 20, interface_alias: "Wi-Fi", interface_description: "MediaTek Wi-Fi",
    interface_type: "physical",
  } }, "192.168.112.1");
  assert.equal(value.mac, null);
  assert.throws(() => validateInspectionScope({ authorization_source: "discovery" }, value));
  assert.equal(validateInspectionScope({ authorization_source: "inventory", target_ip: "192.168.112.1" }, value).route_role, "routed");
});

test("agent invocation has no shell, flags, ports, scripts, or arbitrary URI", () => {
  const session = { target_ip: "192.168.188.50" };
  const context = { route_role: "default_gateway", same_subnet: true, reachable: true,
    default_gateway: "192.168.188.50", mac: "EC:75:0C:BE:85:50", is_this_device: false,
    interface_index: 20, interface_alias: "Wi-Fi", interface_description: "MediaTek Wi-Fi",
    interface_type: "physical" };
  const args = buildInspectionInvocation(config, session, context);
  assert.ok(args.includes("device-inspect") && args.includes("192.168.188.50"));
  for (const unsafe of ["bash", "-A", "-p-", "--ports", "--nse", "--script", "http://"])
    assert.ok(!args.includes(unsafe));
});

test("self context is explicit and may describe a Windows virtual interface", () => {
  const value = validateInspectionContext({ ok: true, context: {
    target_ip: "192.168.112.1", local_ip: "192.168.112.1", prefix_length: 24,
    default_gateway: "192.168.188.50", same_subnet: true, route_role: "on_link",
    mac: null, reachable: true, is_this_device: true, interface_index: 42,
    interface_alias: "vEthernet (WSL)", interface_description: "Hyper-V Virtual Ethernet Adapter",
    interface_type: "virtual",
  } }, "192.168.112.1");
  assert.equal(value.is_this_device, true);
  assert.equal(value.interface_type, "virtual");
  const args = buildInspectionInvocation(config, { target_ip: "192.168.112.1" }, value);
  assert.ok(args.includes("--is-this-device") && args.includes("yes"));
  assert.ok(args.includes("--interface-type") && args.includes("virtual"));
});

test("runner accepts normalized result and rejects raw output or Internet IP", () => {
  const fingerprint = {
    ip: "192.168.188.50", likely_device_type: "router", confidence: "high",
    capabilities: ["gateway"], evidence: [{ source: "route", value: "default gateway" }],
  };
  assert.equal(validateInspectionEvent({ type: "result", fingerprint }).fingerprint.ip, "192.168.188.50");
  assert.throws(() => validateInspectionEvent({ type: "result", fingerprint: { ...fingerprint, stdout: "raw" } }));
  assert.throws(() => validateInspectionEvent({ type: "result", fingerprint: { ...fingerprint, ip: "8.8.8.8" } }));
  assert.equal(validateInspectionEvent({ type: "error", code: "INSPECTION_TIMEOUT", message: "Internal deadline reached" }).code, "INSPECTION_TIMEOUT");
});

test("inspection trace parser accepts only bounded allowlisted lifecycle fields", () => {
  const valid = parseInspectionTraceLine(`INSPECTION_TRACE ${JSON.stringify({
    phase: "collector_end", elapsed_ms: 120, collector_name: "upnp",
    status: "timeout", duration_ms: 100,
  })}`);
  assert.deepEqual(valid, {
    source: "agent", phase: "collector_end", elapsed_ms: 120,
    collector_name: "upnp", status: "timeout", duration_ms: 100,
  });
  for (const unsafe of [
    { phase: "collector_end", elapsed_ms: 1, payload: "raw body" },
    { phase: "collector_end", elapsed_ms: 1, token: "secret" },
    { phase: "unknown", elapsed_ms: 1 },
    { phase: "collector_end", elapsed_ms: 120_001 },
  ]) assert.equal(parseInspectionTraceLine(`INSPECTION_TRACE ${JSON.stringify(unsafe)}`), null);
  assert.equal(parseInspectionTraceLine(`INSPECTION_TRACE ${"x".repeat(600)}`), null);
  assert.equal(parseInspectionTraceLine("arbitrary WSL stderr"), null);
});

test("runner traces startup, normalized result, and WSL close without changing events", async () => {
  const traces = [];
  const events = [];
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      child.stderr.write(`INSPECTION_TRACE ${JSON.stringify({ phase: "cli_entry", elapsed_ms: 4 })}\n`);
      child.stdout.write(`${JSON.stringify({ type: "result", fingerprint: {
        ip: "192.168.188.50", likely_device_type: "unknown", confidence: "low",
        capabilities: [], evidence: [],
      } })}\n`);
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 0);
    });
    return child;
  };
  const context = { route_role: "on_link", same_subnet: true, reachable: true,
    default_gateway: null, mac: null, is_this_device: false, interface_index: 20,
    interface_alias: "Wi-Fi", interface_description: "Adapter", interface_type: "physical" };
  await runInspectionAgent(
    config, { target_ip: "192.168.188.50" }, context,
    async (event) => events.push(event), 1_000, spawnProcess, (record) => traces.push(record),
  );
  assert.equal(events.length, 1);
  assert.deepEqual(traces.map((record) => record.phase), [
    "wsl_spawn", "first_agent_output", "cli_entry", "normalized_result_received", "wsl_close",
  ]);
  assert.ok(traces.every((record) => !Object.hasOwn(record, "payload")));
});

test("runner bounds accepted agent trace records", async () => {
  const traces = [];
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      for (let index = 0; index < 200; index += 1) {
        child.stderr.write(`INSPECTION_TRACE ${JSON.stringify({ phase: "cli_entry", elapsed_ms: index })}\n`);
      }
      child.stdout.write(`${JSON.stringify({ type: "result", fingerprint: {
        ip: "192.168.188.50", likely_device_type: "unknown", confidence: "low",
        capabilities: [], evidence: [],
      } })}\n`);
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 0);
    });
    return child;
  };
  const context = { route_role: "on_link", same_subnet: true, reachable: true,
    default_gateway: null, mac: null, is_this_device: false, interface_index: 20,
    interface_alias: "Wi-Fi", interface_description: "Adapter", interface_type: "physical" };
  await runInspectionAgent(
    config, { target_ip: "192.168.188.50" }, context,
    async () => {}, 1_000, spawnProcess, (record) => traces.push(record),
  );
  assert.equal(traces.filter((record) => record.source === "agent").length, 128);
});

test("heartbeat continues during a simulated long asynchronous Inspector child", async () => {
  let heartbeats = 0;
  const stop = startHeartbeatLoop(async () => { heartbeats += 1; }, 10);
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setTimeout(() => {
      child.stdout.write(`${JSON.stringify({ type: "stage", stage: "services" })}\n`);
      child.stdout.write(`${JSON.stringify({ type: "result", fingerprint: {
        ip: "192.168.188.50", likely_device_type: "unknown", confidence: "low",
        capabilities: [], evidence: [],
      } })}\n`);
      child.stdout.end();
      child.emit("close", 0);
    }, 80);
    return child;
  };
  try {
    const context = { route_role: "on_link", same_subnet: true, reachable: true,
      default_gateway: null, mac: null, is_this_device: false, interface_index: 20,
      interface_alias: "Wi-Fi", interface_description: "Adapter", interface_type: "physical" };
    await runInspectionAgent(config, { target_ip: "192.168.188.50" }, context, async () => {}, 1_000, spawnProcess);
    assert.ok(heartbeats >= 3);
  } finally { stop(); }
});

test("Inspector returns partial within outer ceiling after scaled WSL startup overhead", async () => {
  let fingerprint = null;
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setTimeout(() => child.stdout.write(`${JSON.stringify({ type: "stage", stage: "services" })}\n`), 60);
    setTimeout(() => {
      child.stdout.write(`${JSON.stringify({ type: "result", fingerprint: {
        ip: "192.168.188.228", likely_device_type: "unknown", confidence: "unknown",
        capabilities: [], evidence: [], probe_summary: { partial: true, deadline_reached: true },
      } })}\n`);
      child.stdout.end();
      child.emit("close", 0);
    }, 220);
    return child;
  };
  const context = { route_role: "on_link", same_subnet: true, reachable: true,
    default_gateway: null, mac: null, is_this_device: false, interface_index: 20,
    interface_alias: "Wi-Fi", interface_description: "Adapter", interface_type: "physical" };
  const started = Date.now();
  await runInspectionAgent(config, { target_ip: "192.168.188.228" }, context, async (event) => {
    if (event.type === "result") fingerprint = event.fingerprint;
  }, 300, spawnProcess);
  assert.ok(Date.now() - started < 300);
  assert.equal(fingerprint?.probe_summary?.partial, true);
});

test("Inspector outer ceiling still kills a genuinely hung WSL child", async () => {
  let killed = false;
  const traces = [];
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      killed = true;
      child.stdout.end();
      child.stderr.end();
      queueMicrotask(() => child.emit("close", null));
      return true;
    };
    return child;
  };
  const context = { route_role: "on_link", same_subnet: true, reachable: true,
    default_gateway: null, mac: null, is_this_device: false, interface_index: 20,
    interface_alias: "Wi-Fi", interface_description: "Adapter", interface_type: "physical" };
  await assert.rejects(
    runInspectionAgent(
      config, { target_ip: "192.168.188.228" }, context, async () => {}, 50, spawnProcess,
      (record) => traces.push(record),
    ),
    (error) => error.code === "INSPECTION_TIMEOUT",
  );
  assert.equal(killed, true);
  assert.ok(traces.some((record) => record.phase === "outer_timeout"));
  assert.ok(traces.some((record) => record.phase === "wsl_close"));
  assert.ok(!traces.some((record) => record.phase === "normalized_result_received"));
});
