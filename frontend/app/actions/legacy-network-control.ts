"use server";

import { requireAdminProfile, requireOperatorProfile } from "@/lib/auth";
import { applicationAuthority, uuid } from "@/lib/application-persistence";
import type { DiagnosticJob } from "@/lib/diagnostic-jobs";
import type { DiscoverySession } from "@/lib/network-discovery-client";
import type { DeviceInspectionSession } from "@/lib/device-inspector";
import { createDiagnosticJobLocal, createPingJobLocal, createNetworkDiscoveryLocal,
  startNetworkDiscoveryLocal, createDeviceInspectionLocal, createTrafficSessionLocal,
  requestDiagnosticPreflightLocal, stopTrafficSessionLocal, localPingJob } from "@/lib/application-persistence";

const runnerId = (value: string) => /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value);
const targetId = (value: string) => /^[a-z0-9][a-z0-9_-]{0,127}$/i.test(value);

/** Supabase-mode compatibility only; local authority rejects before Edge network I/O. */
export async function requestDiagnosticPreflightAction(runner: string, target: string): Promise<{ ok: boolean }> {
  if (!runnerId(runner) || !targetId(target)) return { ok: false };
  if (applicationAuthority() === "local_postgres") {
    const { userId } = await requireOperatorProfile();
    return { ok: Boolean(await requestDiagnosticPreflightLocal(userId, runner, target)) };
  }
  const { supabase } = await requireOperatorProfile();
  const { error } = await supabase.functions.invoke("diagnostic-jobs", {
    body: { action: "request_preflight", runner_id: runner, target_id: target },
  });
  return { ok: !error };
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
  if (applicationAuthority() === "local_postgres") {
    const { userId } = await requireOperatorProfile();
    const result = await createDiagnosticJobLocal(userId, {
      runner_id: input.runnerId,
      source_label: source,
      target_id: input.targetId,
      duration_seconds: input.durationSeconds,
    });
    return { ok: !!result, data: result as DiagnosticJob | null };
  }
  const { supabase } = await requireOperatorProfile();
  const { data, error } = await supabase.functions.invoke<{ data: DiagnosticJob }>("diagnostic-jobs", {
    body: {
      action: "create_job", type: "bandwidth_and_path", runner_id: input.runnerId,
      source_label: source, target_id: input.targetId, duration_seconds: input.durationSeconds,
    },
  });
  return { ok: !error && Boolean(data?.data), data: error ? null : data?.data ?? null };
}

export async function queueManualPingAction(target: string): Promise<{ ok: boolean; id: string | null }> {
  if (!uuid(target)) return { ok: false, id: null };
  if (applicationAuthority() === "local_postgres") {
    const { userId } = await requireAdminProfile();
    const result = await createPingJobLocal(userId, {
      target_id: target,
    });
    return { ok: !!result, id: result?.id as string | null };
  }
  const { supabase } = await requireAdminProfile();
  const { data, error } = await supabase.functions.invoke<{ data?: { id?: string } }>("network-health", {
    body: { action: "manual_ping", target_id: target },
  });
  const id = data?.data?.id;
  return { ok: !error && typeof id === "string", id: typeof id === "string" ? id : null };
}

export async function mutateDiscoverySessionAction(input: Readonly<{
  action: "prepare_session" | "start_session";
  runnerId: string;
  sessionId?: string;
}>): Promise<{ ok: boolean; data: DiscoverySession | null }> {
  if (!runnerId(input.runnerId) || (input.action === "start_session" && (!input.sessionId || !uuid(input.sessionId)))) {
    return { ok: false, data: null };
  }
  if (applicationAuthority() === "local_postgres") {
    const { userId } = await requireOperatorProfile();
    if (input.action === "prepare_session") {
      const result = await createNetworkDiscoveryLocal(userId, {
        runner_id: input.runnerId,
      });
      return { ok: !!result, data: result as DiscoverySession | null };
    } else {
      const result = await startNetworkDiscoveryLocal(userId, input.runnerId, input.sessionId!);
      return { ok: !!result, data: result as DiscoverySession | null };
    }
  }
  const { supabase } = await requireOperatorProfile();
  const body = input.action === "prepare_session"
    ? { action: input.action, runner_id: input.runnerId }
    : { action: input.action, runner_id: input.runnerId, session_id: input.sessionId };
  const { data, error } = await supabase.functions.invoke<{ data: DiscoverySession }>("network-discovery", { body });
  return { ok: !error && Boolean(data?.data), data: error ? null : data?.data ?? null };
}

export async function startDeviceInspectionAction(runner: string, targetIp: string): Promise<{
  ok: boolean;
  data: DeviceInspectionSession | null;
}> {
  if (!runnerId(runner) || targetIp.length < 7 || targetIp.length > 45 || /[^0-9a-f:.]/i.test(targetIp)) {
    return { ok: false, data: null };
  }
  if (applicationAuthority() === "local_postgres") {
    const { userId } = await requireOperatorProfile();
    const result = await createDeviceInspectionLocal(userId, {
      runner_id: runner,
      target_ip: targetIp,
    });
    return { ok: !!result, data: result as DeviceInspectionSession | null };
  }
  const { supabase } = await requireOperatorProfile();
  const { data, error } = await supabase.functions.invoke<{ data: DeviceInspectionSession }>("device-inspector", {
    body: { action: "start_inspection", runner_id: runner, target_ip: targetIp },
  });
  return { ok: !error && Boolean(data?.data), data: error ? null : data?.data ?? null };
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
  if (applicationAuthority() === "local_postgres") {
    const { userId } = await requireOperatorProfile();
    if (input.action === "create_session") {
      const result = await createTrafficSessionLocal(userId, {
        runner_id: input.runnerId!,
        duration_seconds: input.durationSeconds!,
      });
      return { ok: !!result };
    } else {
      const result = await stopTrafficSessionLocal(userId, input.sessionId!);
      return { ok: !!result };
    }
  }
  const { supabase } = await requireOperatorProfile();
  const body = input.action === "create_session"
    ? { action: input.action, runner_id: input.runnerId, duration_seconds: input.durationSeconds }
    : { action: input.action, session_id: input.sessionId };
  const { data, error } = await supabase.functions.invoke<{ data: unknown }>("traffic-live", { body });
  return { ok: !error && Boolean(data?.data) };
}

export async function pollManualPingAction(pingId: string): Promise<{ ok: boolean; data: Record<string, unknown> | null }> {
  if (!uuid(pingId)) return { ok: false, data: null };
  if (applicationAuthority() === "local_postgres") {
    await requireAdminProfile();
    const result = await localPingJob(pingId);
    return { ok: !!result, data: result as Record<string, unknown> | null };
  }
  const { supabase } = await requireAdminProfile();
  const { data, error } = await supabase.from("network_health_ping_jobs")
    .select("id,status,result,error_code").eq("id", pingId).maybeSingle();
  return { ok: !error, data: data as Record<string, unknown> | null };
}
