import { getServerTranslation } from "@/i18n/server";
import { SkeletonBlock, SkeletonText, SkeletonTable } from "@/components/ui/skeleton";

export default async function HistoryLoading() {
  const { t } = await getServerTranslation("history");
  return (
    <main className="p-4 md:p-6" aria-label={t("loading")}>
      <SkeletonText width="200px" />
      <SkeletonText width="300px" lines={2} style={{ marginTop: 8 }} />
      <SkeletonText width="400px" lines={2} style={{ marginTop: 8 }} />

      <div className="mt-6 space-y-6">
        <SkeletonBlock height={48} className="rounded-control border border-border bg-bg-base p-4" />
        <SkeletonTable rows={8} columns={6} />
      </div>
    </main>
  );
}