import { logoutAction } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { getAuthenticatedProfile } from "@/lib/auth";
import { redirect } from "next/navigation";

export default async function PendingPage() {
  const { profile } = await getAuthenticatedProfile();

  if (profile?.status === "approved") {
    redirect("/dashboard");
  }

  const status = profile?.status ?? "pending";
  const isRejected = status === "rejected";

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <section className="w-full max-w-lg rounded-panel border border-border bg-bg-surface p-6 text-center">
        <StatusBadge status={status} />
        <h1 className="mt-6 text-heading font-semibold">
          {isRejected ? "Akses tidak disetujui" : "Menunggu persetujuan admin"}
        </h1>
        <p className="mt-3 text-text-secondary">
          {isRejected
            ? "Hubungi administrator jika status ini perlu ditinjau kembali."
            : "Akun sudah terdaftar, tetapi data jaringan tetap terkunci sampai admin menyetujui akses."}
        </p>
        {profile ? (
          <p className="mt-4 font-data text-meta text-text-muted">{profile.email}</p>
        ) : (
          <p className="mt-4 text-meta text-severity-critical">
            Profil belum tersedia. Pastikan migration dan trigger Supabase sudah diterapkan.
          </p>
        )}
        <form action={logoutAction} className="mt-6">
          <Button variant="secondary" type="submit">
            Keluar
          </Button>
        </form>
      </section>
    </main>
  );
}

