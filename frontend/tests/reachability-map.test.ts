import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../components/dashboard/reachability-map.tsx", import.meta.url), "utf8");
const edgeFunction = readFileSync(new URL("../../supabase/functions/network-health/index.ts", import.meta.url), "utf8");

test("Reachability Map has one canonical custom edge and floating border geometry", () => {
  assert.equal((source.match(/function MonitoringEdge\(/g) ?? []).length, 1);
  assert.equal((source.match(/function RunnerNode\(/g) ?? []).length, 1);
  assert.equal((source.match(/function TargetNode\(/g) ?? []).length, 1);
  assert.equal((source.match(/export function ReachabilityMap\(/g) ?? []).length, 1);
  assert.equal((source.match(/edgeTypes=\{\{ monitoring: MonitoringEdge \}\}/g) ?? []).length, 1);
  assert.match(source, /<BaseEdge/);
  assert.match(source, /useInternalNode\(source\)/);
  assert.match(source, /getEdgeParams\(sourceInternal, targetInternal\)/);
  assert.match(source, /stroke: "currentColor"/);
  assert.doesNotMatch(source, /hsl\(var\(--/);
  assert.match(source, /className="opacity-0 pointer-events-none"/);
});

test("graph construction creates exactly one runner relationship per target", () => {
  assert.match(source, /targets\.forEach\(\(target, index\) => \{/);
  assert.match(source, /edges\.push\(\{[\s\S]*?id: `edge-\$\{target\.id\}`,[\s\S]*?source: `runner-\$\{runnerId \?\? "local"\}`,[\s\S]*?target: target\.id/);
  assert.doesNotMatch(source, /onConnect=/);
  assert.match(source, /nodesConnectable=\{false\}/);
});

test("scheduled and manual activity are transient without mutating persisted status", () => {
  assert.match(source, /lastCheckedRef = useRef<string \| undefined>\(data\?\.lastCheckedAt\)/);
  assert.match(source, /lastCheckedAt === lastCheckedRef\.current/);
  assert.match(source, /manualPingActivityToken/);
  assert.match(source, /requestAnimationFrame\(animate\)/);
  assert.match(source, /motionPath\.getTotalLength\(\)/);
  assert.match(source, /motionPath\.getPointAtLength\(distance\)/);
  assert.match(source, /activityRun === 0 \|\|\s*prefersReducedMotion \|\|/);
  assert.doesNotMatch(source, /set.*latest|network_health_latest/);
});

test("admin always sees manual ping with capability-aware disabled and loading states", () => {
  assert.match(source, /\{manualPing\.isAdmin \? \(/);
  assert.match(source, /disabled=\{!target\.manual_ping_available \|\| pingState\?\.phase === "loading"\}/);
  assert.match(source, /Manual ping unavailable/);
  assert.match(source, /pingState\?\.phase === "loading" \? "Pinging…" : "PING"/);
});

test("viewer has no manual ping action and enabled admin requests remain one-shot", () => {
  assert.doesNotMatch(source, /\{!manualPing\.isAdmin \? \(/);
  assert.match(source, /manualPingInFlight\.current\.has\(targetId\)/);
  assert.match(source, /body: \{ action: "manual_ping", target_id: targetId \}/);
  assert.match(source, /className="nodrag nopan/);
  assert.match(source, /Ping timeout|Tidak terjangkau/);
  assert.match(edgeFunction, /auth\.role !== "admin"/);
  assert.match(edgeFunction, /key !== "action" && key !== "target_id"/);
  assert.match(edgeFunction, /\.eq\("id", body\.target_id\)\.maybeSingle\(\)/);
});

test("unavailable manual ping returns before loading, edge activity, or backend invocation", () => {
  const targetLookup = source.indexOf("const target = targets.find((candidate) => candidate.id === targetId);");
  const availabilityGuard = source.indexOf("!target?.manual_ping_available", targetLookup);
  const inFlightMutation = source.indexOf("manualPingInFlight.current.add(targetId)", targetLookup);
  const loadingMutation = source.indexOf("phase: \"loading\"", targetLookup);
  const activityMutation = source.indexOf("manualPingActivityToken: Number", targetLookup);
  const backendInvocation = source.indexOf("supabase.functions.invoke", targetLookup);

  assert.ok(targetLookup >= 0);
  assert.ok(availabilityGuard > targetLookup);
  assert.ok(inFlightMutation > availabilityGuard);
  assert.ok(loadingMutation > availabilityGuard);
  assert.ok(activityMutation > availabilityGuard);
  assert.ok(backendInvocation > availabilityGuard);
});
