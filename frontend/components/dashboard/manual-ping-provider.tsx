"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import type { NetworkHealthTarget } from "@/lib/network-health";
import { queueManualPingAction, pollManualPingAction } from "@/app/actions/legacy-network-control";

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

async function waitForManualPingLocal(pingId: string): Promise<ManualPingJob> {
  const startTime = Date.now();
  const maxWaitMs = 15_000;
  const pollIntervalMs = 1500;
  let lastJob: ManualPingJob | null = null;

  while (Date.now() - startTime < maxWaitMs) {
    const response = await pollManualPingAction(pingId);
    if (!response.ok || !response.data) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      continue;
    }
    const job = response.data as ManualPingJob;
    lastJob = job;
    if (job.status === "completed" || job.status === "failed") {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  if (lastJob) return lastJob;
  throw new Error("Manual ping timed out");
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
      const queued = await queueManualPingAction(targetId);
      const pingId = queued.id;
      if (!queued.ok || typeof pingId !== "string") throw new Error("Manual ping could not be queued");
      const job = await waitForManualPingLocal(pingId);
      outcome = manualPingOutcome(job);
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
  }, [isAdmin, targets]);

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
