"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import type { NetworkHealthTarget } from "@/lib/network-health";
import { createClient } from "@/lib/supabase/client";

export type ManualPingPhase = "loading" | "success" | "error";
export type ManualPingState = { phase: ManualPingPhase; message: string };

type ManualPingJob = {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  result: { ok: boolean; latency_ms?: number; category?: "timeout" | "unreachable" } | null;
  error_code: string | null;
};

type ManualPingContextValue = {
  isAdmin: boolean;
  states: Record<string, ManualPingState | undefined>;
  activityTokens: Record<string, number | undefined>;
  run: (targetId: string) => void;
};

const ManualPingContext = createContext<ManualPingContextValue>({
  isAdmin: false,
  states: {},
  activityTokens: {},
  run: () => {},
});

function waitForManualPing(client: ReturnType<typeof createClient>, pingId: string) {
  return new Promise<ManualPingJob>((resolve, reject) => {
    let settled = false;
    const channel = client.channel(`manual-ping-${pingId}`);
    const finish = (job: ManualPingJob | null, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      void client.removeChannel(channel);
      if (job) resolve(job);
      else reject(error ?? new Error("Manual ping failed"));
    };
    const inspect = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      const job = value as ManualPingJob;
      if (job.id === pingId && (job.status === "completed" || job.status === "failed")) finish(job);
    };
    const timeout = setTimeout(() => finish(null, new Error("Manual ping timed out")), 15_000);
    channel
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "network_health_ping_jobs", filter: `id=eq.${pingId}` }, (payload) => inspect(payload.new))
      .subscribe(async (status) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          finish(null, new Error("Manual ping state unavailable"));
          return;
        }
        if (status !== "SUBSCRIBED" || settled) return;
        const { data, error } = await client.from("network_health_ping_jobs")
          .select("id,status,result,error_code").eq("id", pingId).maybeSingle();
        if (error) finish(null, new Error("Manual ping state unavailable"));
        else inspect(data);
      });
  });
}

function manualPingOutcome(job: ManualPingJob): ManualPingState {
  if (job.status !== "completed" || !job.result) return { phase: "error", message: "Ping gagal" };
  if (job.result.ok === true && typeof job.result.latency_ms === "number") {
    return { phase: "success", message: `Ping ${job.result.latency_ms.toFixed(1)} ms` };
  }
  return { phase: "error", message: job.result.category === "timeout" ? "Ping timeout" : "Tidak terjangkau" };
}

export function ManualPingProvider({ targets, isAdmin, children }: {
  targets: NetworkHealthTarget[];
  isAdmin: boolean;
  children: React.ReactNode;
}) {
  const [states, setStates] = useState<Record<string, ManualPingState | undefined>>({});
  const [activityTokens, setActivityTokens] = useState<Record<string, number | undefined>>({});
  const client = useMemo(() => createClient(), []);
  const clearTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const inFlight = useRef(new Set<string>());

  const run = useCallback(async (targetId: string) => {
    const target = targets.find((candidate) => candidate.id === targetId);
    if (!isAdmin || !target?.manual_ping_available || inFlight.current.has(targetId)) return;

    inFlight.current.add(targetId);
    if (clearTimers.current[targetId]) clearTimeout(clearTimers.current[targetId]);
    setStates((current) => ({ ...current, [targetId]: { phase: "loading", message: "Pinging…" } }));
    setActivityTokens((current) => ({ ...current, [targetId]: Number(current[targetId] ?? 0) + 1 }));

    let outcome: ManualPingState;
    try {
      const { data, error } = await client.functions.invoke("network-health", {
        body: { action: "manual_ping", target_id: targetId },
      });
      const pingId = data?.data?.id;
      if (error || typeof pingId !== "string") throw new Error("Manual ping could not be queued");
      outcome = manualPingOutcome(await waitForManualPing(client, pingId));
    } catch {
      outcome = { phase: "error", message: "Ping gagal" };
    } finally {
      inFlight.current.delete(targetId);
    }

    setStates((current) => ({ ...current, [targetId]: outcome }));
    clearTimers.current[targetId] = setTimeout(() => {
      setStates((current) => ({ ...current, [targetId]: undefined }));
      delete clearTimers.current[targetId];
    }, 2500);
  }, [client, isAdmin, targets]);

  useEffect(() => () => {
    Object.values(clearTimers.current).forEach(clearTimeout);
  }, []);

  const value = useMemo<ManualPingContextValue>(() => ({
    isAdmin,
    states,
    activityTokens,
    run,
  }), [activityTokens, isAdmin, run, states]);

  return <ManualPingContext.Provider value={value}>{children}</ManualPingContext.Provider>;
}

export function useManualPing() {
  return useContext(ManualPingContext);
}
