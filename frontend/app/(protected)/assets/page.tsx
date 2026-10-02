import { AssetInventory } from "@/components/assets/asset-inventory";
import { DeviceProfileProvider } from "@/components/device-profile/device-profile-provider";
import { NetworkNodesProvider } from "@/components/diagnostics/network-nodes-provider";
import { requireApprovedProfile } from "@/lib/auth";
import { canOperateNetwork } from "@/lib/authorization";
import type { InspectorRunner } from "@/lib/device-inspector";
import { loadAssetInventory, loadAssetScanState, type AssetInventoryQuery } from "@/lib/assets";
import { loadAuthoritativeNetworkNodes } from "@/lib/network-nodes-source";
import { loadMedicalNetworkLinks } from "@/lib/medical-equipment";
import { localHealthTargets, localManagedTargets, localRunners } from "@/lib/application-persistence";

export const dynamic = "force-dynamic";

type ManagedTargetContextRow = {
  id: string;
  network_nodes: { name: string; ip_address: string } | { name: string; ip_address: string }[];
};

export default async function AssetsPage({ searchParams }: { searchParams: Promise<AssetInventoryQuery> }) {
  const { profile } = await requireApprovedProfile();
  const query = await searchParams;
  const [result, scan, nodes, context] = await Promise.all([
    loadAssetInventory(query),
    loadAssetScanState(),
    loadAuthoritativeNetworkNodes(),
    loadAssetContext(),
  ]);
  const canOperate = canOperateNetwork(profile.role);
  const medicalLinksResult = result.data ? await loadMedicalNetworkLinks(result.data.items.map((asset) => asset.id)) : { data: [], error: null };
  const runners = context.runners;
  const inspectorAvailable = runners.some((runner) => runner.capabilities.operations?.includes("device_inspect"));
  const managedTargets = context.managedTargets.map((target) => {
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
          healthTargetIds={context.healthTargetIds}
          medicalLinks={medicalLinksResult.data ?? []}
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

async function loadAssetContext(): Promise<{
  runners: InspectorRunner[];
  managedTargets: ManagedTargetContextRow[];
  healthTargetIds: string[];
}> {
  const [runners, managedTargets, healthTargets] = await Promise.all([
    localRunners(), localManagedTargets(), localHealthTargets(),
  ]);
  return {
    runners: (runners ?? []) as InspectorRunner[],
    managedTargets: (managedTargets ?? []).map((target) => ({
      id: String(target.id),
      network_nodes: target.node as ManagedTargetContextRow["network_nodes"],
    })),
    healthTargetIds: (healthTargets ?? []).filter((target) => target.enabled === true)
      .map((target) => String(target.id)),
  };
}
