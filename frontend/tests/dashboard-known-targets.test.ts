import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const { HEALTH_TARGET_PAGE_SIZE, healthTargetPagination } = await import("../lib/network-health-client.ts");

const dashboard = readFileSync(new URL("../components/dashboard/network-health-dashboard.tsx", import.meta.url), "utf8");
const map = readFileSync(new URL("../components/dashboard/reachability-map.tsx", import.meta.url), "utf8");
const manualPing = readFileSync(new URL("../components/dashboard/manual-ping-provider.tsx", import.meta.url), "utf8");
const networkControl = readFileSync(new URL("../app/actions/legacy-network-control.ts", import.meta.url), "utf8");

test("Other known targets reuses the single Manual Ping provider and target-id-only request", () => {
  assert.match(dashboard, /<ManualPingProvider targets=\{targets\} isAdmin=\{isAdmin\}>/);
  assert.match(dashboard, /title=\{t\("health\.otherTargets"\)\}[\s\S]*paginate showManualPing=\{isAdmin\}/);
  assert.match(dashboard, /<th className="p-3">\{t\("health\.columns\.action"\)\}<\/th>/);
  assert.match(dashboard, /manualPing\.run\(target\.id\)/);
  assert.match(map, /useManualPing\(\)/);
  assert.match(manualPing, /queueManualPingAction\(targetId\)/);
  assert.match(networkControl, /createPingJobLocal\(userId,[\s\S]*target_id: target/);
  assert.match(networkControl, /createPingJobLocal\(userId,[\s\S]*target_id: target/);
  assert.doesNotMatch(dashboard, /ip_address[^\n]*manual_ping|manual_ping[^\n]*ip_address/);
});

test("manual Ping blocks duplicate and unavailable requests before creating transient state", () => {
  const lookup = manualPing.indexOf("const target = targets.find((candidate) => candidate.id === targetId);");
  const guard = manualPing.indexOf("!isAdmin || !target?.manual_ping_available || inFlight.current.has(targetId)", lookup);
  const lock = manualPing.indexOf("inFlight.current.add(targetId)", lookup);
  const loading = manualPing.indexOf("phase: \"loading\"", lookup);
  const request = manualPing.indexOf("queueManualPingAction", lookup);
  assert.ok(lookup >= 0 && guard > lookup);
  assert.ok(lock > guard && loading > guard && request > guard);
  assert.match(dashboard, /disabled=\{!target\.manual_ping_available \|\| state\?\.phase === "loading"\}/);
  assert.match(dashboard, /t\(state\?\.phase === "loading" \? "health\.pinging" : "health\.ping"\)/);
  assert.match(dashboard, /t\("health\.pingUnavailable"\)/);
});

test("ten or fewer targets fit one page and eleven targets paginate", () => {
  assert.equal(HEALTH_TARGET_PAGE_SIZE, 10);
  assert.deepEqual(healthTargetPagination(10, 0), { page: 0, pageCount: 1, start: 0, end: 10 });
  assert.deepEqual(healthTargetPagination(11, 0), { page: 0, pageCount: 2, start: 0, end: 10 });
  assert.deepEqual(healthTargetPagination(11, 1), { page: 1, pageCount: 2, start: 10, end: 11 });
  assert.match(dashboard, /paginate && pagination\.pageCount > 1/);
});

test("Previous and Next stay bounded and a stale page index clamps after realtime data shrink", () => {
  assert.deepEqual(healthTargetPagination(27, -1), { page: 0, pageCount: 3, start: 0, end: 10 });
  assert.deepEqual(healthTargetPagination(27, 99), { page: 2, pageCount: 3, start: 20, end: 27 });
  assert.deepEqual(healthTargetPagination(11, 2), { page: 1, pageCount: 2, start: 10, end: 11 });
  assert.deepEqual(healthTargetPagination(3, 2), { page: 0, pageCount: 1, start: 0, end: 3 });
  assert.match(dashboard, /disabled=\{pagination\.page === 0\}/);
  assert.match(dashboard, /disabled=\{pagination\.page === pagination\.pageCount - 1\}/);
  assert.match(dashboard, /targets\.slice\(pagination\.start, pagination\.end\)/);
});
