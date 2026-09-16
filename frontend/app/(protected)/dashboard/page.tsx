import { NetworkHealthDashboard } from "@/components/dashboard/network-health-dashboard";
import { DiagnosticsSummary } from "@/components/dashboard/diagnostics-summary";
import { LocalTrafficSummary } from "@/components/dashboard/local-traffic-summary";
import { NetworkNodesProvider } from "@/components/diagnostics/network-nodes-provider";
import { DeviceProfileProvider } from "@/components/device-profile/device-profile-provider";
import { requireApprovedProfile } from "@/lib/auth";
import { loadDiagnostics } from "@/lib/diagnostics";
import { loadDiscoverySessions } from "@/lib/network-discovery";
import { observedTrafficIps } from "@/lib/network-discovery-client";
import { loadNetworkHealth, loadHealthSamples } from "@/lib/network-health";
import { loadNetworkNodes } from "@/lib/network-nodes";
import { loadTrafficState } from "@/lib/traffic";
import { canOperateNetwork } from "@/lib/authorization";
import { getServerTranslation } from "@/i18n/server";

export const dynamic = "force-dynamic";

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ target?: string }> }) {
  const { t } = await getServerTranslation("dashboard");
  const { supabase, profile } = await requireApprovedProfile();
  const params = await searchParams;
  const canOperate = canOperateNetwork(profile.role);
  const health = await loadNetworkHealth(supabase);
  const [diagnostics, traffic, nodes, discovery, samples] = await Promise.all([
    loadDiagnostics(supabase),
    loadTrafficState(supabase, profile.role),
    loadNetworkNodes(supabase),
    loadDiscoverySessions(supabase, canOperate),
    loadHealthSamples(supabase, health.data.map((t) => t.id), "1h"),
  ]);

  return (
    <main className="p-4 md:p-6">
      <p className="text-meta font-medium uppercase tracking-wide text-accent">
        {t("page.eyebrow")}
      </p>
      <h1 className="mt-2 text-heading font-semibold">{t("page.title")}</h1>
      <p className="mt-2 text-text-secondary">
        {t("page.description")}
      </p>

      <NetworkNodesProvider initialNodes={nodes.data} loadError={nodes.error} role={profile.role}>
        <DeviceProfileProvider role={profile.role} runners={traffic.data.runners}>
        <LocalTrafficSummary initialState={traffic.data} loadError={traffic.error} />
        <NetworkHealthDashboard
          targets={health.data}
          events={health.events}
          samples={samples.data ?? []}
          loadError={health.error || discovery.error}
          isAdmin={canOperate}
          discoveryRunners={traffic.data.runners}
          discoverySessions={discovery.data}
          trafficIps={observedTrafficIps(traffic.data.snapshots)}
          {...(params.target ? { initialTargetId: params.target } : {})}
        />
        <DiagnosticsSummary data={diagnostics.data} loadError={diagnostics.error} />
        </DeviceProfileProvider>
      </NetworkNodesProvider>
    </main>
  );
}
