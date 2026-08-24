import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { publicCapabilities, validateJob, validatePreflightRequest, validateTrafficSession } from "../src/config.mjs";
import { assertWslInvocation, buildAgentInvocation, buildTrafficInvocation, validateAgentEvent, validateTrafficEvent } from "../src/wsl.mjs";
import { buildNetworkContextInvocation, validateNetworkProbe } from "../src/network-context.mjs";
import { startHeartbeatLoop } from "../src/heartbeat.mjs";
import { backendFailureMessage } from "../src/backend.mjs";

const config = {
  runner_id: "test-runner",
  wsl_distro: "Ubuntu-22.04",
  wsl_project_root: "/mnt/c/project",
  agent_path: "/mnt/c/project/agent/.venv/bin/network-monitor",
  enable_diagnostic_demo: true,
  source_locations: ["IT Office"],
  durations: [5, 10],
  traffic_interface: "eth0",
  traffic_durations_seconds: [300, 600],
  targets: [{ id: "local", label: "Local TEST", host: "127.0.0.1", iperf_port: 5201, environment: "localhost_demo" }],
};

const rawJob = {
  id: "8b6386f1-a2ef-4c6d-87fd-682100bcdcec",
  runner_id: "test-runner",
  type: "bandwidth_and_path",
  source_label: "IT Office",
  target_id: "local",
  target_host: "attacker.invalid",
  target_label: "tampered",
  connection_type: "wifi",
  duration_seconds: 5,
  environment: "localhost_demo",
};

test("job target is resolved from the local allow-list", () => {
  const job = validateJob(rawJob, config);
  assert.equal(job.target.host, "127.0.0.1");
  const invocation = buildAgentInvocation(config, job);
  assert.equal(invocation[0], "-d");
  assert.ok(invocation.includes("--exec"));
  assert.ok(invocation.includes("127.0.0.1"));
  assert.ok(!invocation.includes("attacker.invalid"));
  assert.ok(!invocation.includes("bash"));
});

test("human source is accepted while invalid target, duration, and connection are rejected", () => {
  assert.equal(validateJob({ ...rawJob, source_label: "Ruang B" }, config).source_label, "Ruang B");
  for (const change of [
    { target_id: "unknown" },
    { duration_seconds: 60 },
    { connection_type: "auto" },
  ]) assert.throws(() => validateJob({ ...rawJob, ...change }, config));
});

test("capabilities expose only controlled fields", () => {
  assert.deepEqual(publicCapabilities(config).operations, ["bandwidth_and_path", "traffic_live", "network_discovery", "device_inspect"]);
  assert.equal(publicCapabilities(config).targets[0].host, "127.0.0.1");
});

test("production capabilities hide localhost and Local Development", () => {
  const production = { ...config, enable_diagnostic_demo: false };
  assert.deepEqual(publicCapabilities(production).targets, []);
  assert.deepEqual(publicCapabilities(production).source_locations, ["IT Office"]);
  assert.deepEqual(publicCapabilities(production).durations, [5, 10]);
});

test("network collector invocation is fixed and only receives the locally authorized target", () => {
  const target = config.targets[0];
  const args = buildNetworkContextInvocation(target, "C:\\fixed\\get-network-context.ps1");
  assert.deepEqual(args.slice(0, 6), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "C:\\fixed\\get-network-context.ps1"]);
  assert.deepEqual(args.slice(-4), ["-TargetHost", "127.0.0.1", "-TargetPort", "5201"]);
  assert.equal(validatePreflightRequest({ request_id: rawJob.id, runner_id: config.runner_id, target_id: target.id }, config).target.host, "127.0.0.1");
  assert.throws(() => validatePreflightRequest({ request_id: rawJob.id, runner_id: config.runner_id, target_id: "unknown" }, config));
});

test("network context follows the selected Windows target route and rejects tampering", () => {
  const target = config.targets[0];
  const probe = {
    ok: true,
    network_context: { host_name:"PC", interface_alias:"Wi-Fi", interface_description:"Wireless", connection_type:"wifi", operational_status:"up", local_ipv4:"192.168.1.20", prefix_length:24, subnet_mask:"255.255.255.0", subnet_cidr:"192.168.1.0/24", default_gateway:"192.168.1.1", dns_servers:["192.168.1.1"], link_speed_mbps:866 },
    route_context: { target_host:"127.0.0.1", resolved_target_ip:"127.0.0.1", route_type:"on_link", source_ip:"127.0.0.1", interface_alias:"Loopback", interface_index:1, next_hop:null, route_metric:1 },
    preflight: { checked_at:"2026-08-12T00:00:00Z", interface_detected:true, route_resolved:true, gateway:null, target:{status:"responded",latency_ms:0}, iperf:{ready:true,port:5201} },
  };
  const result = validateNetworkProbe(probe, target);
  assert.equal(result.network_context.connection_type, "wifi");
  assert.equal(result.route_context.target_id, "local");
  assert.throws(() => validateNetworkProbe({ ...probe, route_context: { ...probe.route_context, target_host: "attacker.invalid" } }, target));
  const routedEthernet = {
    ...probe,
    network_context: { ...probe.network_context, interface_alias:"Ethernet", interface_description:"Realtek", connection_type:"ethernet", link_speed_mbps:1000 },
    route_context: { ...probe.route_context, target_host:"10.10.4.253", resolved_target_ip:"10.10.4.253", source_ip:"192.168.1.20", interface_alias:"Ethernet", interface_index:16, route_type:"routed", next_hop:"192.168.1.1", route_metric:25 },
    preflight: { ...probe.preflight, gateway:{status:"responded",latency_ms:1.2}, target:{status:"no_response",latency_ms:null} },
  };
  const lanTarget = { ...target, host:"10.10.4.253" };
  const routedResult = validateNetworkProbe(routedEthernet, lanTarget);
  assert.equal(routedResult.network_context.connection_type, "ethernet");
  assert.equal(routedResult.route_context.route_type, "routed");
  assert.equal(routedResult.route_context.next_hop, "192.168.1.1");
  assert.equal(routedResult.preflight.target.status, "no_response");
  assert.throws(() => validateNetworkProbe({ ...routedEthernet, route_context: null }, lanTarget));
});

test("traffic invocation is root, structured, bounded, and cannot inject a filter", () => {
  const session = validateTrafficSession({ id: rawJob.id, runner_id: "test-runner", duration_seconds: 300 }, config);
  const invocation = buildTrafficInvocation(config, session);
  assert.deepEqual(invocation.slice(2, 6), ["--user", "root", "--exec", config.agent_path]);
  assert.ok(invocation.includes("eth0"));
  assert.ok(!invocation.includes("bash") && !invocation.includes("--filter"));
  assert.throws(() => validateTrafficSession({ ...session, runner_id: "test-runner", duration_seconds: 999 }, config));
  assert.equal(validateTrafficEvent({ type: "complete", session_id: rawJob.id }).session_id, rawJob.id);
});

test("normalized interval is accepted and raw iperf data is discarded", () => {
  const event = validateAgentEvent({
    type: "interval", direction: "upload", second: 1, mbps: 10,
    average_mbps: 9, peak_mbps: 10, minimum_mbps: 8,
    transferred_mb: 1.2, retransmits: 0, raw: { secret: true },
  });
  assert.equal(event.mbps, 10);
  assert.equal("raw" in event, false);
});

test("unknown protocol event and unsafe agent error are rejected", () => {
  assert.throws(() => validateAgentEvent({ type: "raw-iperf", data: {} }));
  assert.throws(() => validateAgentEvent({ type: "error", code: "ARBITRARY", message: "x" }));
});

test("heartbeat continues independently while a job-sized task is pending", async () => {
  let calls = 0;
  let resolveThirdCall;
  const thirdCall = new Promise((resolve) => {
    resolveThirdCall = resolve;
  });
  const stop = startHeartbeatLoop(async () => {
    calls += 1;
    if (calls === 3) resolveThirdCall();
  }, 10);
  try {
    await Promise.race([
      thirdCall,
      new Promise((_, reject) => setTimeout(() => reject(new Error("heartbeat timeout")), 500)),
    ]);
    assert.ok(calls >= 3);
  } finally {
    stop();
  }
});

test("backend failures expose bounded safe details without multiline log injection", () => {
  assert.equal(
    backendFailureMessage("Backend", 400, { error: "Runner operations are invalid\r\nforged log" }),
    "Backend request failed with HTTP 400: Runner operations are invalid  forged log",
  );
  assert.equal(backendFailureMessage("Backend", 503, {}), "Backend request failed with HTTP 503");
});

test("WSL preflight distinguishes genuine missing project executable", () => {
  assert.throws(
    () => assertWslInvocation({ status: 1, stdout: "", stderr: "wsl: Failed to translate 'D:\\VM\\bin\\'" }, "AGENT_VENV_MISSING", { pathCheck: true }),
    (error) => error.code === "AGENT_VENV_MISSING",
  );
});

test("WSL preflight classifies invocation timeout separately", () => {
  assert.throws(
    () => assertWslInvocation({ status: null, error: { code: "ETIMEDOUT" }, stdout: "", stderr: "" }, "AGENT_VENV_MISSING", { pathCheck: true }),
    (error) => error.code === "WSL_INVOCATION_TIMEOUT",
  );
});

test("WSL preflight classifies runtime failure separately without exposing stderr", () => {
  assert.throws(
    () => assertWslInvocation({ status: 1, stdout: "", stderr: "mount failed: sensitive path" }, "AGENT_VENV_MISSING", { pathCheck: true }),
    (error) => error.code === "WSL_RUNTIME_FAILED" && !error.message.includes("sensitive"),
  );
});

test("WSL preflight preserves existing command-specific missing-tool classifications", () => {
  assert.throws(
    () => assertWslInvocation({ status: 1, stdout: "", stderr: "missing executable" }, "IPERF3_MISSING"),
    (error) => error.code === "IPERF3_MISSING",
  );
});

test("heartbeat backend accepts the narrow WSL preflight classifications", () => {
  const source = readFileSync(new URL("../../supabase/functions/diagnostic-jobs/index.ts", import.meta.url), "utf8");
  assert.match(source, /"WSL_INVOCATION_TIMEOUT"/);
  assert.match(source, /"WSL_RUNTIME_FAILED"/);
});
