import { getServerTranslation } from "@/i18n/server";
import { SkeletonChart, SkeletonBlock, SkeletonText, SkeletonTable } from "@/components/ui/skeleton";

export default async function TrafficLoading() {
  const { t } = await getServerTranslation("traffic");
  return (
    <main className="min-w-0 max-w-full p-4 md:p-6" aria-label={t("loading")}>
      <SkeletonText width="200px" />
      <SkeletonText width="300px" lines={2} style={{ marginTop: 8 }} />
      <SkeletonText width="400px" lines={2} style={{ marginTop: 8 }} />

      <div className="mt-6 space-y-6">
        <SkeletonChart height={300} />
        <SkeletonBlock height={48} className="rounded-panel border border-border bg-bg-surface" />
        <SkeletonTable rows={10} columns={6} />
      </div>
    </main>
  );
}