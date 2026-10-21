import { getServerTranslation } from "@/i18n/server";
import { SkeletonText, SkeletonBlock, SkeletonDetail } from "@/components/ui/skeleton";

export default async function ProfileLoading() {
  const { t } = await getServerTranslation("common");
  return (
    <main className="mx-auto w-full max-w-2xl p-4 md:p-6" aria-label={t("loading")}>
      <SkeletonText width="150px" />
      <SkeletonText width="300px" lines={2} style={{ marginTop: 8 }} />

      <div className="mt-6 space-y-4">
        <SkeletonBlock height={48} className="rounded-panel border border-border bg-bg-surface p-4" />
        <SkeletonDetail />
      </div>
    </main>
  );
}