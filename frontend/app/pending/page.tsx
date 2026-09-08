import { logoutAction } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { getAuthenticatedProfile } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getServerTranslation } from "@/i18n/server";

export default async function PendingPage() {
  const { t } = await getServerTranslation(["auth", "common"]);
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
          {isRejected ? t("pending.rejectedTitle") : t("pending.waitingTitle")}
        </h1>
        <p className="mt-3 text-text-secondary">
          {isRejected
            ? t("pending.rejectedDescription")
            : t("pending.waitingDescription")}
        </p>
        {profile ? (
          <p className="mt-4 font-data text-meta text-text-muted">{profile.email}</p>
        ) : (
          <p className="mt-4 text-meta text-severity-critical">
            {t("pending.profileMissing")}
          </p>
        )}
        <form action={logoutAction} className="mt-6">
          <Button variant="secondary" type="submit">
            {t("common:actions.signOut")}
          </Button>
        </form>
      </section>
    </main>
  );
}
