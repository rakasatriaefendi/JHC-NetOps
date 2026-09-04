"use client";

import { useFormStatus } from "react-dom";

import { setUserAccessAction } from "@/app/actions/admin";
import { Button } from "@/components/ui/button";
import { accessStatusFromProfile, type ProfileRole, type ProfileStatus } from "@/lib/authorization";

export function UserAccessControl({ userId, role, status, isCurrentUser }: {
  userId: string;
  role: ProfileRole;
  status: ProfileStatus;
  isCurrentUser: boolean;
}) {
  return (
    <form action={setUserAccessAction} className="grid gap-3 sm:grid-cols-[minmax(9rem,1fr)_minmax(12rem,1fr)_auto] sm:items-end">
      <input type="hidden" name="user_id" value={userId} />
      <label className="grid gap-2 text-meta text-text-secondary">
        Role
        <select className="rounded-control border border-border bg-bg-base px-3 py-2 text-text-primary" defaultValue={role} disabled={isCurrentUser} name="role">
          <option value="admin">Admin</option>
          <option value="operator">Operator</option>
          <option value="viewer">Viewer</option>
        </select>
      </label>
      <label className="grid gap-2 text-meta text-text-secondary">
        Status akses
        <select className="rounded-control border border-border bg-bg-base px-3 py-2 text-text-primary" defaultValue={accessStatusFromProfile(status)} disabled={isCurrentUser} name="access_status">
          <option value="pending">Menunggu persetujuan</option>
          <option value="active">Aktif</option>
          <option value="suspended">Ditangguhkan</option>
        </select>
      </label>
      <SaveButton disabled={isCurrentUser} />
      {isCurrentUser ? <p className="text-meta text-text-muted sm:col-span-3">Akun Admin yang sedang digunakan tidak dapat menurunkan aksesnya sendiri.</p> : null}
    </form>
  );
}

function SaveButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return <Button disabled={disabled || pending} type="submit">{pending ? "Menyimpan…" : "Simpan"}</Button>;
}
