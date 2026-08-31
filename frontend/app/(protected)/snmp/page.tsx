import { ManagedTelemetryTargets } from "@/components/admin/managed-telemetry-targets";
import { ManagedTelemetryDetail } from "@/components/snmp/managed-telemetry-detail";
import { requireApprovedProfile } from "@/lib/auth";
import type { RunnerCapabilities } from "@/lib/diagnostic-jobs";
import { loadManagedTelemetryWorkspace } from "@/lib/managed-telemetry";
import { loadNetworkNodes } from "@/lib/network-nodes";

export const dynamic = "force-dynamic";

type SnmpPageProps = { searchParams: Promise<{ telemetry_notice?: string; telemetry_error?: string }> };

export default async function SnmpPage({ searchParams }: SnmpPageProps) {
  const { supabase, profile } = await requireApprovedProfile();
  const params = await searchParams;
  const [inventory, runnersResult, telemetry] = await Promise.all([
    loadNetworkNodes(supabase),
    supabase.from("diagnostic_runners").select("id,display_name,capabilities").order("display_name"),
    loadManagedTelemetryWorkspace(supabase),
  ]);
  const runners = (runnersResult.data ?? []) as { id: string; display_name: string; capabilities: RunnerCapabilities }[];
  const connected = telemetry.data.filter((target) => target.latest?.status === "connected").length;
  const pollErrors = telemetry.data.filter((target) => target.latest && !["connected", "partial"].includes(target.latest.status)).length;
  const targetIds = new Set(telemetry.data.map((target) => target.id));
  const interfaceCount = telemetry.interfaces.filter((row) => targetIds.has(row.target_id)).length;
  const loadFailed = inventory.error || runnersResult.error || telemetry.error;

  return <main className="p-4 md:p-6">
    <div>
      <p className="text-meta font-medium uppercase tracking-wide text-accent">Read-only management</p>
      <h1 className="mt-2 text-heading font-semibold">SNMP</h1>
      <p className="mt-2 max-w-3xl text-text-secondary">Managed infrastructure telemetry menggunakan target inventory dan profile reference lokal runner. Tidak tersedia arbitrary OID, walk, SET, atau credential input.</p>
    </div>
    {loadFailed ? <p className="mt-4 text-severity-critical" role="alert">Sebagian data SNMP tidak dapat dimuat.</p> : null}
    <section className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Managed telemetry summary">
      <Summary label="Managed devices" value={telemetry.data.length} />
      <Summary label="Connected latest" value={connected} />
      <Summary label="Poll errors" value={pollErrors} />
      <Summary label="Interfaces" value={interfaceCount} />
    </section>
    <ManagedTelemetryTargets
      nodes={inventory.data}
      runners={runners}
      targets={telemetry.data}
      canManage={profile.role === "admin"}
      notice={params.telemetry_notice}
      error={params.telemetry_error}
    />
    <ManagedTelemetryDetail targets={telemetry.data} interfaces={telemetry.interfaces} />
  </main>;
}

function Summary({ label, value }: { label: string; value: number }) { return <div className="rounded-control border border-border bg-bg-surface p-4"><p className="text-meta text-text-muted">{label}</p><p className="mt-2 font-data text-heading text-accent">{value}</p></div>; }
