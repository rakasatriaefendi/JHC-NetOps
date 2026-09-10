import { AssetInventory } from "@/components/assets/asset-inventory";
import { requireApprovedProfile } from "@/lib/auth";
import { canOperateNetwork } from "@/lib/authorization";
import { loadAssetInventory, loadAssetScanState, type AssetInventoryQuery } from "@/lib/assets";

export const dynamic = "force-dynamic";

export default async function AssetsPage({ searchParams }: { searchParams: Promise<AssetInventoryQuery> }) {
  const { profile } = await requireApprovedProfile();
  const query = await searchParams;
  const [result, scan] = await Promise.all([loadAssetInventory(query), loadAssetScanState()]);
  return <main className="p-4 md:p-6"><AssetInventory canScan={canOperateNetwork(profile.role)} data={result.data} error={result.error} query={query} scanError={scan.error} scanState={scan.data} /></main>;
}
