"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { MutationKind } from "@/lib/mutation-feedback";
import { manualPingFailure } from "@/lib/manual-ping";
import { appendFeedback, FeedbackAttempts, FeedbackSwipe, FeedbackTimer, FEEDBACK_SUCCESS_MS } from "@/lib/action-feedback";

type Notification = { id: number; action: MutationKind; success: boolean; errorKey: string };
const lifecycleErrors = new Set(["ADMIN_ACCESS_REQUIRED", "SELF_DELETE_BLOCKED", "SELF_DISABLE_BLOCKED",
  "LAST_LOGIN_CAPABLE_ADMIN_BLOCKED", "ACCOUNT_HAS_HISTORY", "ACCOUNT_NOT_DISABLEABLE",
  "ACCOUNT_NOT_REENABLEABLE", "ACCOUNT_NOT_DELETABLE", "PROFILE_NOT_FOUND"]);
const FeedbackContext = createContext<(action: MutationKind, success: boolean, code?: string, attemptId?: string) => void>(() => {});

/** Reuses the application's role=status/alert notification pattern; no toast SDK. */
export function ActionFeedbackProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const nextId = useRef(0);
  const [attempts] = useState(() => new FeedbackAttempts());
  const dismiss = useCallback((id: number) => {
    setNotifications((current) => current.filter((entry) => entry.id !== id));
  }, []);
  const notify = useCallback((action: MutationKind, success: boolean, code?: string, attemptId?: string) => {
    if (!attempts.accept(attemptId)) return;
    const id = ++nextId.current;
    const errorKey = action === "ping" && code ? manualPingFailure(code).key
      : code && lifecycleErrors.has(code) ? `admin:lifecycle.errors.${code}` : "mutation.failed";
    setNotifications((current) => appendFeedback(current, { id, action, success, errorKey }));
  }, [attempts]);
  return <FeedbackContext.Provider value={notify}>
    {children}
    <div className="pointer-events-none fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-4 z-[100] grid w-[min(24rem,calc(100vw-2rem))] gap-2">
      {notifications.map((item) => <ActionNotification key={item.id} item={item} dismiss={dismiss} />)}
    </div>
  </FeedbackContext.Provider>;
}

function ActionNotification({ item, dismiss }: { item: Notification; dismiss: (id: number) => void }) {
  const { t } = useTranslation(["common", "admin"]);
  const [timer] = useState(() => new FeedbackTimer(item.success ? FEEDBACK_SUCCESS_MS : null, () => dismiss(item.id)));
  const [swipe] = useState(() => new FeedbackSwipe());
  useEffect(() => {
    timer.start();
    return () => { timer.stop(); swipe.cancel(); };
  }, [timer, swipe]);
  const cancelSwipe = () => { swipe.cancel(); timer.resume("swipe"); };
  return <div className={`pointer-events-auto flex touch-pan-y items-start justify-between gap-3 rounded-panel border bg-bg-surface p-4 ${item.success ? "border-severity-low" : "border-severity-critical"}`}
    onPointerEnter={(event) => { if (event.pointerType === "mouse") timer.pause("hover"); }}
    onPointerLeave={(event) => { if (event.pointerType === "mouse") timer.resume("hover"); }}
    onFocusCapture={() => timer.pause("focus")}
    onBlurCapture={(event) => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) timer.resume("focus");
    }}
    onPointerDown={(event) => {
      if (!event.isPrimary) { cancelSwipe(); return; }
      if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
      if (event.target instanceof Element && event.target.closest("button")) return;
      if (!swipe.begin(event.pointerId, event.clientX, event.clientY)) { timer.resume("swipe"); return; }
      timer.pause("swipe");
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { cancelSwipe(); }
    }}
    onPointerMove={(event) => swipe.move(event.pointerId, event.clientX, event.clientY)}
    onPointerUp={(event) => {
      if (!swipe.owns(event.pointerId)) return;
      const dismissed = swipe.end(event.pointerId, event.clientX, event.clientY);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      if (dismissed) dismiss(item.id);
      else timer.resume("swipe");
    }}
    onPointerCancel={cancelSwipe} onLostPointerCapture={cancelSwipe}>
    <p role={item.success ? "status" : "alert"} aria-atomic="true" className="min-w-0 flex-1 break-words text-body">{t(item.success ? `mutation.success.${item.action}` : item.errorKey)}</p>
    <button type="button" className="flex h-12 w-12 shrink-0 items-center justify-center rounded-control border border-border text-text-primary hover:border-accent hover:bg-bg-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      aria-label={t("actions.close")} onClick={() => dismiss(item.id)}>
      <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 6 12 12M18 6 6 18" /></svg>
    </button>
  </div>;
}
export function useActionFeedback() { return useContext(FeedbackContext); }
export function LoadingSpinner() {
  return <span aria-hidden="true" className="mr-2 inline-block h-4 w-4 shrink-0 rounded-full border-2 border-current border-r-transparent motion-safe:animate-spin" />;
}
