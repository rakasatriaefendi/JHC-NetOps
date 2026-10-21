import { getServerTranslation } from "@/i18n/server";
import { SkeletonChart, SkeletonGrid, SkeletonTable, SkeletonBlock, SkeletonText } from "@/components/ui/skeleton";

export default async function DashboardLoading() {
  const { t } = await getServerTranslation("dashboard");
  return (
    <main className="p-4 md:p-6" aria-label={t("loading")}>
      <SkeletonText width="200px" />
      <SkeletonText width="300px" lines={2} style={{ marginTop: 8 }} />
      <SkeletonText width="400px" lines={2} style={{ marginTop: 8 }} />

      <SkeletonGrid items={5} style={{ marginTop: 24 }} itemClassName="p-4" />

      <div className="mt-6 space-y-6">
        <SkeletonChart height={400} />
        <SkeletonChart height={500} />
        <SkeletonBlock height={48} className="rounded-panel border border-border bg-bg-surface" />
        <SkeletonTable rows={8} columns={7} />
      </div>
    </main>
  );
}