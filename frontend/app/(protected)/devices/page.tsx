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
    supabase.from("network_targets").select("id,node_id,runner_id,enabled,critical,probe_interval_seconds,timeout_ms,failure_threshold,recovery_threshold,latency_warning_ms,loss_warning_percent,network_health_latest(status,last_checked_at)").order("created_at"),
  ]);

  return <main className="p-4 md:p-6">
    <DeviceInventory
      nodes={inventory.data}
      runners={runnersResult.data ?? []}
      targets={targetsResult.data ?? []}
      canManage={profile.role === "admin"}
      deviceNotice={params.device_notice}
      deviceError={inventory.error ? "load-failed" : params.device_error}
      healthNotice={params.health_notice}
      healthError={targetsResult.error || runnersResult.error ? "load-failed" : params.health_error}
    />
  </main>;
}
