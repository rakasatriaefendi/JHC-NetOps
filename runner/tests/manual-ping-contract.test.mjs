import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  validManualPingFailureCode,
  validManualPingResult,
} from "../../supabase/functions/network-health/manual-ping.ts";

test("manual ping result accepts only normalized latency or bounded failure categories", () => {
  assert.equal(validManualPingResult({ ok: true, latency_ms: 3.2 }), true);
  assert.equal(validManualPingResult({ ok: false, category: "timeout" }), true);
  assert.equal(validManualPingResult({ ok: false, category: "unreachable" }), true);
  assert.equal(validManualPingResult({ ok: true, latency_ms: 0, stderr: "raw" }), false);
  assert.equal(validManualPingResult({ ok: false, category: "permission_denied" }), false);
  assert.equal(validManualPingFailureCode("MANUAL_PING_FAILED"), true);
  assert.equal(validManualPingFailureCode("RAW_PROCESS_ERROR"), false);
});

test("manual ping transport is isolated from scheduled Health Watch persistence", () => {
  const runner = readFileSync(new URL("../src/network-health.mjs", import.meta.url), "utf8");
  const start = runner.indexOf("  async manualPing(targetId) {");
  const end = runner.indexOf("  applySample(target, sample", start);
  assert.ok(start >= 0 && end > start);
  const method = runner.slice(start, end);
  assert.doesNotMatch(method, /applySample|publishHealth|pendingTransitions|network_health_latest|network_health_samples/);

  const migration = readFileSync(new URL("../../supabase/migrations/202608280001_network_health_manual_ping.sql", import.meta.url), "utf8");
  assert.match(migration, /network_health_ping_jobs_one_active_target_idx/);
  assert.doesNotMatch(migration, /insert\s+into\s+public\.(network_health_latest|network_health_samples|events)/i);
});

test("manual ping rollout remains disabled until the local runner explicitly enables it", () => {
  const config = readFileSync(new URL("../src/config.mjs", import.meta.url), "utf8");
  const main = readFileSync(new URL("../src/main.mjs", import.meta.url), "utf8");
  assert.match(config, /config\.enable_manual_ping === true/);
  assert.match(main, /config\.enable_manual_ping === true[\s\S]*?claimManualPing/);
});
