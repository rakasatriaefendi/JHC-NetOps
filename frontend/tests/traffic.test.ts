import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {filterFlows,isTrafficRunnerAvailable,mergeTrafficRunnerSnapshots,normalizeTrafficRunnerSnapshots,type TrafficFlow} from "../lib/traffic.ts";

const flow:TrafficFlow={flow_key:"a",src_ip:"10.0.0.1",dst_ip:"10.0.0.2",src_port:1200,dst_port:443,protocol:"tcp",service:"HTTPS (inferred)",first_seen:"2026-01-01T00:00:00Z",last_seen:"2026-01-01T00:00:01Z",total_bytes:10,packet_count:1,bytes_delta:10,packets_delta:1,packets_per_second:0.5,rate_mbps:1,peak_rate_mbps:1,rate_trend:"increasing",status:"active"};
test("flow filters combine search, protocol, and status",()=>{assert.equal(filterFlows([flow],"443","tcp","active").length,1);assert.equal(filterFlows([flow],"53","tcp","active").length,0);assert.equal(filterFlows([flow],"","udp","all").length,0)});

const now = Date.parse("2026-09-22T10:00:00.000Z");
const localRunner = (overrides: Record<string, unknown> = {}) => ({
  id: "it-lt8",
  display_name: "IT LT8 Runner",
  health_status: "online",
  last_seen_at: new Date(now - 3_000).toISOString(),
  capabilities: { targets: [], operations: ["traffic_live", "network_discovery"], traffic_durations_seconds: [300, 600] },
  ...overrides,
});

test("Traffic local runner normalization preserves authoritative liveness and capability", () => {
  const snapshots = normalizeTrafficRunnerSnapshots([localRunner()]);
  const [runner] = mergeTrafficRunnerSnapshots([], snapshots);
  assert.equal(isTrafficRunnerAvailable(runner, now), true);
  assert.equal(runner.id, "it-lt8");
  assert.deepEqual(runner.capabilities.traffic_durations_seconds, [300, 600]);
});

test("Traffic treats stale, degraded, and incapable local runners as unavailable", () => {
  const available = (value: Record<string, unknown>) => {
    const [runner] = mergeTrafficRunnerSnapshots([], normalizeTrafficRunnerSnapshots([value]));
    return isTrafficRunnerAvailable(runner, now);
  };
  assert.equal(available(localRunner({ last_seen_at: new Date(now - 30_001).toISOString() })), false);
  assert.equal(available(localRunner({ health_status: "degraded" })), false);
  assert.equal(available(localRunner({ health_status: "offline" })), false);
  assert.equal(available(localRunner({ capabilities: { targets: [], operations: ["network_discovery"] } })), false);
});

test("Traffic client refreshes authoritative local state and ignores shadow snapshots", () => {
  const component = readFileSync(new URL("../components/traffic/traffic-live-page.tsx", import.meta.url), "utf8");
  const action = readFileSync(new URL("../app/actions/traffic.ts", import.meta.url), "utf8");
  assert.match(component, /getTrafficRunnersAction/);
  assert.match(component, /runnerAuthority !== "local_postgres"\) return/);
  assert.match(component, /setState\(nextState\)/);
  assert.match(component, /transient refresh failure does not erase the last authoritative heartbeat/i);
  assert.match(component, /window\.setInterval[^]*10_000/);
  assert.match(action, /const authority = "local_postgres" as const;[\s\S]*localRunners\(\)/);
  assert.match(action, /normalizeTrafficRunnerSnapshots\(rows\)/);
  assert.doesNotMatch(component, /LOCAL_BACKEND_FRONTEND_TOKEN|localRunners|localApplicationRequest/);
});
