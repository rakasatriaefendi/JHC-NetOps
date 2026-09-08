"use client";

import { useFormStatus } from "react-dom";
import { useTranslation } from "react-i18next";

import { setUserAccessAction } from "@/app/actions/admin";
import { Button } from "@/components/ui/button";
import { accessStatusFromProfile, type ProfileRole, type ProfileStatus } from "@/lib/authorization";

export function UserAccessControl({ userId, role, status, isCurrentUser }: {
  userId: string;
  role: ProfileRole;
  status: ProfileStatus;
  isCurrentUser: boolean;
}) {
  const { t } = useTranslation(["admin", "common"]);
  return (
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
  );
}

function SaveButton({ disabled }: { disabled: boolean }) {
  const { t } = useTranslation("admin");
  const { pending } = useFormStatus();
  return <Button disabled={disabled || pending} type="submit">{pending ? t("access.saving") : t("access.save")}</Button>;
}
