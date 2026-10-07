"use client";

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { MutationKind } from "@/lib/mutation-feedback";

type Notification = { id: number; action: MutationKind; success: boolean; errorKey: string };
const lifecycleErrors = new Set(["ADMIN_ACCESS_REQUIRED", "SELF_DELETE_BLOCKED", "SELF_DISABLE_BLOCKED",
  "LAST_LOGIN_CAPABLE_ADMIN_BLOCKED", "ACCOUNT_HAS_HISTORY", "ACCOUNT_NOT_DISABLEABLE",
  "ACCOUNT_NOT_REENABLEABLE", "ACCOUNT_NOT_DELETABLE", "PROFILE_NOT_FOUND"]);
const FeedbackContext = createContext<(action: MutationKind, success: boolean, code?: string) => void>(() => {});

/** Reuses the application's role=status/alert notification pattern; no toast SDK. */
export function ActionFeedbackProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation(["common", "admin"]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const nextId = useRef(0);
  const notify = useCallback((action: MutationKind, success: boolean, code?: string) => {
    const id = ++nextId.current;
    const errorKey = code && lifecycleErrors.has(code) ? `admin:lifecycle.errors.${code}` : "mutation.failed";
    setNotifications((current) => [...current.slice(-3), { id, action, success, errorKey }]);
  }, []);
  return <FeedbackContext.Provider value={notify}>
    {children}
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] grid w-[min(24rem,calc(100vw-2rem))] gap-2">
      {notifications.map((item) => <div key={item.id} className={`pointer-events-auto flex items-start justify-between gap-3 rounded-panel border bg-bg-surface p-4 shadow-lg ${item.success ? "border-severity-low" : "border-severity-critical"}`}>
        <p role={item.success ? "status" : "alert"} aria-atomic="true" className="text-body">{t(item.success ? `mutation.success.${item.action}` : item.errorKey)}</p>
        <button type="button" className="shrink-0 text-meta text-accent" aria-label={t("actions.close")} onClick={() => setNotifications((current) => current.filter((entry) => entry.id !== item.id))}>{t("actions.close")}</button>
      </div>)}
    </div>
  </FeedbackContext.Provider>;
}
export function useActionFeedback() { return useContext(FeedbackContext); }
export function LoadingSpinner() {
  return <span aria-hidden="true" className="mr-2 inline-block h-4 w-4 shrink-0 rounded-full border-2 border-current border-r-transparent motion-safe:animate-spin" />;
}
