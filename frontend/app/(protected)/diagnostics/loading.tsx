import { getServerTranslation } from "@/i18n/server";
import { SkeletonBlock, SkeletonText, SkeletonGrid, SkeletonChart } from "@/components/ui/skeleton";

export default async function DiagnosticsLoading() {
  const { t } = await getServerTranslation("diagnostics");
  return (
    <main className="min-w-0 max-w-full p-4 md:p-6" aria-label={t("loading")}>
      <SkeletonText width="200px" />
      <SkeletonText width="300px" lines={2} style={{ marginTop: 8 }} />
      <SkeletonText width="400px" lines={2} style={{ marginTop: 8 }} />

      <div className="mt-6 space-y-6">
        <SkeletonGrid items={4} itemClassName="p-4" />
        <SkeletonBlock height={48} className="rounded-panel border border-border bg-bg-surface" />
        <SkeletonChart height={300} />
        <SkeletonBlock height={400} className="rounded-panel border border-border bg-bg-surface" />
      </div>
    </main>
  );
}