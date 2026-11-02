import { getServerTranslation } from "@/i18n/server";
import { SkeletonGrid, SkeletonTable, SkeletonText } from "@/components/ui/skeleton";

export default async function DevicesLoading() {
  const { t } = await getServerTranslation("devices");
  return (
    <main className="p-4 md:p-6" aria-label={t("loading")}>
      <SkeletonText width="200px" />
      <SkeletonText width="300px" lines={2} style={{ marginTop: 8 }} />
      <SkeletonText width="400px" lines={2} style={{ marginTop: 8 }} />

      <SkeletonGrid items={4} style={{ marginTop: 24 }} itemClassName="p-4" />

      <div className="mt-6">
        <SkeletonTable rows={10} columns={8} />
      </div>
    </main>
  );
}