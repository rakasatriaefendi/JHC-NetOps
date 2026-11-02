"use client";

import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { deleteUserAction, disableUserAction, reenableUserAction, setUserAccessAction } from "@/app/actions/admin";
import { MutationForm, PendingSubmit, useMutationPending } from "@/components/ui/mutation-form";
import { LoadingSpinner } from "@/components/ui/action-feedback";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { accountLifecycleAction, accessStatusFromProfile, type ProfileRole, type ProfileStatus } from "@/lib/authorization";

type Props = {
  userId: string;
  role: ProfileRole;
  status: ProfileStatus;
  isCurrentUser: boolean;
};

export function UserAccessControlRow({ userId, role, status, isCurrentUser }: Props) {
  const { t } = useTranslation(["admin", "common"]);
  const [confirmation, setConfirmation] = useState("");
  const confirmationId = useId();
  const lifecycle = accountLifecycleAction(status, isCurrentUser);

  if (status === "disabled") {
    return (
      <div className="grid gap-4">
        <p className="text-meta text-text-muted">{t("lifecycle.disabledHelp")}</p>
        {lifecycle === "reenable" ? (
          <MutationForm action={reenableUserAction} kind="reenable" className="grid gap-2 border-t border-border pt-3">
            <input type="hidden" name="user_id" value={userId} />
            <LifecycleButton label="reenable" variant="secondary" />
            <p className="text-meta text-text-muted">{t("lifecycle.reenableHelp")}</p>
          </MutationForm>
        ) : null}
        {lifecycle === "delete" ? (
          <details className="rounded-control border border-severity-critical p-3">
            <summary className="cursor-pointer text-body font-medium text-severity-critical">{t("lifecycle.delete")}</summary>
            <MutationForm action={deleteUserAction} kind="delete" className="mt-3 grid gap-3">
              <input type="hidden" name="user_id" value={userId} />
              <p className="text-meta text-severity-critical">{t("lifecycle.deleteWarning")}</p>
              <label htmlFor={confirmationId} className="text-meta text-text-secondary">{t("lifecycle.confirmation")}</label>
              <input id={confirmationId} name="confirmation" value={confirmation} onChange={(event) => setConfirmation(event.target.value)}
                required autoComplete="off" spellCheck={false}
                className="min-w-0 rounded-control border border-border bg-bg-base px-3 py-2 font-data text-text-primary" />
              <LifecycleButton label="delete" variant="destructive" disabled={confirmation !== "DELETE USER"} />
            </MutationForm>
          </details>
        ) : null}
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <MutationForm action={setUserAccessAction} className="grid gap-3 sm:grid-cols-[minmax(9rem,1fr)_minmax(12rem,1fr)_auto] sm:items-end">
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
      </MutationForm>
      {lifecycle === "disable" ? (
        <MutationForm action={disableUserAction} kind="disable" className="grid gap-2 border-t border-border pt-3">
          <input type="hidden" name="user_id" value={userId} />
          <LifecycleButton label="disable" variant="destructive" />
          <p className="text-meta text-text-muted">{t("lifecycle.disableHelp")}</p>
        </MutationForm>
      ) : null}
      {lifecycle === "reenable" ? (
        <MutationForm action={reenableUserAction} kind="reenable" className="grid gap-2 border-t border-border pt-3">
          <input type="hidden" name="user_id" value={userId} />
          <LifecycleButton label="reenable" variant="secondary" />
          <p className="text-meta text-text-muted">{t("lifecycle.reenableHelp")}</p>
        </MutationForm>
      ) : null}
      {lifecycle === "delete" ? (
        <details className="rounded-control border border-severity-critical p-3">
          <summary className="cursor-pointer text-body font-medium text-severity-critical">{t("lifecycle.delete")}</summary>
          <MutationForm action={deleteUserAction} kind="delete" className="mt-3 grid gap-3">
            <input type="hidden" name="user_id" value={userId} />
            <p className="text-meta text-severity-critical">{t("lifecycle.deleteWarning")}</p>
            <label htmlFor={confirmationId} className="text-meta text-text-secondary">{t("lifecycle.confirmation")}</label>
            <input id={confirmationId} name="confirmation" value={confirmation} onChange={(event) => setConfirmation(event.target.value)}
              required autoComplete="off" spellCheck={false}
              className="min-w-0 rounded-control border border-border bg-bg-base px-3 py-2 font-data text-text-primary" />
            <LifecycleButton label="delete" variant="destructive" disabled={confirmation !== "DELETE USER"} />
          </MutationForm>
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
  const { t } = useTranslation(["admin", "common"]);
  const { pending } = useMutationPending();
  return <Button type="submit" variant={variant} disabled={disabled || pending} aria-disabled={disabled || pending} aria-busy={pending}>
    {pending ? <><LoadingSpinner />{t(`common:mutation.pending.${label}`)}</> : t(`lifecycle.${label}`)}
  </Button>;
}

function SaveButton({ disabled }: { disabled: boolean }) {
  const { t } = useTranslation("admin");
  return <PendingSubmit disabled={disabled}>{t("access.save")}</PendingSubmit>;
}

export function UserAccessControlDrawer({ user, onClose }: {
  user: { id: string; role: ProfileRole; status: ProfileStatus; name: string; email: string; isCurrentUser: boolean };
  onClose: () => void;
}) {
  const { t } = useTranslation(["admin", "common"]);
  const [confirmation, setConfirmation] = useState("");
  const confirmationId = useId();
  const lifecycle = accountLifecycleAction(user.status, user.isCurrentUser);

  return (
    <Drawer open onClose={onClose} title={`${t("access.editTitle", { name: user.name })}`} maxWidth="max-w-lg">
      <div className="grid gap-4">
        <p className="text-meta text-text-secondary">{t("access.editDescription", { email: user.email })}</p>
        {user.status === "disabled" ? <p className="text-meta text-text-muted">{t("lifecycle.disabledHelp")}</p> : (
          <MutationForm action={setUserAccessAction} className="grid gap-3">
            <input type="hidden" name="user_id" value={user.id} />
            <label className="grid gap-2 text-meta text-text-secondary">
              {t("access.role")}
              <select className="rounded-control border border-border bg-bg-base px-3 py-2 text-text-primary" defaultValue={user.role} disabled={user.isCurrentUser} name="role">
                <option value="admin">Admin</option>
                <option value="operator">Operator</option>
                <option value="viewer">Viewer</option>
              </select>
            </label>
            <label className="grid gap-2 text-meta text-text-secondary">
              {t("access.status")}
              <select className="rounded-control border border-border bg-bg-base px-3 py-2 text-text-primary" defaultValue={accessStatusFromProfile(user.status)} disabled={user.isCurrentUser} name="access_status">
                <option value="pending">{t("common:status.pending")}</option>
                <option value="active">{t("common:status.approved")}</option>
                <option value="suspended">{t("common:status.rejected")}</option>
              </select>
            </label>
            <SaveButton disabled={user.isCurrentUser} />
            {user.isCurrentUser ? <p className="text-meta text-text-muted">{t("access.currentAccount")}</p> : null}
          </MutationForm>
        )}
        {lifecycle === "disable" ? (
          <MutationForm action={disableUserAction} kind="disable" className="grid gap-2 border-t border-border pt-3">
            <input type="hidden" name="user_id" value={user.id} />
            <LifecycleButton label="disable" variant="destructive" />
            <p className="text-meta text-text-muted">{t("lifecycle.disableHelp")}</p>
          </MutationForm>
        ) : null}
        {lifecycle === "reenable" ? (
          <MutationForm action={reenableUserAction} kind="reenable" className="grid gap-2 border-t border-border pt-3">
            <input type="hidden" name="user_id" value={user.id} />
            <LifecycleButton label="reenable" variant="secondary" />
            <p className="text-meta text-text-muted">{t("lifecycle.reenableHelp")}</p>
          </MutationForm>
        ) : null}
        {lifecycle === "delete" ? (
          <details className="rounded-control border border-severity-critical p-3">
            <summary className="cursor-pointer text-body font-medium text-severity-critical">{t("lifecycle.delete")}</summary>
            <MutationForm action={deleteUserAction} kind="delete" className="mt-3 grid gap-3">
              <input type="hidden" name="user_id" value={user.id} />
              <p className="text-meta text-severity-critical">{t("lifecycle.deleteWarning")}</p>
              <label htmlFor={confirmationId} className="text-meta text-text-secondary">{t("lifecycle.confirmation")}</label>
              <input id={confirmationId} name="confirmation" value={confirmation} onChange={(event) => setConfirmation(event.target.value)}
                required autoComplete="off" spellCheck={false}
                className="min-w-0 rounded-control border border-border bg-bg-base px-3 py-2 font-data text-text-primary" />
              <LifecycleButton label="delete" variant="destructive" disabled={confirmation !== "DELETE USER"} />
            </MutationForm>
          </details>
        ) : null}
      </div>
    </Drawer>
  );
}