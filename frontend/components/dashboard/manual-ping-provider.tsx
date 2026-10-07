"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useActionFeedback } from "@/components/ui/action-feedback";

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

function manualPingOutcome(job: ManualPingJob, t: TFunction): ManualPingState {
  if (job.status !== "completed" || !job.result) return { phase: "error", message: t("manualPing.failed") };
  if (job.result.ok === true && typeof job.result.latency_ms === "number") {
    return { phase: "success", message: t("manualPing.result", { latency: job.result.latency_ms.toFixed(1) }) };
  }
  return { phase: "error", message: t(job.result.category === "timeout" ? "manualPing.timeout" : "manualPing.unreachable") };
}

export function ManualPingProvider({ targets, isAdmin, children }: {
  targets: NetworkHealthTarget[];
  isAdmin: boolean;
  children: React.ReactNode;
}) {
  const { t } = useTranslation("common");
  const notify = useActionFeedback();
  const [states, setStates] = useState<Record<string, ManualPingState | undefined>>({});
  const [activityTokens, setActivityTokens] = useState<Record<string, number | undefined>>({});
  const clearTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const inFlight = useRef(new Set<string>());

  const run = useCallback(async (targetId: string) => {
    const target = targets.find((candidate) => candidate.id === targetId);
    if (!isAdmin || !target?.manual_ping_available || inFlight.current.has(targetId)) return;

    inFlight.current.add(targetId);
    if (clearTimers.current[targetId]) clearTimeout(clearTimers.current[targetId]);
    setStates((current) => ({ ...current, [targetId]: { phase: "loading", message: t("mutation.pending.ping") } }));
    setActivityTokens((current) => ({ ...current, [targetId]: Number(current[targetId] ?? 0) + 1 }));

    let outcome: ManualPingState;
    try {
      const queued = await queueManualPingAction(targetId);
      const pingId = queued.id;
      if (!queued.ok || typeof pingId !== "string") throw new Error("Manual ping could not be queued");
      const job = await waitForManualPingLocal(pingId);
      outcome = manualPingOutcome(job, t);
    } catch {
      outcome = { phase: "error", message: t("manualPing.failed") };
    } finally {
      inFlight.current.delete(targetId);
    }

    setStates((current) => ({ ...current, [targetId]: outcome }));
    notify("ping", outcome.phase === "success"); // One terminal result for this explicit request, never a background poll toast.
    clearTimers.current[targetId] = setTimeout(() => {
      setStates((current) => ({ ...current, [targetId]: undefined }));
      delete clearTimers.current[targetId];
    }, 2500);
  }, [isAdmin, targets, notify, t]);

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
