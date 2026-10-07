import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../components/dashboard/reachability-map.tsx", import.meta.url), "utf8");
const manualPingSource = readFileSync(new URL("../components/dashboard/manual-ping-provider.tsx", import.meta.url), "utf8");
const legacyNetworkControl = readFileSync(new URL("../app/actions/legacy-network-control.ts", import.meta.url), "utf8");

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
  assert.match(source, /t\("map\.pingUnavailable"\)/);
  assert.match(source, /t\(pingState\?\.phase === "loading" \? "map\.pinging" : "map\.ping"\)/);
});

test("viewer has no manual ping action and enabled admin requests remain one-shot", () => {
  assert.doesNotMatch(source, /\{!manualPing\.isAdmin \? \(/);
  assert.match(manualPingSource, /inFlight\.current\.has\(targetId\)/);
  assert.match(manualPingSource, /queueManualPingAction/);
  assert.match(source, /className="nodrag nopan/);
  assert.match(source, /\{manualPing\.isAdmin \? \(/);
  assert.match(manualPingSource, /if \(!isAdmin \|\| !target\?\.manual_ping_available \|\| inFlight\.current\.has\(targetId\)\) return;/);
  const requestStart = manualPingSource.indexOf("const run = useCallback(async (targetId: string) => {");
  const requestEnd = manualPingSource.indexOf("}, [isAdmin", requestStart);
  assert.ok(requestStart >= 0 && requestEnd > requestStart);
  const request = manualPingSource.slice(requestStart, requestEnd);
  assert.equal((request.match(/await queueManualPingAction\(targetId\)/g) ?? []).length, 1);
  assert.equal((manualPingSource.match(/\bqueueManualPingAction\(/g) ?? []).length, 1);
  assert.ok(request.indexOf("inFlight.current.has(targetId)") < request.indexOf("inFlight.current.add(targetId)"));
  assert.ok(request.indexOf("inFlight.current.add(targetId)") < request.indexOf("await queueManualPingAction(targetId)"));
  assert.match(request, /finally\s*\{\s*inFlight\.current\.delete\(targetId\);\s*\}/);
  assert.equal((request.match(/\bnotify\(/g) ?? []).length, 1);
  assert.equal((manualPingSource.match(/\bnotify\(/g) ?? []).length, 1);
  assert.match(request, /notify\("ping", outcome\.phase === "success"\)/);
  assert.ok(request.indexOf("await waitForManualPingLocal(pingId)") < request.indexOf('notify("ping",'));
  assert.match(manualPingSource, /useTranslation\("common"\)/);
  assert.match(manualPingSource, /t\(job\.result\.category === "timeout" \? "manualPing\.timeout" : "manualPing\.unreachable"\)/);
  type Catalog = { manualPing: { timeout: string; unreachable: string } };
  const en: Catalog = JSON.parse(readFileSync(new URL("../i18n/en/common.json", import.meta.url), "utf8"));
  const id: Catalog = JSON.parse(readFileSync(new URL("../i18n/id/common.json", import.meta.url), "utf8"));
  assert.equal(en.manualPing.timeout, "Ping timeout");
  assert.equal(en.manualPing.unreachable, "Unreachable");
  assert.equal(id.manualPing.timeout, "Ping timeout");
  assert.equal(id.manualPing.unreachable, "Tidak terjangkau");
  assert.match(legacyNetworkControl, /await requireAdminProfile\(\)/);
  assert.match(legacyNetworkControl, /createPingJobLocal\(userId,[\s\S]*target_id: target/);
  assert.doesNotMatch(legacyNetworkControl, /requested_by|ip_address|ping_count|timeout_ms/);
});

test("unavailable manual ping returns before loading, edge activity, or backend invocation", () => {
  const targetLookup = manualPingSource.indexOf("const target = targets.find((candidate) => candidate.id === targetId);");
  const availabilityGuard = manualPingSource.indexOf("!target?.manual_ping_available", targetLookup);
  const inFlightMutation = manualPingSource.indexOf("inFlight.current.add(targetId)", targetLookup);
  const loadingMutation = manualPingSource.indexOf("phase: \"loading\"", targetLookup);
  const activityMutation = manualPingSource.indexOf("setActivityTokens", targetLookup);
  const backendInvocation = manualPingSource.indexOf("queueManualPingAction", targetLookup);

  assert.ok(targetLookup >= 0);
  assert.ok(availabilityGuard > targetLookup);
  assert.ok(inFlightMutation > availabilityGuard);
  assert.ok(loadingMutation > availabilityGuard);
  assert.ok(activityMutation > availabilityGuard);
  assert.ok(backendInvocation > availabilityGuard);
});
