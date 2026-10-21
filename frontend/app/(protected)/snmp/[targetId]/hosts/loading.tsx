import { getServerTranslation } from "@/i18n/server";
import { SkeletonGrid, SkeletonText, SkeletonTable } from "@/components/ui/skeleton";

export default async function ObservedHostsLoading() {
  const { t } = await getServerTranslation(["snmp", "common"]);
  return (
    <main className="p-4 md:p-6" aria-label={t("loading")}>
      <SkeletonText width="100px" style={{ marginBottom: 20 }} />
      <SkeletonText width="200px" />
      <SkeletonText width="300px" lines={2} style={{ marginTop: 8 }} />
      <SkeletonText width="400px" lines={2} style={{ marginTop: 8 }} />

      <div className="mt-6 space-y-6">
        <SkeletonGrid items={4} itemClassName="p-3" />
        <SkeletonTable rows={8} columns={6} />
      </div>
    </main>
  );
}