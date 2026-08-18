import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { validateInspectionSession } from "../src/config.mjs";
import {
  buildInspectionContextInvocation,
  inspectionContextFailureCode,
  validateInspectionContext,
  validateInspectionScope,
} from "../src/device-inspector.mjs";
import { buildInspectionInvocation, validateInspectionEvent, validateInspectorCapabilities } from "../src/wsl.mjs";

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
});
