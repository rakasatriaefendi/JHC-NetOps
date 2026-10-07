import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ControlPlanePersistenceError, requireFreshRunner, RUNNER_FRESHNESS_MS } from "../src/persistence/control-plane.js";
import type { PostgresQuery } from "../src/persistence/postgres-query.js";

const epoch = Date.parse("2026-10-07T00:00:00.000Z");
const operations = ["bandwidth_and_path", "network_discovery", "device_inspect", "manual_ping", "traffic_live"];
const signal = () => new AbortController().signal;
const storedRunner = () => ({ id: "it-lt8", last_seen_at: new Date(epoch), health_status: "online",
  capabilities: { targets: [], operations }, preflight: null });

function queryFor(row: Record<string, unknown> | null): PostgresQuery {
  return {
    async rows(sql, values, abortSignal) {
      abortSignal.throwIfAborted();
      assert.match(sql, /^\s*SELECT id,last_seen_at,health_status,capabilities,preflight/);
      assert.match(sql, /FROM public\.diagnostic_runners WHERE id=\$1/);
      assert.deepEqual(values, ["it-lt8"]);
      return row ? [row] : [];
    },
  };
}

const rejectsWith = (code: string) => (error: unknown) =>
  error instanceof ControlPlanePersistenceError && error.code === code;

test("backend heartbeat tolerance stays aligned with frontend at 120 seconds", () => {
  assert.equal(RUNNER_FRESHNESS_MS, 120_000);
  const frontend = readFileSync(new URL("../../frontend/lib/runner-freshness.ts", import.meta.url), "utf8");
  assert.match(frontend, /RUNNER_FRESHNESS_MS = 120_000;/);
  assert.match(frontend, /nowMs - lastSeen <= RUNNER_FRESHNESS_MS/);
});

test("all active control-plane gates remain fresh between consecutive 60-second heartbeats", async (context) => {
  let now = epoch;
  context.mock.method(Date, "now", () => now);
  const row = storedRunner();
  const query = queryFor(row);
  for (let interval = 0; interval < 5; interval += 1) {
    row.last_seen_at = new Date(epoch + interval * 60_000);
    for (const age of [0, 30_000, 30_001, 59_999, 60_000]) {
      now = row.last_seen_at.getTime() + age;
      for (const operation of operations) {
        assert.equal((await requireFreshRunner(query, "it-lt8", operation, signal())).id, "it-lt8");
      }
    }
  }
});

test("stopped runner remains bounded and accepts Date or ISO heartbeat representations", async (context) => {
  let now = epoch + 120_000;
  context.mock.method(Date, "now", () => now);
  for (const lastSeen of [new Date(epoch), new Date(epoch).toISOString()]) {
    const query = queryFor({ ...storedRunner(), last_seen_at: lastSeen });
    now = epoch + 120_000;
    await requireFreshRunner(query, "it-lt8", "network_discovery", signal());
    now += 1;
    await assert.rejects(requireFreshRunner(query, "it-lt8", "network_discovery", signal()), rejectsWith("RUNNER_OFFLINE"));
  }
});

test("extended freshness still rejects missing, invalid, degraded, and unauthorized runners", async (context) => {
  context.mock.method(Date, "now", () => epoch + 60_000);
  await assert.rejects(requireFreshRunner(queryFor(null), "it-lt8", "network_discovery", signal()), rejectsWith("RUNNER_NOT_FOUND"));
  for (const patch of [{ last_seen_at: "invalid" }, { health_status: "degraded" }, { health_status: "offline" }]) {
    await assert.rejects(requireFreshRunner(queryFor({ ...storedRunner(), ...patch }), "it-lt8", "network_discovery", signal()), rejectsWith("RUNNER_OFFLINE"));
  }
  await assert.rejects(requireFreshRunner(queryFor({ ...storedRunner(), capabilities: { targets: [], operations: [] } }),
    "it-lt8", "network_discovery", signal()), rejectsWith("OPERATION_NOT_AUTHORIZED"));
});

test("Discovery, Diagnostics, Inspector, Manual Ping, and Traffic use the shared freshness gate", () => {
  for (const [file, operation] of [
    ["diagnostic-jobs", "bandwidth_and_path"], ["network-discovery", "network_discovery"],
    ["device-inspection", "device_inspect"], ["network-health-ping-jobs", "manual_ping"], ["traffic", "traffic_live"],
  ]) {
    const source = readFileSync(new URL(`../src/persistence/${file}.ts`, import.meta.url), "utf8");
    assert.match(source, new RegExp(`await requireFreshRunner\\(query, [^\\n]*"${operation}", signal\\)`));
  }
});
