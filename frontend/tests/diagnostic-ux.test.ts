import assert from "node:assert/strict";
import test from "node:test";

import {
  diagnosticStageLabel,
  diagnosticSteps,
  safeFailureMessage,
} from "../lib/diagnostic-ux.ts";
import type { DiagnosticJob } from "../lib/diagnostic-jobs.ts";

test("stepper derives completed, active, and pending states from real stage", () => {
  const job = fixture({ status: "running", stage: "upload" });
  const states = Object.fromEntries(diagnosticSteps(job).map((step) => [step.id, step.state]));
  assert.equal(states.runner, "completed");
  assert.equal(states.target, "completed");
  assert.equal(states.upload, "active");
  assert.equal(states.download, "pending");
  assert.equal(diagnosticStageLabel(job), "Mengukur upload...");
});

test("completed job marks every real step complete", () => {
  assert.ok(diagnosticSteps(fixture({ status: "completed", stage: "complete" })).every((step) => step.state === "completed"));
});

test("safe failure maps to the affected step and Indonesian message", () => {
  const job = fixture({ status: "failed", stage: "failed", error_code: "DOWNLOAD_FAILED" });
  assert.equal(diagnosticSteps(job).find((step) => step.id === "download")?.state, "failed");
  assert.equal(safeFailureMessage(job.error_code), "Pengujian download gagal.");
});

function fixture(overrides: Partial<DiagnosticJob>): DiagnosticJob {
  return {
    id: "8b6386f1-a2ef-4c6d-87fd-682100bcdcec",
    runner_id: "runner",
    requested_by: "8b6386f1-a2ef-4c6d-87fd-682100bcdcec",
    status: "queued",
    type: "bandwidth_and_path",
    source_label: "Local Development",
    target_id: "localhost-demo",
    target_label: "Localhost — TEST ENVIRONMENT",
    target_host: "127.0.0.1",
    iperf_port: 5202,
    connection_type: "wifi",
    duration_seconds: 10,
    environment: "localhost_demo",
    stage: "queued",
    progress: {},
    network_context: null,
    route_context: null,
    preflight_context: null,
    error_code: null,
    error_message: null,
    created_at: "2026-08-11T00:00:00Z",
    started_at: null,
    completed_at: null,
    updated_at: "2026-08-11T00:00:00Z",
    ...overrides,
  };
}
