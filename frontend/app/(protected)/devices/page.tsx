import { DeviceInventory, type DeviceHealthTarget } from "@/components/devices/device-inventory";
import { requireApprovedProfile } from "@/lib/auth";
import { loadAuthoritativeNetworkNodes } from "@/lib/network-nodes-source";
import { canOperateNetwork } from "@/lib/authorization";
import { applicationAuthority, localHealthTargets, localRunners } from "@/lib/application-persistence";
import type { SupabaseClient } from "@supabase/supabase-js";

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
  const [inventory, context] = await Promise.all([
    loadAuthoritativeNetworkNodes(supabase),
    loadDeviceContext(supabase),
  ]);

  return <main className="p-4 md:p-6">
    <DeviceInventory
      nodes={inventory.data}
      runners={context.runners}
      targets={context.targets}
      canManage={canOperateNetwork(profile.role)}
      deviceNotice={params.device_notice}
      deviceError={inventory.error ? "load-failed" : params.device_error}
      healthNotice={params.health_notice}
      healthError={context.error ? "load-failed" : params.health_error}
    />
  </main>;
}

async function loadDeviceContext(supabase: SupabaseClient) {
  if (applicationAuthority() === "local_postgres") {
    const [runners, targets] = await Promise.all([localRunners(), localHealthTargets()]);
    return {
      runners: (runners ?? []).map((runner) => ({ id: String(runner.id), display_name: String(runner.display_name) })),
      targets: (targets ?? []).map((target) => ({
        ...target,
        network_health_latest: target.latest ?? null,
      })) as DeviceHealthTarget[],
      error: !runners || !targets,
    };
  }
  const [runners, targets] = await Promise.all([
    supabase.from("diagnostic_runners").select("id,display_name").order("display_name"),
    supabase.from("network_targets").select("id,node_id,runner_id,enabled,critical,probe_interval_seconds,timeout_ms,failure_threshold,recovery_threshold,latency_warning_ms,loss_warning_percent,network_health_latest(status,last_checked_at)").order("created_at"),
  ]);
  return { runners: runners.data ?? [], targets: targets.data ?? [], error: Boolean(runners.error || targets.error) };
}
