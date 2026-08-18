import { NetworkHealthDashboard } from "@/components/dashboard/network-health-dashboard";
import { DiagnosticsSummary } from "@/components/dashboard/diagnostics-summary";
import { LocalTrafficSummary } from "@/components/dashboard/local-traffic-summary";
import { NetworkNodesProvider } from "@/components/diagnostics/network-nodes-provider";
import { DeviceProfileProvider } from "@/components/device-profile/device-profile-provider";
import { requireApprovedProfile } from "@/lib/auth";
import { loadDiagnostics } from "@/lib/diagnostics";
import { loadDiscoverySessions, observedTrafficIps } from "@/lib/network-discovery";
import { loadNetworkHealth } from "@/lib/network-health";
import { loadNetworkNodes } from "@/lib/network-nodes";
import { loadTrafficState } from "@/lib/traffic";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const { supabase, profile } = await requireApprovedProfile();
  const isAdmin = profile.role === "admin";
  const [health, diagnostics, traffic, nodes, discovery] = await Promise.all([
    loadNetworkHealth(supabase),
    loadDiagnostics(supabase),
    loadTrafficState(supabase, profile.role),
    loadNetworkNodes(supabase),
    loadDiscoverySessions(supabase, isAdmin),
  ]);

  return (
    <main className="p-4 md:p-6">
      <p className="text-meta font-medium uppercase tracking-wide text-accent">
        Network operations
      </p>
      <h1 className="mt-2 text-heading font-semibold">Dashboard</h1>
      <p className="mt-2 text-text-secondary">
        Reachability target yang dikenal, perubahan status, dan konteks diagnostik.
      </p>

      <NetworkNodesProvider initialNodes={nodes.data} loadError={nodes.error} role={profile.role}>
        <DeviceProfileProvider role={profile.role} runners={traffic.data.runners}>
        <LocalTrafficSummary initialState={traffic.data} loadError={traffic.error} />
        <NetworkHealthDashboard
          targets={health.data}
          events={health.events}
          loadError={health.error || discovery.error}
          isAdmin={isAdmin}
          discoveryRunners={traffic.data.runners}
          discoverySessions={discovery.data}
          trafficIps={observedTrafficIps(traffic.data.snapshots)}
        />
        <DiagnosticsSummary data={diagnostics.data} loadError={diagnostics.error} />
        </DeviceProfileProvider>
      </NetworkNodesProvider>
    </main>
  );
}
