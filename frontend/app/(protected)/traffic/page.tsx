import { TrafficLivePage } from "@/components/traffic/traffic-live-page";
import { requireApprovedProfile } from "@/lib/auth";
import { getDiagnosticsAction } from "@/app/actions/diagnostics";
import { loadAuthoritativeTrafficState } from "@/lib/traffic-source";
import { loadAuthoritativeNetworkNodes } from "@/lib/network-nodes-source";
import { NetworkNodesProvider } from "@/components/diagnostics/network-nodes-provider";
import { DeviceProfileProvider } from "@/components/device-profile/device-profile-provider";
import { getServerTranslation } from "@/i18n/server";

export const dynamic = "force-dynamic";

export default async function TrafficPage({searchParams}:{searchParams:Promise<{ip?:string}>}) {
  const { t } = await getServerTranslation("traffic");
  const {ip}=await searchParams;
  const {profile}=await requireApprovedProfile();
  const [state,diagnostics,nodes]=await Promise.all([loadAuthoritativeTrafficState(profile.role),getDiagnosticsAction(),loadAuthoritativeNetworkNodes()]);
  return <main className="min-w-0 max-w-full p-4 md:p-6"><p className="text-meta font-medium uppercase tracking-wide text-accent">{t("page.eyebrow")}</p><h1 className="mt-2 text-heading font-semibold">{t("page.title")}</h1><p className="mt-2 text-text-secondary">{t("page.description")}</p><div className="mt-6 min-w-0"><NetworkNodesProvider initialNodes={nodes.data} loadError={nodes.error} role={profile.role}><DeviceProfileProvider role={profile.role} runners={state.data.runners}><TrafficLivePage initialState={state.data} initialAuthority={state.authority} diagnostics={diagnostics.data} loadError={state.error || nodes.error || !diagnostics.ok} initialSearch={ip}/></DeviceProfileProvider></NetworkNodesProvider></div></main>;
}
