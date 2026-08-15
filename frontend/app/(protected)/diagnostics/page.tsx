import { NetworkNodesProvider } from "@/components/diagnostics/network-nodes-provider";
import { DiagnosticsWorkspace } from "@/components/diagnostics/diagnostics-workspace";
import { loadDiagnosticJobState } from "@/lib/diagnostic-jobs";
import { loadDiagnostics } from "@/lib/diagnostics";
import { loadNetworkNodes } from "@/lib/network-nodes";
import { requireApprovedProfile } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function DiagnosticsPage({searchParams}:{searchParams:Promise<{target?:string}>}) {
  const {target}=await searchParams;
  const {supabase,profile} = await requireApprovedProfile();
  const [jobState, diagnostics, networkNodes] = await Promise.all([
    loadDiagnosticJobState(supabase),
    loadDiagnostics(supabase),
    loadNetworkNodes(supabase),
  ]);
  return (
    <main className="min-w-0 max-w-full p-4 md:p-6">
      <p className="text-meta font-medium uppercase tracking-wide text-accent">LAN diagnostics</p>
      <h1 className="mt-2 text-heading font-semibold">Bandwidth &amp; path diagnostics</h1>
      <p className="mt-2 text-text-secondary">On-demand, terpisah dari traffic metrics, baseline, dan severity.</p>
      <div className="mt-6 min-w-0">
        <NetworkNodesProvider initialNodes={networkNodes.data} loadError={networkNodes.error} role={profile.role}>
          <DiagnosticsWorkspace initialState={jobState.data} initialDiagnostics={diagnostics.data} loadError={jobState.error || diagnostics.error} diagnosticsLoadError={diagnostics.error} prefillTarget={target} role={profile.role} />
        </NetworkNodesProvider>
      </div>
    </main>
  );
}
