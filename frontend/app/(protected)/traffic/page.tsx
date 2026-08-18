import { TrafficLivePage } from "@/components/traffic/traffic-live-page";
import { requireApprovedProfile } from "@/lib/auth";
import { loadDiagnostics } from "@/lib/diagnostics";
import { loadTrafficState } from "@/lib/traffic";
import { loadNetworkNodes } from "@/lib/network-nodes";
import { NetworkNodesProvider } from "@/components/diagnostics/network-nodes-provider";
import { DeviceProfileProvider } from "@/components/device-profile/device-profile-provider";

export const dynamic = "force-dynamic";

export default async function TrafficPage({searchParams}:{searchParams:Promise<{ip?:string}>}) {
  const {ip}=await searchParams;
  const {supabase,profile}=await requireApprovedProfile();
  const [state,diagnostics,nodes]=await Promise.all([loadTrafficState(supabase,profile.role),loadDiagnostics(supabase),loadNetworkNodes(supabase)]);
  return <main className="min-w-0 max-w-full p-4 md:p-6"><p className="text-meta font-medium uppercase tracking-wide text-accent">Traffic</p><h1 className="mt-2 text-heading font-semibold">Live &amp; recent flow visibility</h1><p className="mt-2 text-text-secondary">Header metadata dari perangkat runner ini; terpisah dari traffic_metrics, diagnostics, baseline, events, dan severity.</p><div className="mt-6 min-w-0"><NetworkNodesProvider initialNodes={nodes.data} loadError={nodes.error} role={profile.role}><DeviceProfileProvider role={profile.role} runners={state.data.runners}><TrafficLivePage initialState={state.data} diagnostics={diagnostics.data} loadError={state.error || nodes.error} initialSearch={ip}/></DeviceProfileProvider></NetworkNodesProvider></div></main>;
}
