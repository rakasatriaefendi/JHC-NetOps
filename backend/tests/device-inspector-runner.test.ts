import assert from "node:assert/strict";
import test from "node:test";

import type { DeviceFingerprint, DeviceInspectionStage } from "../src/device-inspector/contract.js";
import type { DeviceInspectionRepository, InspectionCreateInput } from "../src/persistence/device-inspection.js";
import { buildServer } from "../src/server.js";

const TOKEN = "local-runner-token-for-tests-only";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const NOW = new Date("2026-09-22T01:02:03.000Z");
const INSPECTION = "30000000-0000-4000-8000-000000000003";
const FINGERPRINT = {
  ip: "192.168.1.50",
  confidence: "medium",
  likely_device_type: "server",
  capabilities: ["http"],
  evidence: [{ source: "tcp", label: "HTTP", value: "open" }],
} as const;

class FakeInspection implements DeviceInspectionRepository {
  calls: string[] = [];
  active = true;
  row: Record<string, unknown> = {
    runner_id: "it-lt8", inspection_id: INSPECTION, target_ip: "192.168.1.50", status: "running",
  };
  async get() { return this.row; }
  async create(actorId: string, input: InspectionCreateInput) { void actorId; void input; return this.row; }
  async expireStale() {}
  async claim(runnerId: string) { this.calls.push(`claim:${runnerId}`); return this.row; }
  async updateStage(runnerId: string, inspectionId: string, stage: DeviceInspectionStage) {
    this.calls.push(`stage:${runnerId}:${inspectionId}:${stage}`); return this.active ? this.row : null;
  }
  async complete(runnerId: string, inspectionId: string, result: DeviceFingerprint) {
    this.calls.push(`complete:${runnerId}:${inspectionId}:${result.ip}`);
    return this.active ? { ...this.row, status: "completed", result } : null;
  }
  async fail(runnerId: string, inspectionId: string, errorCode: string) {
    this.calls.push(`fail:${runnerId}:${inspectionId}:${errorCode}`);
    return this.active ? { ...this.row, status: "failed", error_code: errorCode } : null;
  }
}

test("local Device Inspector runner route requires bearer authentication", async () => {
  const repository = new FakeInspection();
  const server = buildServer({ logger: false, deviceInspection: { token: TOKEN, repository } });
  const response = await server.inject({ method: "POST", url: "/api/runner/device-inspector",
    headers: { authorization: "Bearer wrong-token-that-is-long-enough" },
    payload: { action: "claim_session", runner_id: "it-lt8" } });
  assert.equal(response.statusCode, 401);
  assert.deepEqual(repository.calls, []);
  await server.close();
});

test("queued local inspection is claimed only for the authenticated runner payload", async () => {
  const repository = new FakeInspection();
  const server = buildServer({ logger: false, deviceInspection: { token: TOKEN, repository, now: () => NOW } });
  const response = await server.inject({ method: "POST", url: "/api/runner/device-inspector", headers: AUTH,
    payload: { action: "claim_session", runner_id: "it-lt8" } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(repository.calls, ["claim:it-lt8"]);
  await server.close();
});

test("bounded normalized result completes the exact local inspection", async () => {
  const repository = new FakeInspection();
  const server = buildServer({ logger: false, deviceInspection: { token: TOKEN, repository, now: () => NOW } });
  const stage = await server.inject({ method: "POST", url: "/api/runner/device-inspector", headers: AUTH,
    payload: { action: "update_stage", runner_id: "it-lt8", inspection_id: INSPECTION, stage: "identity" } });
  const completed = await server.inject({ method: "POST", url: "/api/runner/device-inspector", headers: AUTH,
    payload: { action: "complete_session", runner_id: "it-lt8", inspection_id: INSPECTION, result: FINGERPRINT } });
  assert.equal(stage.statusCode, 200);
  assert.equal(completed.statusCode, 200);
  assert.deepEqual(repository.calls, [
    `stage:it-lt8:${INSPECTION}:identity`, `complete:it-lt8:${INSPECTION}:192.168.1.50`,
  ]);
  await server.close();
});

test("wrong runner or inspection cannot mutate an inactive local inspection", async () => {
  const repository = new FakeInspection();
  repository.active = false;
  const server = buildServer({ logger: false, deviceInspection: { token: TOKEN, repository } });
  const response = await server.inject({ method: "POST", url: "/api/runner/device-inspector", headers: AUTH,
    payload: { action: "update_stage", runner_id: "other-runner", inspection_id: INSPECTION, stage: "services" } });
  assert.equal(response.statusCode, 409);
  assert.match(response.body, /INSPECTION_SESSION_NOT_ACTIVE/);
  await server.close();
});

test("Device Inspector failure is bounded and transitions only an active session", async () => {
  const repository = new FakeInspection();
  const server = buildServer({ logger: false, deviceInspection: { token: TOKEN, repository } });
  const response = await server.inject({ method: "POST", url: "/api/runner/device-inspector", headers: AUTH,
    payload: { action: "fail_session", runner_id: "it-lt8", inspection_id: INSPECTION,
      error_code: "INSPECTION_TIMEOUT" } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(repository.calls, [`fail:it-lt8:${INSPECTION}:INSPECTION_TIMEOUT`]);
  await server.close();
});

test("Device Inspector rejects raw evidence and oversized normalized results before persistence", async () => {
  const repository = new FakeInspection();
  const server = buildServer({ logger: false, deviceInspection: { token: TOKEN, repository } });
  const raw = await server.inject({ method: "POST", url: "/api/runner/device-inspector", headers: AUTH,
    payload: { action: "complete_session", runner_id: "it-lt8", inspection_id: INSPECTION,
      result: { ...FINGERPRINT, raw: "probe output" } } });
  const large = await server.inject({ method: "POST", url: "/api/runner/device-inspector", headers: AUTH,
    payload: { action: "complete_session", runner_id: "it-lt8", inspection_id: INSPECTION,
      result: { ...FINGERPRINT, evidence: Array(32).fill({ source: "tcp", label: "x".repeat(2048), value: "open" }) } } });
  assert.equal(raw.statusCode, 400);
  assert.equal(large.statusCode, 413);
  assert.deepEqual(repository.calls, []);
  await server.close();
});
