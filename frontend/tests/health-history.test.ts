import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { HEALTH_HISTORY_MAX_TARGETS, HealthHistoryController, healthChartPoints, healthMetricState,
  healthHistoryDefaultTarget, healthHistorySelection, historyFailure, historyKey,
  parseHealthHistory, validHistorySelection, type HealthHistoryResult, type HealthHistorySample } from "../lib/health-history.ts";
import type { HealthTrendRange } from "../lib/network-health-client.ts";

const TARGET = "10000000-0000-4000-8000-000000000001";
const OTHER = "20000000-0000-4000-8000-000000000002";
const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
function sample(id = TARGET, latency: number | null = 2, loss = 0): HealthHistorySample {
  return { target_id: id, sampled_at: "2026-10-09T08:14:00.000Z", status: latency === null ? "offline" : "online",
    latency_ms: latency, packet_loss_percent: loss, sample_count: 5, observation_count: 1,
    latency_observation_count: latency === null ? 0 : 1, latency_min_ms: latency, latency_max_ms: latency,
    packet_loss_min_percent: loss, packet_loss_max_percent: loss,
    first_sample_at: "2026-10-09T08:14:00.000Z", last_sample_at: "2026-10-09T08:14:00.000Z" };
}
function result(ids = [TARGET], range: HealthTrendRange = "1h"): HealthHistoryResult {
  return parseHealthHistory({ target_ids: ids, range, from: "2026-10-09T07:15:30.000Z", to: "2026-10-09T08:15:30.000Z",
    bucket_seconds: { "1h": 60, "6h": 120, "24h": 360, "7d": 1260 }[range], samples: ids.map((id) => sample(id)) }, ids, range);
}
function deferred() {
  let finish: (value: HealthHistoryResult) => void = () => {};
  const promise = new Promise<HealthHistoryResult>((resolve) => { finish = resolve; });
  return { promise, finish };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

test("single-point, offline/null latency, and 0% packet loss remain actual evidence", () => {
  const measured = [sample()];
  assert.equal(healthMetricState(measured, "latency"), "ready");
  assert.equal(healthMetricState(measured, "loss"), "ready");
  assert.equal(healthChartPoints(measured).length, 1);
  assert.equal(healthChartPoints(measured)[0]![`loss_${TARGET}`], 0);
  const offline = [sample(TARGET, null, 100)];
  assert.equal(healthMetricState(offline, "latency"), "metric_unavailable");
  assert.equal(healthMetricState(offline, "loss"), "ready");
  assert.equal(healthChartPoints(offline)[0]![`latency_${TARGET}`], null);
  assert.equal(healthMetricState([], "latency"), "empty");
});

test("response parser separates empty/error, rejects fabricated/malformed/out-of-scope rows, and sorts deterministically", () => {
  assert.equal(result().error, false);
  assert.equal(result().data[0]!.packet_loss_percent, 0);
  assert.equal(historyFailure("secret backend text").code, "HEALTH_HISTORY_QUERY_FAILED");
  const payload = { target_ids: [TARGET, OTHER], range: "1h", from: "2026-10-09T07:15:30.000Z",
    to: "2026-10-09T08:15:30.000Z", bucket_seconds: 60, samples: [sample(OTHER), sample(TARGET)] };
  assert.deepEqual(parseHealthHistory(payload, [TARGET, OTHER], "1h").data.map((row) => row.target_id), [TARGET, OTHER]);
  assert.deepEqual(parseHealthHistory({ ...payload, samples: [] }, [TARGET, OTHER], "1h").data, []);
  for (const row of [{ ...sample(), latency_ms: "bad" }, { ...sample(), packet_loss_percent: null },
    { ...sample(), target_id: "invalid" }, { ...sample(), first_sample_at: "2025-01-01T00:00:00Z" }]) {
    assert.equal(parseHealthHistory({ ...payload, samples: [row] }, [TARGET, OTHER], "1h").error, true);
  }
  assert.equal(parseHealthHistory({ ...payload, samples: Array.from({ length: 123 }, () => sample()) }, [TARGET, OTHER], "1h").code,
    "HEALTH_HISTORY_RESPONSE_TOO_LARGE");
  assert.equal(parseHealthHistory(payload, [TARGET], "1h").error, true);
});

test("chart points retain UTC order, null gaps, and never invent timestamps or mutate source samples", () => {
  const rows = [sample(OTHER), { ...sample(), sampled_at: "2026-10-09T08:13:00.000Z" }];
  const before = structuredClone(rows);
  const points = healthChartPoints(rows);
  assert.deepEqual(rows, before);
  assert.deepEqual(points.map((point) => point.time), ["2026-10-09T08:13:00.000Z", "2026-10-09T08:14:00.000Z"]);
  assert.equal(points[0]![`latency_${OTHER}`], null);
  assert.equal(points[1]![`loss_${TARGET}`], null);
});

test("a removed selected target fails closed instead of displaying a different target's history", () => {
  assert.deepEqual(healthHistorySelection([TARGET, OTHER], TARGET), { missing: false, ids: [TARGET] });
  assert.deepEqual(healthHistorySelection([OTHER], TARGET), { missing: true, ids: [] });
  assert.deepEqual(healthHistorySelection([TARGET, OTHER], "__all__"), { missing: false, ids: [TARGET, OTHER] });
  assert.deepEqual(healthHistorySelection([], "__all__"), { missing: false, ids: [] });
});

test("20 targets allow all, 21 default to one without truncating individual choices, and zero is empty", async () => {
  const ids = Array.from({ length: 21 }, (_, index) => `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
  const twenty = ids.slice(0, 20);
  assert.equal(HEALTH_HISTORY_MAX_TARGETS, 20);
  assert.equal(healthHistoryDefaultTarget(twenty), "__all__");
  assert.deepEqual(healthHistorySelection(twenty, "__all__").ids, twenty);
  assert.equal(validHistorySelection(twenty, "1h"), true);
  assert.equal(validHistorySelection(ids, "1h"), false);
  assert.equal(healthHistoryDefaultTarget([...ids].reverse()), ids[0]);
  const selection = healthHistorySelection(ids, "__all__");
  assert.deepEqual(selection, { missing: false, ids: [ids[0]] });
  for (const id of ids) assert.deepEqual(healthHistorySelection(ids, id), { missing: false, ids: [id] });
  assert.equal(healthHistoryDefaultTarget([]), "__all__");
  assert.deepEqual(healthHistorySelection([], "__all__"), { missing: false, ids: [] });
  assert.equal(validHistorySelection([], "1h"), true);

  const calls: string[][] = [];
  const seed = result(selection.ids);
  const controller = new HealthHistoryController(async (selected, range) => {
    calls.push(selected); return result(selected, range);
  }, ids, seed);
  controller.update(selection.ids, "1h", seed, ids); await flush();
  assert.equal(calls.length, 0, "reuse the valid single-target SSR seed");
  assert.equal(controller.getSnapshot().result.error, false);
  const empty = new HealthHistoryController(async (selected, range) => {
    calls.push(selected); return result(selected, range);
  }, [], result([]));
  empty.update([], "1h", result([]), []); await flush();
  assert.deepEqual(empty.getSnapshot().result.data, []);
  assert.equal(empty.refresh(), false);
  assert.equal(calls.length, 0);
  const chart = source("../components/dashboard/network-health-trends.tsx");
  assert.match(chart, /allTargetsAllowed = allIds\.length <= HEALTH_HISTORY_MAX_TARGETS/);
  assert.match(chart, /allTargetsAllowed \? <option value="__all__"/);
  assert.match(chart, /targets\.map\(\(target\) => <option/);
  assert.match(chart, /value=\{effectiveTargetId\}/);
  assert.match(chart, /!allTargetsAllowed.*trends\.allTargetsLimit/);
});

test("SSR and client agree for 0, 1, 20, 21 and 25 enabled targets and reuse initial history without fetching twice", async () => {
  for (const count of [0, 1, 20, 21, 25]) {
    const enabledIds = Array.from({ length: count }, (_, index) =>
      `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`).reverse();
    const before = [...enabledIds];
    const ssrIds = healthHistorySelection(enabledIds, "__all__").ids;
    const sortedIds = [...enabledIds].sort();
    const clientIds = healthHistorySelection(sortedIds, healthHistoryDefaultTarget(sortedIds)).ids;
    assert.equal(validHistorySelection(ssrIds, "1h"), true);
    assert.equal(ssrIds.length, count <= 20 ? count : 1);
    assert.equal(historyKey(ssrIds, "1h"), historyKey(clientIds, "1h"));
    if (count > 20) {
      assert.deepEqual(ssrIds, [sortedIds[0]]);
      assert.notEqual(healthHistoryDefaultTarget(sortedIds), "__all__");
    }
    for (const id of enabledIds) assert.deepEqual(healthHistorySelection(enabledIds, id).ids, [id]);
    const initial: HealthHistoryResult = count ? result(ssrIds)
      : { data: [], error: false, code: "OK", metadata: null };
    let calls = 0;
    const controller = new HealthHistoryController(async (ids, range) => {
      calls++; return result(ids, range);
    }, sortedIds, initial);
    assert.equal(controller.getSnapshot().key, historyKey(clientIds, "1h"));
    assert.equal(controller.getSnapshot().loading, false);
    assert.equal(controller.getSnapshot().result, initial);
    controller.update(clientIds, "1h", initial, sortedIds);
    controller.update(clientIds, "1h", structuredClone(initial), sortedIds); await flush();
    assert.equal(calls, 0, `${count} targets must reuse the SSR seed`);
    assert.equal(controller.getSnapshot().result.error, false);
    assert.deepEqual(enabledIds, before);
  }
  const page = source("../app/(protected)/dashboard/page.tsx");
  assert.match(page, /healthHistorySelection\(health\.data\.map\(\(target\) => target\.id\), "__all__"\)\.ids/);
  assert.match(page, /loadHealthSamples\(historyTargetIds, "1h"\)/);
  assert.equal((page.match(/loadHealthSamples\(/g) ?? []).length, 1);
  assert.doesNotMatch(page, /loadHealthSamples\(health\.data\.map/);
  const transport = source("../lib/application-persistence.ts");
  assert.match(transport, /if \(!targetIds\.length\) return \{ data: \[\], error: false, code: "OK", metadata: null \};/);
});

test("seed metadata is not attributed to a different target or range", async () => {
  const allIds = Array.from({ length: 25 }, (_, index) =>
    `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
  const expectedIds = healthHistorySelection(allIds, "__all__").ids;
  for (const initial of [result([allIds[1]!]), result(expectedIds, "6h")]) {
    const calls: { ids: string[]; range: HealthTrendRange }[] = [];
    const controller = new HealthHistoryController(async (ids, range) => {
      calls.push({ ids, range }); return result(ids, range);
    }, allIds, initial);
    assert.equal(controller.getSnapshot().key, historyKey(initial.metadata!.target_ids, initial.metadata!.range));
    assert.notEqual(controller.getSnapshot().key, historyKey(expectedIds, "1h"));
    controller.update(expectedIds, "1h", initial, allIds); await flush();
    assert.deepEqual(calls, [{ ids: expectedIds, range: "1h" }]);
    assert.equal(controller.getSnapshot().key, historyKey(expectedIds, "1h"));
    assert.deepEqual(controller.getSnapshot().result.metadata?.target_ids, expectedIds);
  }
});

test("returning to the single-target SSR seed rejects an older in-flight selection response", async () => {
  const allIds = Array.from({ length: 25 }, (_, index) =>
    `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
  const seedIds = healthHistorySelection(allIds, "__all__").ids;
  const initial = result(seedIds), pending = deferred(); let calls = 0;
  const controller = new HealthHistoryController(() => { calls++; return pending.promise; }, allIds, initial);
  controller.update([allIds[1]!], "24h", initial, allIds);
  const refreshedSeed = result(seedIds); refreshedSeed.data = [sample(seedIds[0]!, 10)];
  controller.update(seedIds, "1h", refreshedSeed, allIds);
  assert.equal(controller.getSnapshot().loading, false);
  assert.equal(controller.getSnapshot().result, refreshedSeed);
  pending.finish(result([allIds[1]!], "24h")); await flush();
  assert.equal(calls, 1);
  assert.equal(controller.getSnapshot().key, historyKey(seedIds, "1h"));
  assert.equal(controller.getSnapshot().result, refreshedSeed);
});

test("target/range changes are single-flight and obsolete responses cannot overwrite the latest selection", async () => {
  const first = deferred(), latest = deferred();
  const calls: { ids: string[]; range: string }[] = [];
  let active = 0, peak = 0;
  const initial = result([TARGET, OTHER]);
  const controller = new HealthHistoryController(async (ids, range) => {
    calls.push({ ids, range }); peak = Math.max(peak, ++active);
    const data = await (calls.length === 1 ? first.promise : latest.promise);
    active--; return data;
  }, [TARGET, OTHER], initial);
  controller.update([TARGET], "6h", initial, [TARGET, OTHER]);
  controller.update([OTHER], "24h", initial, [TARGET, OTHER]);
  controller.update([OTHER], "7d", initial, [TARGET, OTHER]);
  controller.update([OTHER], "7d", structuredClone(initial), [TARGET, OTHER]);
  assert.equal(calls.length, 1);
  assert.equal(controller.getSnapshot().loading, true);
  first.finish(result([TARGET], "6h")); await flush();
  assert.equal(controller.getSnapshot().key, historyKey([OTHER], "7d"));
  assert.equal(controller.getSnapshot().loading, true);
  assert.deepEqual(calls, [{ ids: [TARGET], range: "6h" }, { ids: [OTHER], range: "7d" }]);
  latest.finish(result([OTHER], "7d")); await flush();
  assert.equal(controller.getSnapshot().result.metadata?.range, "7d");
  assert.equal(controller.getSnapshot().result.data[0]!.target_id, OTHER);
  assert.equal(peak, 1);
});

test("parent snapshots reuse all/1h and only changed evidence invalidates non-default history", async () => {
  let calls = 0;
  const initial = result();
  const controller = new HealthHistoryController(async (ids, range) => { calls++; return result(ids, range); }, [TARGET], initial);
  controller.update([TARGET], "1h", initial, [TARGET]);
  assert.equal(calls, 0);
  const updated = result(); updated.data = [sample(TARGET, 5)];
  controller.update([TARGET], "1h", updated, [TARGET]);
  assert.equal(controller.getSnapshot().result, updated);
  assert.equal(calls, 0);
  controller.update([TARGET], "24h", updated, [TARGET]); await flush();
  assert.equal(calls, 1);
  controller.update([TARGET], "24h", updated, [TARGET]); await flush();
  assert.equal(calls, 1);
  controller.update([TARGET], "24h", structuredClone(updated), [TARGET]); await flush();
  assert.equal(calls, 1);
  const shiftedWindow = structuredClone(updated);
  shiftedWindow.metadata!.from = "2026-10-09T07:15:31.000Z";
  shiftedWindow.metadata!.to = "2026-10-09T08:15:31.000Z";
  controller.update([TARGET], "24h", shiftedWindow, [TARGET]); await flush();
  assert.equal(calls, 1);
  const changed = result();
  changed.data = [sample(TARGET, 10)];
  controller.update([TARGET], "24h", changed, [TARGET]); await flush();
  assert.equal(calls, 2);
  controller.update([TARGET], "24h", structuredClone(changed), [TARGET]); await flush();
  assert.equal(calls, 2);
});

test("changed evidence during an active request queues one fresh read and rejects the obsolete response", async () => {
  const first = deferred(), latest = deferred();
  const initial = result(); let calls = 0;
  const controller = new HealthHistoryController(() => ++calls === 1 ? first.promise : latest.promise, [TARGET], initial);
  controller.update([TARGET], "24h", initial, [TARGET]);
  const changed = result(); changed.data = [sample(TARGET, 10)];
  controller.update([TARGET], "24h", changed, [TARGET]);
  controller.update([TARGET], "24h", structuredClone(changed), [TARGET]);
  assert.equal(calls, 1);
  first.finish(result([TARGET], "24h")); await flush();
  assert.equal(calls, 2);
  assert.equal(controller.getSnapshot().loading, true);
  const fresh = result([TARGET], "24h"); fresh.data = [sample(TARGET, 10)];
  latest.finish(fresh); await flush();
  assert.equal(controller.getSnapshot().result, fresh);
});

test("explicit refresh is single-flight, rate-bounded, and works even without changed parent evidence", async () => {
  let now = 0, calls = 0;
  const first = deferred(); const initial = result();
  const controller = new HealthHistoryController((ids, range) => {
    calls++; return calls === 1 ? first.promise : Promise.resolve(result(ids, range));
  }, [TARGET], initial, () => now);
  assert.equal(controller.refresh(), true);
  assert.equal(controller.refresh(), false);
  controller.update([TARGET], "1h", structuredClone(initial), [TARGET]);
  assert.equal(controller.getSnapshot().loading, true);
  const refreshed = result(); refreshed.data = [sample(TARGET, 10)];
  first.finish(refreshed); await flush();
  controller.update([TARGET], "1h", structuredClone(initial), [TARGET]);
  assert.equal(controller.getSnapshot().result, refreshed);
  now = 9_999;
  assert.equal(controller.refresh(), false);
  now = 10_000;
  assert.equal(controller.refresh(), true); await flush();
  assert.equal(calls, 2);
  assert.equal(controller.getSnapshot().loading, false);
  const chart = source("../components/dashboard/network-health-trends.tsx");
  assert.match(chart, /onClick=\{\(\) => controller\.refresh\(\)\}/);
  assert.match(chart, /disabled=\{loading \|\| missingTarget \|\| !ids\.length\}/);
});

test("failed loads are errors, cancel prevents completion updates, and unavailable selections expose no old chart", async () => {
  const initial = result();
  const controller = new HealthHistoryController(async () => { throw new Error("not for UI"); }, [TARGET], initial);
  controller.update([TARGET], "24h", initial, [TARGET]); await flush();
  assert.equal(controller.getSnapshot().result.error, true);
  assert.equal(controller.getSnapshot().result.code, "LOCAL_APPLICATION_UNAVAILABLE");
  const pending = deferred(); let emissions = 0;
  const stopped = new HealthHistoryController(() => pending.promise, [TARGET], initial);
  stopped.subscribe(() => { emissions++; });
  stopped.update([TARGET], "6h", initial, [TARGET]); stopped.cancel();
  pending.finish(result()); await flush();
  assert.equal(emissions, 1);
  controller.update([], "7d", initial, [TARGET]);
  assert.deepEqual(controller.getSnapshot().result.data, []);
  assert.equal(validHistorySelection(["arbitrary-ip"], "1h"), false);
  assert.equal(validHistorySelection([TARGET], "30d"), false);
});

test("server action authenticates, retains safe error categories, uses server-only no-store transport, and isolates chart errors", () => {
  const loader = source("../lib/network-health.ts");
  const action = loader.slice(loader.indexOf("export async function loadHealthSamples"), loader.indexOf("function relation"));
  assert.match(action, /await requireApprovedProfile\(\)/);
  assert.match(action, /return localHealthSamples\(targetIds, range\)/);
  assert.doesNotMatch(action, /void targetIds|void range|data: \[\], error: false/);
  const transport = source("../lib/application-persistence.ts");
  assert.match(transport, /import "server-only"/);
  assert.match(transport, /cache: "no-store"/);
  for (const code of ["HEALTH_HISTORY_TARGET_UNAVAILABLE", "HEALTH_HISTORY_QUERY_FAILED", "HEALTH_HISTORY_RESPONSE_TOO_LARGE"]) assert.ok(transport.includes(code));
  const chart = source("../components/dashboard/network-health-trends.tsx");
  assert.match(chart, /missingTarget/);
  assert.match(chart, /role="alert"/);
  assert.match(chart, /\.length === 1 \? \{ r: 4 \} : false/);
  assert.match(chart, /connectNulls=\{false\}/);
  assert.doesNotMatch(chart, /hsl\(var\(|router\.refresh|EventSource|setInterval|LOCAL_BACKEND|Bearer|fetch\(/);
  const page = source("../app/(protected)/dashboard/page.tsx");
  assert.match(page, /history=\{samples\}/);
  assert.match(page, /loadError=\{health\.error \|\| discovery\.error\}/);
  assert.doesNotMatch(page, /loadError=.*samples\.error/);
});

test("localized history copy distinguishes probe/publish/buckets and does not promise unimplemented retention", () => {
  for (const locale of ["en", "id"]) {
    const catalog = JSON.parse(source(`../i18n/${locale}/dashboard.json`));
    for (const key of ["loading", "queryError", "metricUnavailable", "targetUnavailable", "aggregation", "extent", "intervals",
      "allTargetsLimit", "refresh", "refreshHint"]) assert.ok(catalog.trends[key]);
    assert.match(catalog.trends.allTargetsLimit, /\{\{limit\}\}/);
    assert.doesNotMatch(catalog.trends.description, /7-day retention|retensi 7 hari|interval 60 detik|60-second interval/);
    assert.match(catalog.trends.intervals, /\{\{intervals\}\}/);
  }
});
