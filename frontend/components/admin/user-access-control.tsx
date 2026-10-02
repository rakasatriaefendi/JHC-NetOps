"use client";

import { useId, useState } from "react";
import { useFormStatus } from "react-dom";
import { useTranslation } from "react-i18next";

import { deleteUserAction, disableUserAction, reenableUserAction, setUserAccessAction } from "@/app/actions/admin";
import { Button } from "@/components/ui/button";
import { accountLifecycleAction, accessStatusFromProfile, type ProfileRole, type ProfileStatus } from "@/lib/authorization";

export function UserAccessControl({ userId, role, status, isCurrentUser }: {
  userId: string;
  role: ProfileRole;
  status: ProfileStatus;
  isCurrentUser: boolean;
}) {
  const { t } = useTranslation(["admin", "common"]);
  const [confirmation, setConfirmation] = useState("");
  const confirmationId = useId();
  const lifecycle = accountLifecycleAction(status, isCurrentUser);
  return (
    <div className="grid min-w-0 gap-4">
      {status === "disabled" ? <p className="text-meta text-text-muted">{t("lifecycle.disabledHelp")}</p> : (
        <form action={setUserAccessAction} className="grid gap-3 sm:grid-cols-[minmax(9rem,1fr)_minmax(12rem,1fr)_auto] sm:items-end">
          <input type="hidden" name="user_id" value={userId} />
          <label className="grid gap-2 text-meta text-text-secondary">
            {t("access.role")}
            <select className="rounded-control border border-border bg-bg-base px-3 py-2 text-text-primary" defaultValue={role} disabled={isCurrentUser} name="role">
              <option value="admin">Admin</option>
              <option value="operator">Operator</option>
              <option value="viewer">Viewer</option>
            </select>
          </label>
          <label className="grid gap-2 text-meta text-text-secondary">
            {t("access.status")}
            <select className="rounded-control border border-border bg-bg-base px-3 py-2 text-text-primary" defaultValue={accessStatusFromProfile(status)} disabled={isCurrentUser} name="access_status">
              <option value="pending">{t("common:status.pending")}</option>
              <option value="active">{t("common:status.approved")}</option>
              <option value="suspended">{t("common:status.rejected")}</option>
            </select>
          </label>
          <SaveButton disabled={isCurrentUser} />
          {isCurrentUser ? <p className="text-meta text-text-muted sm:col-span-3">{t("access.currentAccount")}</p> : null}
        </form>
      )}
      {lifecycle === "disable" ? (
        <form action={disableUserAction} className="grid gap-2 border-t border-border pt-3">
          <input type="hidden" name="user_id" value={userId} />
          <LifecycleButton label="disable" variant="destructive" />
          <p className="text-meta text-text-muted">{t("lifecycle.disableHelp")}</p>
        </form>
      ) : null}
      {lifecycle === "reenable" ? (
        <form action={reenableUserAction} className="grid gap-2 border-t border-border pt-3">
          <input type="hidden" name="user_id" value={userId} />
          <LifecycleButton label="reenable" variant="secondary" />
          <p className="text-meta text-text-muted">{t("lifecycle.reenableHelp")}</p>
        </form>
      ) : null}
      {lifecycle === "delete" ? (
        <details className="rounded-control border border-severity-critical p-3">
          <summary className="cursor-pointer text-body font-medium text-severity-critical">{t("lifecycle.delete")}</summary>
          <form action={deleteUserAction} className="mt-3 grid gap-3">
            <input type="hidden" name="user_id" value={userId} />
            <p className="text-meta text-severity-critical">{t("lifecycle.deleteWarning")}</p>
            <label htmlFor={confirmationId} className="text-meta text-text-secondary">{t("lifecycle.confirmation")}</label>
            <input id={confirmationId} name="confirmation" value={confirmation} onChange={(event) => setConfirmation(event.target.value)}
              required autoComplete="off" spellCheck={false}
              className="min-w-0 rounded-control border border-border bg-bg-base px-3 py-2 font-data text-text-primary" />
            <LifecycleButton label="delete" variant="destructive" disabled={confirmation !== "DELETE USER"} />
          </form>
        </details>
      ) : null}
    </div>
  );
}

function LifecycleButton({ label, variant, disabled = false }: {
  label: "disable" | "reenable" | "delete";
  variant: "secondary" | "destructive";
  disabled?: boolean;
}) {
  const { t } = useTranslation("admin");
  const { pending } = useFormStatus();
  return <Button type="submit" variant={variant} disabled={disabled || pending}>
    {pending ? t("lifecycle.working") : t(`lifecycle.${label}`)}
  </Button>;
}

function SaveButton({ disabled }: { disabled: boolean }) {
  const { t } = useTranslation("admin");
  const { pending } = useFormStatus();
  return <Button disabled={disabled || pending} type="submit">{pending ? t("access.saving") : t("access.save")}</Button>;
}
