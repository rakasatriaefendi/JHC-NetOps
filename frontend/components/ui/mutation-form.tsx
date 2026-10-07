"use client";

import { createContext, useContext, useRef, useState, type FormHTMLAttributes, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { MutationGate, type FormMutationResult, type MutationKind } from "@/lib/mutation-feedback";
import { Button } from "./button";
import { LoadingSpinner, useActionFeedback } from "./action-feedback";

const PendingContext = createContext<{ pending: boolean; kind: MutationKind }>({ pending: false, kind: "save" });
export function useMutationPending() { return useContext(PendingContext); }

export function MutationForm({ action, kind = "save", children, onSubmit, ...props }:
  Omit<FormHTMLAttributes<HTMLFormElement>, "action"> & {
    action: (form: FormData) => Promise<FormMutationResult>; kind?: MutationKind; children: ReactNode;
  }) {
  const gate = useRef(new MutationGate());
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const notify = useActionFeedback();
  return <PendingContext.Provider value={{ pending, kind }}><form {...props} aria-busy={pending} onSubmit={async (event) => {
    if (submitting.current) { event.preventDefault(); return; }
    onSubmit?.(event); // Existing destructive confirmation precedes any submission.
    if (event.defaultPrevented) return;
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    submitting.current = true;
    setPending(true);
    try { await gate.current.run(() => action(data), (success, code) => notify(kind, success, code)); }
    finally { submitting.current = false; setPending(false); }
    // Manual submit deliberately avoids React's automatic uncontrolled-form reset
    // on a returned validation error. Safe user-entered fields remain intact.
  }}>{children}</form></PendingContext.Provider>;
}

export function PendingSubmit({ children, disabled, ...props }: Parameters<typeof Button>[0]) {
  const { pending, kind } = useMutationPending();
  const { t } = useTranslation("common");
  return <Button {...props} type="submit" disabled={disabled || pending} aria-disabled={disabled || pending} aria-busy={pending}>
    {pending ? <><LoadingSpinner />{t(`mutation.pending.${kind}`)}</> : children}
  </Button>;
}
