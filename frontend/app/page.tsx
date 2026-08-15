import Link from "next/link";

export default function HomePage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <section className="w-full max-w-2xl rounded-panel border border-border bg-bg-surface p-6">
        <p className="text-meta font-medium uppercase tracking-wide text-accent">
          NetOps Monitor
        </p>
        <h1 className="mt-3 text-heading font-semibold">Network Monitoring Dashboard</h1>
        <p className="mt-3 max-w-xl text-text-secondary">
          Pantau kesehatan jaringan dan history insiden dari satu dashboard.
          Pengguna baru memerlukan persetujuan admin.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href="/login"
            className="rounded-control border border-accent bg-accent px-4 py-2 font-medium text-bg-base"
          >
            Masuk
          </Link>
          <Link
            href="/register"
            className="rounded-control border border-border px-4 py-2 font-medium text-text-primary hover:border-accent hover:text-accent"
          >
            Daftar
          </Link>
        </div>
      </section>
    </main>
  );
}

