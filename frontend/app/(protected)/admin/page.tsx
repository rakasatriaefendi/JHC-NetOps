import { normalizedProfile, requireAdminProfile, type Profile } from "@/lib/auth";
import { localProfiles } from "@/lib/application-persistence";
import { getServerTranslation } from "@/i18n/server";
import { ReportBrandingSettings } from "@/components/admin/report-branding-settings";
import { loadReportBranding } from "@/lib/report-branding";
import { loadAdministrativeAudit } from "@/lib/administrative-audit";
import { AdministrativeAuditCompact } from "@/components/admin/administrative-audit-compact";
import { UserAccessTable } from "@/components/admin/user-access-table";

type AdminPageProps = {
  searchParams: Promise<{
    error?: string;
    notice?: string;
    audit_page?: string;
  }>;
};

export default async function AdminPage({ searchParams }: AdminPageProps) {
  const { t } = await getServerTranslation("admin");
  const { userId } = await requireAdminProfile();
  const params = await searchParams;
  const auditPage = typeof params.audit_page === "string" && /^\d{1,3}$/.test(params.audit_page) ? Math.min(200, Number(params.audit_page)) : 0;
  const [profiles, branding, audit] = await Promise.all([
    localProfiles().then((rows) => (rows ?? []).map(normalizedProfile).filter((row): row is Profile => row !== null)),
    loadReportBranding(),
    loadAdministrativeAudit(userId, auditPage),
  ]);
  const approvedCount = profiles.filter(
    (profile) => profile.status === "approved",
  ).length;
  const pendingCount = profiles.filter(
    (profile) => profile.status === "pending",
  ).length;
  const suspendedCount = profiles.filter(
    (profile) => profile.status === "rejected",
  ).length;
  const disabledCount = profiles.filter((profile) => profile.status === "disabled").length;
  const lifecycleErrors = new Set(["ADMIN_ACCESS_REQUIRED", "SELF_DELETE_BLOCKED", "SELF_DISABLE_BLOCKED",
    "LAST_LOGIN_CAPABLE_ADMIN_BLOCKED", "ACCOUNT_HAS_HISTORY", "ACCOUNT_NOT_DISABLEABLE",
    "ACCOUNT_NOT_REENABLEABLE", "ACCOUNT_NOT_DELETABLE", "PROFILE_NOT_FOUND"]);

  return (
    <main className="p-4 md:p-6">
      <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-meta font-medium uppercase tracking-wide text-accent">
            {t("page.eyebrow")}
          </p>
          <h1 className="mt-2 text-heading font-semibold">{t("page.title")}</h1>
          <p className="mt-2 text-text-secondary">
            {t("page.description")}
          </p>
        </div>
        <div className="flex flex-wrap gap-4 font-data text-meta text-text-muted">
          <span>{t("page.activeCount", { count: approvedCount })}</span>
          <span>{t("page.pendingCount", { count: pendingCount })}</span>
          <span>{t("page.suspendedCount", { count: suspendedCount })}</span>
          <span>{t("lifecycle.disabledCount", { count: disabledCount })}</span>
          <span>{t("page.userCount", { count: profiles.length })}</span>
        </div>
      </div>

      {params.notice === "saved" && !params.error ? (
        <p role="status" className="mt-4 text-body text-severity-low">
          {t("lifecycle.saved")}
        </p>
      ) : null}
      {params.error ? (
        <p role="alert" className="mt-4 text-body text-severity-critical">
          {lifecycleErrors.has(params.error) ? t(`lifecycle.errors.${params.error}`) : t("lifecycle.failed")}
        </p>
      ) : null}

      <ReportBrandingSettings initial={branding.data} />
      <AdministrativeAuditCompact entries={audit.entries} page={auditPage} more={audit.more} error={audit.error} />

      <UserAccessTable
        profiles={profiles}
        currentUserId={userId}
        notice={params.notice}
        error={params.error}
      />
    </main>
  );
}