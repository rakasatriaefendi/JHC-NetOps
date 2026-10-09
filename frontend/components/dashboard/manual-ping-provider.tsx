"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useActionFeedback } from "@/components/ui/action-feedback";

import type { NetworkHealthTarget } from "@/lib/network-health";
import { queueManualPingAction, pollManualPingAction } from "@/app/actions/legacy-network-control";
import { manualPingFailure, waitForManualPing, type ManualPingOutcome } from "@/lib/manual-ping";

export type ManualPingPhase = "loading" | "success" | "error";
export type ManualPingState = { phase: ManualPingPhase; message: string; code?: string };

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
    const translate = (result: ManualPingOutcome): ManualPingState => ({
      phase: result.phase, message: t(result.key, { latency: result.latency }),
      ...(result.code ? { code: result.code } : {}),
    });
    const waitForManualPingLocal = (pingId: string) => waitForManualPing(pingId, pollManualPingAction,
      (progress) => setStates((current) => ({ ...current, [targetId]: translate(progress) })));
    try {
      const queued = await queueManualPingAction(targetId);
      const pingId = queued.id;
      outcome = translate(queued.ok && typeof pingId === "string"
        ? await waitForManualPingLocal(pingId)
        : manualPingFailure(queued.code));
    } catch {
      outcome = translate(manualPingFailure("MANUAL_PING_RESULT_UNAVAILABLE"));
    } finally {
      inFlight.current.delete(targetId);
    }

    setStates((current) => ({ ...current, [targetId]: outcome }));
    notify("ping", outcome.phase === "success", outcome.code); // One terminal result for this explicit request, never a background poll toast.
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
