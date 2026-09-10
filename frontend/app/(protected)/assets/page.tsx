import { AssetInventory } from "@/components/assets/asset-inventory";
import { DeviceProfileProvider } from "@/components/device-profile/device-profile-provider";
import { NetworkNodesProvider } from "@/components/diagnostics/network-nodes-provider";
import { requireApprovedProfile } from "@/lib/auth";
import { canOperateNetwork } from "@/lib/authorization";
import type { InspectorRunner } from "@/lib/device-inspector";
import { loadAssetInventory, loadAssetScanState, type AssetInventoryQuery } from "@/lib/assets";
import { loadNetworkNodes } from "@/lib/network-nodes";

export const dynamic = "force-dynamic";

type ManagedTargetContextRow = {
  id: string;
  network_nodes: { name: string; ip_address: string } | { name: string; ip_address: string }[];
};

export default async function AssetsPage({ searchParams }: { searchParams: Promise<AssetInventoryQuery> }) {
  const { supabase, profile } = await requireApprovedProfile();
  const query = await searchParams;
  const [result, scan, nodes, runnersResult, managedTargetsResult, healthTargetsResult] = await Promise.all([
    loadAssetInventory(query),
    loadAssetScanState(),
    loadNetworkNodes(supabase),
    supabase.from("diagnostic_runners").select("id,display_name,last_seen_at,health_status,capabilities").order("display_name").returns<InspectorRunner[]>(),
    supabase.from("managed_telemetry_targets").select("id,network_nodes!inner(name,ip_address)").returns<ManagedTargetContextRow[]>(),
    supabase.from("network_targets").select("id").eq("enabled", true).returns<{ id: string }[]>(),
  ]);
  const canOperate = canOperateNetwork(profile.role);
  const runners = runnersResult.data ?? [];
  const inspectorAvailable = runners.some((runner) => runner.capabilities.operations?.includes("device_inspect"));
  const managedTargets = (managedTargetsResult.data ?? []).map((target) => {
    const node = Array.isArray(target.network_nodes) ? target.network_nodes[0] : target.network_nodes;
    return { id: target.id, context: node ? `${node.name} · ${node.ip_address}` : null };
  });
  return <main className="p-4 md:p-6">
    <NetworkNodesProvider initialNodes={nodes.data} loadError={nodes.error} role={profile.role}>
      <DeviceProfileProvider role={profile.role} runners={runners}>
        <AssetInventory
          canInspect={canOperate}
          inspectorAvailable={inspectorAvailable}
          managedTargets={managedTargets}
          healthTargetIds={(healthTargetsResult.data ?? []).map((target) => target.id)}
          canScan={canOperate}
          data={result.data}
          error={result.error}
          query={query}
          scanError={scan.error}
          scanState={scan.data}
        />
      </DeviceProfileProvider>
    </NetworkNodesProvider>
  </main>;
}
