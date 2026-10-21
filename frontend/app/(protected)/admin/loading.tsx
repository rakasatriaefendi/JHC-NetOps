import { getServerTranslation } from "@/i18n/server";
import { SkeletonText, SkeletonGrid, SkeletonBlock, SkeletonTable, SkeletonDetail } from "@/components/ui/skeleton";

export default async function AdminLoading() {
  const { t } = await getServerTranslation("admin");
  return (
    <main className="p-4 md:p-6" aria-label={t("loading")}>
      <SkeletonText width="200px" />
      <SkeletonText width="300px" lines={2} style={{ marginTop: 8 }} />
      <SkeletonText width="400px" lines={2} style={{ marginTop: 8 }} />

      <div className="mt-6 space-y-6">
        <SkeletonGrid items={5} itemClassName="p-4 text-center" />
        <SkeletonBlock height={48} className="rounded-control border border-dashed border-border bg-white/5" />
        <SkeletonDetail />
        <SkeletonTable rows={10} columns={5} />
      </div>
    </main>
  );
}