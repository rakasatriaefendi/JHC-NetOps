"use client";

import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { StatusBadge } from "@/components/ui/status-badge";
import { Button } from "@/components/ui/button";
import { UserAccessControlDrawer } from "@/components/admin/user-access-control";
import { type Profile, type ProfileRole, type ProfileStatus } from "@/lib/auth";

type Props = {
  profiles: Profile[];
  currentUserId: string;
  notice?: string;
  error?: string;
};

export function UserAccessTable({ profiles, currentUserId, notice, error }: Props) {
  const { t, i18n } = useTranslation(["admin", "common"]);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<ProfileRole | "all">("all");
  const [statusFilter, setStatusFilter] = useState<ProfileStatus | "all">("all");
  const [page, setPage] = useState(0);
  const pageSize = 20;
  const [editingUserId, setEditingUserId] = useState<string | null>(null);

  const filteredProfiles = useMemo(() => {
    return profiles.filter((profile) => {
      const matchesSearch = profile.full_name?.toLowerCase().includes(search.toLowerCase()) ||
        profile.email.toLowerCase().includes(search.toLowerCase());
      const matchesRole = roleFilter === "all" || profile.role === roleFilter;
      const matchesStatus = statusFilter === "all" || profile.status === statusFilter;
      return matchesSearch && matchesRole && matchesStatus;
    });
  }, [profiles, search, roleFilter, statusFilter]);

  const paginatedProfiles = useMemo(() => {
    return filteredProfiles.slice(page * pageSize, (page + 1) * pageSize);
  }, [filteredProfiles, page]);

  const totalPages = Math.ceil(filteredProfiles.length / pageSize);

  function handleEdit(userId: string) {
    setEditingUserId(userId);
  }

  function handleCloseEditor() {
    setEditingUserId(null);
  }

  return (
    <section className="mt-6" aria-labelledby="user-access-title">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <h2 id="user-access-title" className="text-section font-semibold">{t("page.title")}</h2>
        <div className="flex flex-wrap gap-2">
          <input
            type="search"
            placeholder={t("access.searchPlaceholder")}
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            className="min-w-[200px] rounded-control border border-border bg-bg-base px-3 py-2 text-text-primary placeholder:text-text-muted"
            aria-label={t("access.searchPlaceholder")}
          />
          <select
            value={roleFilter}
            onChange={(e) => { setRoleFilter(e.target.value as ProfileRole | "all"); setPage(0); }}
            className="rounded-control border border-border bg-bg-base px-3 py-2 text-text-primary"
            aria-label={t("access.roleFilter")}
          >
            <option value="all">{t("access.allRoles")}</option>
            <option value="admin">{t("common:roles.admin")}</option>
            <option value="operator">{t("common:roles.operator")}</option>
            <option value="viewer">{t("common:roles.viewer")}</option>
          </select>
          <select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value as ProfileStatus | "all"); setPage(0); }}
            className="rounded-control border border-border bg-bg-base px-3 py-2 text-text-primary"
            aria-label={t("access.statusFilter")}
          >
            <option value="all">{t("access.allStatus")}</option>
            <option value="pending">{t("common:status.pending")}</option>
            <option value="approved">{t("common:status.approved")}</option>
            <option value="rejected">{t("common:status.rejected")}</option>
            <option value="disabled">{t("common:status.disabled")}</option>
          </select>
        </div>
      </div>

      {notice === "saved" && !error ? (
        <p role="status" className="mt-4 text-body text-severity-low">{t("lifecycle.saved")}</p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-4 text-body text-severity-critical">{t(`lifecycle.errors.${error}`) ?? t("lifecycle.failed")}</p>
      ) : null}

      <div className="mt-4 overflow-x-auto rounded-control border border-border">
        <table className="w-full min-w-[800px] text-left">
          <thead className="bg-bg-surface text-meta text-text-secondary">
            <tr>
              <th className="p-3">{t("access.columns.user")}</th>
              <th className="p-3">{t("access.columns.role")}</th>
              <th className="p-3">{t("access.columns.status")}</th>
              <th className="p-3">{t("access.columns.registered")}</th>
              <th className="p-3 text-right">{t("access.columns.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {paginatedProfiles.length === 0 ? (
              <tr>
                <td className="p-6 text-center text-text-muted" colSpan={5}>{t("page.empty")}</td>
              </tr>
            ) : (
              paginatedProfiles.map((profile) => (
                <tr key={profile.id} className="border-t border-border bg-bg-base">
                  <td className="p-3">
                    <p className="font-medium">{profile.full_name ?? t("page.unnamed")}</p>
                    <p className="mt-1 truncate font-data text-meta text-text-secondary">{profile.email}</p>
                  </td>
                  <td className="p-3">
                    <span className="rounded-full border border-border px-3 py-1 text-meta capitalize text-text-secondary">{profile.role}</span>
                  </td>
                  <td className="p-3">
                    <StatusBadge status={profile.status} />
                  </td>
                  <td className="p-3 font-data text-meta text-text-muted">
                    {new Intl.DateTimeFormat(i18n.language, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }).format(new Date(profile.created_at))}
                  </td>
                  <td className="p-3 text-right">
                    <Button
                      variant="secondary"
                      onClick={() => handleEdit(profile.id)}
                      disabled={profile.id === currentUserId}
                      aria-disabled={profile.id === currentUserId}
                    >
                      {t("access.edit")}
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <nav className="mt-4 flex flex-wrap items-center gap-4 text-meta" aria-label={t("access.pagination")}>
          <span>{t("access.showing", { from: filteredProfiles.length > 0 ? page * pageSize + 1 : 0, to: Math.min((page + 1) * pageSize, filteredProfiles.length), total: filteredProfiles.length })}</span>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              className="px-3 py-1.5 text-meta"
              onClick={() => setPage(page - 1)}
              disabled={page === 0}
            >
              {t("common:actions.previous")}
            </Button>
            <span>{t("access.page", { page: page + 1, total: totalPages })}</span>
            <Button
              variant="secondary"
              className="px-3 py-1.5 text-meta"
              onClick={() => setPage(page + 1)}
              disabled={page >= totalPages - 1}
            >
              {t("common:actions.next")}
            </Button>
          </div>
        </nav>
      )}

      {editingUserId && (
        <UserAccessControlDrawer
          user={(() => {
            const profile = profiles.find((p) => p.id === editingUserId);
            if (!profile) return { id: editingUserId, role: "viewer" as ProfileRole, status: "pending" as ProfileStatus, name: "", email: "", isCurrentUser: false };
            return { id: profile.id, role: profile.role, status: profile.status, name: profile.full_name ?? "", email: profile.email, isCurrentUser: profile.id === currentUserId };
          })()}
          onClose={handleCloseEditor}
        />
      )}
    </section>
  );
}