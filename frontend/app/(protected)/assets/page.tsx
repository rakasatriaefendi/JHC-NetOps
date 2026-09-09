import { AssetInventory } from "@/components/assets/asset-inventory";
import { requireApprovedProfile } from "@/lib/auth";
import { loadAssetInventory, type AssetInventoryQuery } from "@/lib/assets";

export const dynamic = "force-dynamic";

export default async function AssetsPage({ searchParams }: { searchParams: Promise<AssetInventoryQuery> }) {
  await requireApprovedProfile();
  const query = await searchParams;
  const result = await loadAssetInventory(query);
  return <main className="p-4 md:p-6"><AssetInventory data={result.data} error={result.error} query={query} /></main>;
}
