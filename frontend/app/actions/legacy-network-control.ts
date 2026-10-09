"use server";

import { requireAdminProfile, requireOperatorProfile } from "@/lib/auth";
import { uuid } from "@/lib/application-persistence";
import type { DiagnosticJob } from "@/lib/diagnostic-jobs";
import type { DiscoverySession } from "@/lib/network-discovery-client";
import type { DeviceInspectionSession } from "@/lib/device-inspector";
import { createDiagnosticJobLocal, createPingJobLocal, createNetworkDiscoveryLocal,
  startNetworkDiscoveryLocal, createDeviceInspectionLocal, createTrafficSessionLocal,
  requestDiagnosticPreflightLocal, stopTrafficSessionLocal, localPingJob } from "@/lib/application-persistence";

const runnerId = (value: string) => /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value);
const targetId = (value: string) => /^[a-z0-9][a-z0-9_-]{0,127}$/i.test(value);

export async function requestDiagnosticPreflightAction(runner: string, target: string): Promise<{ ok: boolean }> {
  if (!runnerId(runner) || !targetId(target)) return { ok: false };
  const { userId } = await requireOperatorProfile();
  return { ok: Boolean(await requestDiagnosticPreflightLocal(userId, runner, target)) };
}

export async function createDiagnosticJobAction(input: Readonly<{
  runnerId: string;
  sourceLabel: string;
  targetId: string;
  durationSeconds: number;
}>): Promise<{ ok: boolean; data: DiagnosticJob | null }> {
  const source = input.sourceLabel.trim();
  if (!runnerId(input.runnerId) || !targetId(input.targetId) || !source || source.length > 200 ||
      ![5, 10].includes(input.durationSeconds)) return { ok: false, data: null };
  const { userId } = await requireOperatorProfile();
  const result = await createDiagnosticJobLocal(userId, {
    runner_id: input.runnerId,
    source_label: source,
    target_id: input.targetId,
    duration_seconds: input.durationSeconds,
  });
  return { ok: !!result, data: result as DiagnosticJob | null };
}

export async function queueManualPingAction(target: string): Promise<{ ok: boolean; id: string | null; code: string }> {
  if (!uuid(target)) return { ok: false, id: null, code: "INVALID_CONTROL_PLANE_INPUT" };
  const { userId } = await requireAdminProfile();
  const result = await createPingJobLocal(userId, {
    target_id: target,
  });
  const id = result.data?.id;
  return typeof id === "string" && uuid(id) && result.ok
    ? { ok: true, id, code: "OK" }
    : { ok: false, id: null, code: result.ok ? "MANUAL_PING_RESULT_UNAVAILABLE" : result.code };
}

export async function mutateDiscoverySessionAction(input: Readonly<{
  action: "prepare_session" | "start_session";
  runnerId: string;
  sessionId?: string;
}>): Promise<{ ok: boolean; data: DiscoverySession | null }> {
  if (!runnerId(input.runnerId) || (input.action === "start_session" && (!input.sessionId || !uuid(input.sessionId)))) {
    return { ok: false, data: null };
  }
  const { userId } = await requireOperatorProfile();
  const result = input.action === "prepare_session"
    ? await createNetworkDiscoveryLocal(userId, { runner_id: input.runnerId })
    : await startNetworkDiscoveryLocal(userId, input.runnerId, input.sessionId!);
  return { ok: !!result, data: result as DiscoverySession | null };
}

export async function startDeviceInspectionAction(runner: string, targetIp: string): Promise<{
  ok: boolean;
  data: DeviceInspectionSession | null;
}> {
  if (!runnerId(runner) || targetIp.length < 7 || targetIp.length > 45 || /[^0-9a-f:.]/i.test(targetIp)) {
    return { ok: false, data: null };
  }
  const { userId } = await requireOperatorProfile();
  const result = await createDeviceInspectionLocal(userId, {
    runner_id: runner,
    target_ip: targetIp,
  });
  return { ok: !!result, data: result as DeviceInspectionSession | null };
}

export async function mutateTrafficSessionAction(input: Readonly<{
  action: "create_session" | "stop_session";
  runnerId?: string;
  sessionId?: string;
  durationSeconds?: number;
}>): Promise<{ ok: boolean }> {
  const validCreate = input.action === "create_session" && Boolean(input.runnerId) && runnerId(input.runnerId ?? "") &&
    [300, 600, 900, 1800].includes(input.durationSeconds ?? -1);
  const validStop = input.action === "stop_session" && Boolean(input.sessionId) && uuid(input.sessionId ?? "");
  if (!validCreate && !validStop) return { ok: false };
  const { userId } = await requireOperatorProfile();
  const result = input.action === "create_session"
    ? await createTrafficSessionLocal(userId, { runner_id: input.runnerId!, duration_seconds: input.durationSeconds! })
    : await stopTrafficSessionLocal(userId, input.sessionId!);
  return { ok: !!result };
}

export async function pollManualPingAction(pingId: string): Promise<{ ok: boolean; data: Record<string, unknown> | null; code: string }> {
  if (!uuid(pingId)) return { ok: false, data: null, code: "INVALID_CONTROL_PLANE_INPUT" };
  await requireAdminProfile();
  return localPingJob(pingId);
}
