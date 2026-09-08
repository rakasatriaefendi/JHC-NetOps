import { NetworkNodesProvider } from "@/components/diagnostics/network-nodes-provider";
import { DeviceProfileProvider } from "@/components/device-profile/device-profile-provider";
import { HistoryTabs } from "@/components/history/history-tabs";
import { requireApprovedProfile } from "@/lib/auth";
import { loadNetworkNodes } from "@/lib/network-nodes";
import type { NetworkHealthEvent } from "@/lib/network-health";
import { getServerTranslation } from "@/i18n/server";

export default async function HistoryPage() {
  const { t } = await getServerTranslation("history");
  const { supabase, profile } = await requireApprovedProfile();
  const networkNodes = await loadNetworkNodes(supabase);
  const { data: events } = await supabase.from("events").select("id,created_at,severity,title,description,source_ref,resolved_at,raw_context").eq("source", "network_health").order("created_at", { ascending: false }).limit(100).returns<NetworkHealthEvent[]>();
  return (
    <main className="p-4 md:p-6">
      <p className="text-meta font-medium uppercase tracking-wide text-accent">{t("page.eyebrow")}</p>
      <h1 className="mt-2 text-heading font-semibold">{t("page.title")}</h1>
      <p className="mt-2 text-text-secondary">
        {t("page.description")}
      </p>
      <NetworkNodesProvider initialNodes={networkNodes.data} loadError={networkNodes.error} role={profile.role}>
        <DeviceProfileProvider role={profile.role}><HistoryTabs events={events ?? []} /></DeviceProfileProvider>
      </NetworkNodesProvider>
    </main>
  );
}
