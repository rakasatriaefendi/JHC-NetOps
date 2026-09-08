import { UserAccessControl } from "@/components/admin/user-access-control";
import { StatusBadge } from "@/components/ui/status-badge";
import { requireAdminProfile, type Profile } from "@/lib/auth";
import { getServerTranslation } from "@/i18n/server";

type AdminPageProps = {
  searchParams: Promise<{
    error?: string;
    notice?: string;
  }>;
};

export default async function AdminPage({ searchParams }: AdminPageProps) {
  const { t, locale } = await getServerTranslation("admin");
  const { supabase, userId } = await requireAdminProfile();
  const params = await searchParams;
  const { data } = await supabase
    .from("profiles")
    .select("id, email, full_name, role, status, created_at, approved_at, approved_by")
    .order("created_at", { ascending: true })
    .returns<Profile[]>();
  const profiles = data ?? [];
  const approvedCount = profiles.filter(
    (profile) => profile.status === "approved",
  ).length;
  const pendingCount = profiles.filter(
    (profile) => profile.status === "pending",
  ).length;
  const suspendedCount = profiles.filter(
    (profile) => profile.status === "rejected",
  ).length;

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
        <div className="flex gap-4 font-data text-meta text-text-muted">
          <span>{t("page.activeCount", { count: approvedCount })}</span>
          <span>{t("page.pendingCount", { count: pendingCount })}</span>
          <span>{t("page.suspendedCount", { count: suspendedCount })}</span>
          <span>{t("page.userCount", { count: profiles.length })}</span>
        </div>
      </div>

      {params.notice ? (
        <p role="status" className="mt-4 text-body text-severity-low">
          {t("page.saved")}
        </p>
      ) : null}
      {params.error ? (
        <p role="alert" className="mt-4 text-body text-severity-critical">
          {t("page.saveError")}
        </p>
      ) : null}

      <section className="mt-6 grid gap-4">
        {profiles.length === 0 ? (
          <div className="rounded-panel border border-border bg-bg-surface p-6">
            <p className="text-text-secondary">{t("page.empty")}</p>
          </div>
        ) : (
          profiles.map((profile) => (
            <article
              key={profile.id}
              className="rounded-panel border border-border bg-bg-surface p-4"
            >
              <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-3">
                    <h2 className="text-section font-medium">
                      {profile.full_name ?? t("page.unnamed")}
                    </h2>
                    <StatusBadge status={profile.status} />
                    <span className="rounded-full border border-border px-3 py-1 text-meta capitalize text-text-secondary">{profile.role}</span>
                  </div>
                  <p className="mt-2 truncate font-data text-meta text-text-secondary">
                    {profile.email}
                  </p>
                  <p className="mt-1 font-data text-meta text-text-muted">
                    {new Intl.DateTimeFormat(locale, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }).format(new Date(profile.created_at))}
                  </p>
                </div>

                <UserAccessControl
                  userId={profile.id}
                  role={profile.role}
                  status={profile.status}
                  isCurrentUser={profile.id === userId}
                />
              </div>
            </article>
          ))
        )}
      </section>
    </main>
  );
}
