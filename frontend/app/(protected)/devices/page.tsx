import { NetworkHealthTargets } from "@/components/admin/network-health-targets";
import { DeviceInventory } from "@/components/devices/device-inventory";
import { requireApprovedProfile } from "@/lib/auth";
import { loadNetworkNodes } from "@/lib/network-nodes";

export const dynamic = "force-dynamic";

type DevicesPageProps = {
  searchParams: Promise<{
    device_notice?: string;
    device_error?: string;
    health_notice?: string;
    health_error?: string;
  }>;
};

export default async function DevicesPage({ searchParams }: DevicesPageProps) {
  const { supabase, profile } = await requireApprovedProfile();
  const params = await searchParams;
  const [inventory, runnersResult, targetsResult] = await Promise.all([
    loadNetworkNodes(supabase),
    supabase.from("diagnostic_runners").select("id,display_name").order("display_name"),
    supabase.from("network_targets").select("id,node_id,runner_id,enabled,critical,probe_interval_seconds,timeout_ms,failure_threshold,recovery_threshold,latency_warning_ms,loss_warning_percent").order("created_at"),
  ]);

  return <main className="p-4 md:p-6">
    <DeviceInventory nodes={inventory.data} canManage={profile.role === "admin"} notice={params.device_notice} error={inventory.error ? "load-failed" : params.device_error} />
    <NetworkHealthTargets
      nodes={inventory.data}
      runners={runnersResult.data ?? []}
      targets={targetsResult.data ?? []}
      canManage={profile.role === "admin"}
      notice={params.health_notice}
      error={targetsResult.error || runnersResult.error ? "load-failed" : params.health_error}
    />
  </main>;
}
