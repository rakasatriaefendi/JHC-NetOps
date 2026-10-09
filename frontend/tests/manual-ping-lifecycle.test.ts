import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { manualPingFailure, manualPingOutcome, waitForManualPing, type ManualPingJob } from "../lib/manual-ping.ts";

const ID = "20000000-0000-4000-8000-000000000002";
const START = Date.parse("2026-10-09T00:00:00Z");
const expiresAt = new Date(START + 30_000).toISOString();
const job = (overrides: Partial<ManualPingJob> = {}): ManualPingJob => ({
  id: ID, status: "queued", expires_at: expiresAt, result: null, error_code: null, ...overrides,
});

test("queued/running are pending, never ICMP failure or expiry before the lease ends", () => {
  assert.deepEqual(manualPingOutcome(job()), { phase: "loading", key: "manualPing.queued" });
  assert.equal(manualPingOutcome(job({ status: "running" })).phase, "loading");
});

test("a claim after the old 15-second UI window can still finish successfully", async () => {
  let now = START;
  let reads = 0;
  const phases: string[] = [];
  const outcome = await waitForManualPing(ID, async () => {
    reads += 1;
    const status = now - START < 18_000 ? "queued" : now - START < 22_000 ? "running" : "completed";
    return { ok: true, data: job({ status, result: status === "completed" ? { ok: true, latency_ms: 5.6 } : null }) };
  }, (progress) => phases.push(progress.key), () => now, async (ms) => { now += ms; });
  assert.deepEqual(outcome, { phase: "success", key: "manualPing.result", latency: "5.6" });
  assert.ok(now - START > 15_000 && now - START < 30_000);
  assert.ok(phases.includes("manualPing.queued") && phases.includes("mutation.pending.ping"));
  assert.ok(reads <= 24, "bounded sequential reads, not a claim/probe loop");
});

test("queued/running without authoritative terminal evidence exhaust the UI budget as unconfirmed, never expired", async () => {
  for (const status of ["queued", "running"] as const) {
    let now = START;
    let reads = 0;
    const outcome = await waitForManualPing(ID, async () => {
      reads += 1;
      return { ok: true, data: job({ status }) };
    }, () => {}, () => now, async (ms) => { now += ms; });
    assert.equal(outcome.code, "MANUAL_PING_RESULT_UNAVAILABLE");
    assert.equal(outcome.key, "manualPing.resultUnavailable");
    assert.equal(now - START, 35_000);
    assert.equal(reads, 24, "serial polling stays bounded even when expires_at is behind the browser clock");
  }
});

test("browser clock skew cannot expire valid queued/running jobs that later complete", async () => {
  for (const skew of [-3_600_000, 3_600_000]) {
    let now = START + skew;
    let reads = 0;
    const progress: string[] = [];
    const outcome = await waitForManualPing(ID, async () => {
      reads += 1;
      const status = reads === 1 ? "queued" : reads === 2 ? "running" : "completed";
      return { ok: true, data: job({ status, result: status === "completed" ? { ok: true, latency_ms: 2 } : null }) };
    }, (value) => progress.push(value.key), () => now, async (ms) => { now += ms; });
    assert.equal(outcome.phase, "success");
    assert.equal(reads, 3);
    assert.deepEqual(progress, ["manualPing.queued", "mutation.pending.ping"]);
  }
});

test("persisted expiry uses authoritative timestamps while an earlier target failure stays distinct", () => {
  assert.equal(manualPingOutcome(job({ status: "failed", error_code: "MANUAL_PING_TARGET_UNAVAILABLE",
    completed_at: expiresAt })).code, "MANUAL_PING_EXPIRED");
  assert.equal(manualPingOutcome(job({ status: "failed", error_code: "MANUAL_PING_TARGET_UNAVAILABLE",
    completed_at: new Date(START + 5_000).toISOString() })).key, "manualPing.unavailable");
  assert.equal(manualPingOutcome(job({ status: "failed", error_code: "MANUAL_PING_TARGET_UNAVAILABLE" })).key,
    "manualPing.unavailable", "missing completion evidence cannot prove expiry");
});

test("persisted terminal expiry is respected regardless of the browser's skewed clock", async () => {
  for (const skew of [-3_600_000, 3_600_000]) {
    const outcome = await waitForManualPing(ID, async () => ({ ok: true, data: job({ status: "failed",
      error_code: "MANUAL_PING_TARGET_UNAVAILABLE", completed_at: expiresAt }) }),
    () => {}, () => START + skew);
    assert.equal(outcome.code, "MANUAL_PING_EXPIRED");
  }
});

test("transient refetch failure is retried without manufacturing a network failure", async () => {
  let now = START;
  let reads = 0;
  const outcome = await waitForManualPing(ID, async () => {
    reads += 1;
    if (reads === 1) throw new Error("temporary read failure");
    return { ok: true, data: job({ status: "completed", result: { ok: true, latency_ms: 2 } }) };
  }, () => {}, () => now, async (ms) => { now += ms; });
  assert.equal(outcome.phase, "success");
  assert.equal(reads, 2);
});

test("persistent read failures and wrong job IDs have a bounded unconfirmed outcome, not a network result", async () => {
  for (const data of [null, job({ id: "wrong-id" })]) {
    let now = START;
    let reads = 0;
    const outcome = await waitForManualPing(ID, async () => { reads += 1; return { ok: data !== null, data }; },
      () => {}, () => now, async (ms) => { now += ms; });
    assert.equal(outcome.code, "MANUAL_PING_RESULT_UNAVAILABLE");
    assert.equal(now - START, 35_000);
    assert.ok(reads <= 24);
  }
});

test("busy/offline/control expiry and measured timeout/unreachable remain separate safe outcomes", () => {
  assert.equal(manualPingFailure("RUNNER_BUSY").key, "manualPing.busy");
  assert.equal(manualPingFailure("RUNNER_OFFLINE").key, "manualPing.offline");
  assert.equal(manualPingFailure("ALREADY_ACTIVE").key, "manualPing.busy");
  for (const category of ["timeout", "unreachable"]) {
    assert.equal(manualPingOutcome(job({ status: "completed", result: { ok: false, category } })).key, `manualPing.${category}`);
  }
  assert.equal(manualPingFailure("arbitrary backend text").code, "MANUAL_PING_FAILED");
  assert.equal(manualPingOutcome(job({ status: "completed", result: { ok: true, latency_ms: -1 } })).code,
    "MANUAL_PING_RESULT_UNAVAILABLE");
});

test("queue and read actions retain safe rejection codes without weakening Admin/target authorization", () => {
  const persistence = readFileSync(new URL("../lib/application-persistence.ts", import.meta.url), "utf8");
  const actions = readFileSync(new URL("../app/actions/legacy-network-control.ts", import.meta.url), "utf8");
  const queue = actions.slice(actions.indexOf("export async function queueManualPingAction"), actions.indexOf("export async function mutateDiscoverySessionAction"));
  assert.match(queue, /if \(!uuid\(target\)\)/);
  assert.match(queue, /await requireAdminProfile\(\)/);
  const page = readFileSync(new URL("../app/(protected)/dashboard/page.tsx", import.meta.url), "utf8");
  const dashboard = readFileSync(new URL("../components/dashboard/network-health-dashboard.tsx", import.meta.url), "utf8");
  assert.match(page, /manualPingIsAdmin=\{profile\.role === "admin"\}/);
  assert.match(page, /isAdmin=\{canOperate\}/, "leave existing Operator controls unchanged");
  assert.match(dashboard, /<ManualPingProvider targets=\{targets\} isAdmin=\{manualPingIsAdmin\}>/);
  assert.match(queue, /code: result\.ok \? "MANUAL_PING_RESULT_UNAVAILABLE" : result\.code/);
  assert.match(actions, /return localPingJob\(pingId\)/);
  assert.match(persistence, /"RUNNER_BUSY", "RUNNER_OFFLINE", "OPERATION_NOT_AUTHORIZED"/);
  const create = persistence.slice(persistence.indexOf("export async function createPingJobLocal"), persistence.indexOf("export async function createNetworkDiscoveryLocal"));
  assert.match(create, /code: response\.ok \? "MANUAL_PING_RESULT_UNAVAILABLE" : response\.code/);
  assert.doesNotMatch(create, /ip_address|runner_id|timeout_ms|ping_count/);
  const feedback = readFileSync(new URL("../components/ui/action-feedback.tsx", import.meta.url), "utf8");
  assert.match(feedback, /action === "ping" && code \? manualPingFailure\(code\)\.key/);
});
