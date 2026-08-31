import { ViewerAccessControl } from "@/components/admin/viewer-access-control";
import { StatusBadge } from "@/components/ui/status-badge";
import { requireAdminProfile, type Profile } from "@/lib/auth";

type AdminPageProps = {
  searchParams: Promise<{
    error?: string;
    notice?: string;
  }>;
};

export default async function AdminPage({ searchParams }: AdminPageProps) {
  const { supabase } = await requireAdminProfile();
  const params = await searchParams;
  const { data } = await supabase
    .from("profiles")
    .select("id, email, full_name, role, status, created_at, approved_at, approved_by")
    .eq("role", "viewer")
    .order("created_at", { ascending: true })
    .returns<Profile[]>();
  const viewerProfiles = data ?? [];
  const approvedCount = viewerProfiles.filter(
    (profile) => profile.status === "approved",
  ).length;
  const pendingCount = viewerProfiles.filter(
    (profile) => profile.status === "pending",
  ).length;

  return (
    <main className="p-4 md:p-6">
      <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-meta font-medium uppercase tracking-wide text-accent">
            Access control
          </p>
          <h1 className="mt-2 text-heading font-semibold">Akses pengguna</h1>
          <p className="mt-2 text-text-secondary">
            Berikan atau cabut akses dashboard untuk akun viewer. Akun admin
            tidak ditampilkan di sini.
          </p>
        </div>
        <div className="flex gap-4 font-data text-meta text-text-muted">
          <span>{approvedCount} aktif</span>
          <span>{pendingCount} pending</span>
          <span>{viewerProfiles.length} viewer</span>
        </div>
      </div>

      {params.notice ? (
        <p role="status" className="mt-4 text-body text-severity-low">
          {params.notice === "enabled"
            ? "Akses viewer berhasil diberikan."
            : "Akses viewer berhasil dicabut."}
        </p>
      ) : null}
      {params.error ? (
        <p role="alert" className="mt-4 text-body text-severity-critical">
          Status gagal diperbarui. Coba lagi atau periksa policy RLS.
        </p>
      ) : null}

      <section className="mt-6 grid gap-4">
        {viewerProfiles.length === 0 ? (
          <div className="rounded-panel border border-border bg-bg-surface p-6">
            <p className="text-text-secondary">Belum ada akun viewer.</p>
          </div>
        ) : (
          viewerProfiles.map((profile) => (
            <article
              key={profile.id}
              className="rounded-panel border border-border bg-bg-surface p-4"
            >
              <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-3">
                    <h2 className="text-section font-medium">
                      {profile.full_name ?? "Tanpa nama"}
                    </h2>
                    <StatusBadge status={profile.status} />
                  </div>
                  <p className="mt-2 truncate font-data text-meta text-text-secondary">
                    {profile.email}
                  </p>
                  <p className="mt-1 font-data text-meta text-text-muted">
                    {new Intl.DateTimeFormat("id-ID", {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }).format(new Date(profile.created_at))}
                  </p>
                </div>

                <ViewerAccessControl
                  userId={profile.id}
                  enabled={profile.status === "approved"}
                />
              </div>
            </article>
          ))
        )}
      </section>
    </main>
  );
}
