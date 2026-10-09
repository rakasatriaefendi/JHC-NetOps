import { NetworkHealthDashboard } from "@/components/dashboard/network-health-dashboard";
import { DiagnosticsSummary } from "@/components/dashboard/diagnostics-summary";
import { LocalTrafficSummary } from "@/components/dashboard/local-traffic-summary";
import { NetworkNodesProvider } from "@/components/diagnostics/network-nodes-provider";
import { DeviceProfileProvider } from "@/components/device-profile/device-profile-provider";
import { requireApprovedProfile } from "@/lib/auth";
import { getDiagnosticsAction } from "@/app/actions/diagnostics";
import { loadDiscoveryRunners, loadDiscoverySessions } from "@/lib/network-discovery";
import { observedTrafficIps } from "@/lib/network-discovery-client";
import { loadNetworkHealth, loadHealthSamples } from "@/lib/network-health";
import { loadAuthoritativeNetworkNodes } from "@/lib/network-nodes-source";
import { loadAuthoritativeTrafficState } from "@/lib/traffic-source";
import { canOperateNetwork } from "@/lib/authorization";
import { getServerTranslation } from "@/i18n/server";

export const dynamic = "force-dynamic";

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ target?: string }> }) {
  const { t } = await getServerTranslation("dashboard");
  const { profile } = await requireApprovedProfile();
  const params = await searchParams;
  const canOperate = canOperateNetwork(profile.role);
  const health = await loadNetworkHealth();
  const [diagnostics, traffic, nodes, discovery, samples] = await Promise.all([
    getDiagnosticsAction(),
    loadAuthoritativeTrafficState(profile.role),
    loadAuthoritativeNetworkNodes(),
    loadDiscoverySessions(canOperate),
    loadHealthSamples(health.data.map((t) => t.id), "1h"),
  ]);
  const discoveryRunners = await loadDiscoveryRunners(traffic.data.runners);

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
        <LocalTrafficSummary initialState={traffic.data} initialAuthority={traffic.authority} loadError={traffic.error} />
        <NetworkHealthDashboard
          targets={health.data}
          events={health.events}
          samples={samples.data ?? []}
          loadError={health.error || discovery.error}
          isAdmin={canOperate}
          manualPingIsAdmin={profile.role === "admin"}
          discoveryRunners={discoveryRunners.data}
          discoverySessions={discovery.data}
          trafficIps={observedTrafficIps(traffic.data.snapshots)}
          {...(params.target ? { initialTargetId: params.target } : {})}
        />
        <DiagnosticsSummary data={diagnostics.data} loadError={!diagnostics.ok} />
        </DeviceProfileProvider>
      </NetworkNodesProvider>
    </main>
  );
}
