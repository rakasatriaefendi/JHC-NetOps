import { NetworkHealthEventList } from "@/components/network-health-event-list";
import { requireApprovedProfile } from "@/lib/auth";
import type { NetworkHealthEvent } from "@/lib/network-health";

export const dynamic = "force-dynamic";

export default async function AlertsPage() {
  const { supabase } = await requireApprovedProfile();
  const { data, error } = await supabase.from("events").select("id,created_at,severity,title,description,source_ref,resolved_at,raw_context").eq("source", "network_health").is("resolved_at", null).order("created_at", { ascending: false }).returns<NetworkHealthEvent[]>();
  return <main className="p-4 md:p-6"><p className="text-meta font-medium uppercase tracking-wide text-accent">Alerts</p><h1 className="mt-2 text-heading font-semibold">Active network health alerts</h1><p className="mt-2 max-w-3xl text-text-secondary">Hanya transisi status known-target yang masih aktif. Status offline berarti tidak ada respons ICMP setelah threshold dan bukan bukti tunggal bahwa perangkat mati.</p><section className="mt-6 rounded-panel border border-border bg-bg-surface p-4 md:p-6">{error ? <p className="text-severity-critical">Alert gagal dimuat.</p> : <NetworkHealthEventList events={data ?? []} empty="Tidak ada alert network health aktif." />}</section></main>;
}
