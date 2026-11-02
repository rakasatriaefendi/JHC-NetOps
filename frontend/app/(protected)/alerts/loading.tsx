import { getServerTranslation } from "@/i18n/server";
import { SkeletonText, SkeletonBlock, SkeletonList } from "@/components/ui/skeleton";

export default async function AlertsLoading() {
  const { t } = await getServerTranslation("alerts");
  return (
    <main className="p-4 md:p-6" aria-label={t("loading")}>
      <SkeletonText width="200px" />
      <SkeletonText width="300px" lines={2} style={{ marginTop: 8 }} />
      <SkeletonText width="400px" lines={2} style={{ marginTop: 8 }} />

      <div className="mt-6">
        <SkeletonBlock height={48} className="rounded-panel border border-border bg-bg-surface" />
        <SkeletonList items={8} itemHeight={60} />
      </div>
    </main>
  );
}