import Link from "next/link";

import { ObservedLanHostsWorkspace } from "@/components/snmp/observed-lan-hosts";
import { requireApprovedProfile } from "@/lib/auth";
import {
  formatDateTime,
  latestObservedAt,
  loadManagedObservedHostsPage,
  MANAGED_TELEMETRY_STATUS_LABELS,
} from "@/lib/managed-telemetry";

export const dynamic = "force-dynamic";

type ObservedHostsPageProps = {
  params: Promise<{ targetId: string }>;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function ObservedHostsPage({ params }: ObservedHostsPageProps) {
  const { targetId } = await params;
  const { supabase } = await requireApprovedProfile();
  const result = UUID_PATTERN.test(targetId)
    ? await loadManagedObservedHostsPage(supabase, targetId)
    : { target: null, observedHosts: [], error: false };
  const target = result.target;
  const latestObservation = target
    ? latestObservedAt(result.observedHosts, target.latest?.last_polled_at ?? null)
    : null;

  return <main className="p-4 md:p-6">
    <Link
      className="inline-flex items-center justify-center rounded-control border border-accent px-4 py-2 text-body font-medium text-accent transition-colors hover:bg-accent hover:text-bg-base focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent"
      href="/snmp"
    >← Back to SNMP workspace</Link>
    <div className="mt-5">
      <p className="text-meta font-medium uppercase tracking-wide text-accent">Managed SNMP observation</p>
      <h1 className="mt-2 text-heading font-semibold">Observed LAN Hosts</h1>
      <p className="mt-2 max-w-3xl text-text-secondary">Read-only Layer-3 neighbor evidence reported by one managed device. This workspace does not start a scan or prove physical switch-port attachment.</p>
    </div>

    {result.error ? <StateCard title="Observed hosts unavailable">The latest managed observation could not be loaded. Return to the SNMP workspace and try again later.</StateCard>
      : !target ? <StateCard title="Managed SNMP target unavailable">This target does not exist or is not available to your approved account.</StateCard>
      : <>
        <section className="mt-6 rounded-panel border border-border bg-bg-surface p-4 md:p-6" aria-label="Managed device context">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div><h2 className="text-section font-semibold">{target.node.name}</h2><p className="mt-1 font-data text-meta text-text-secondary">{target.node.ip_address}</p></div>
            <span className="text-meta text-text-secondary">Latest poll: <span className="font-data" suppressHydrationWarning>{formatDateTime(target.latest?.last_polled_at ?? null)}</span></span>
          </div>
          <dl className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <ContextMetric label="Managed status" value={target.latest ? MANAGED_TELEMETRY_STATUS_LABELS[target.latest.status] : "Unavailable"} />
            <ContextMetric label="Observation state" value={observationStateLabel(target.latest?.observed_hosts_status)} />
            <ContextMetric label="Observed hosts" value={String(result.observedHosts.length)} data />
            <ContextMetric label="Latest observation / poll" value={formatDateTime(latestObservation)} data />
          </dl>
        </section>
        <ObservedLanHostsWorkspace hosts={result.observedHosts} status={target.latest?.observed_hosts_status} />
      </>}
  </main>;
}

function ContextMetric({ label, value, data = false }: { label: string; value: string; data?: boolean }) {
  return <div className="rounded-control border border-border bg-bg-base p-3"><dt className="text-meta text-text-muted">{label}</dt><dd className={`mt-1 text-text-primary ${data ? "font-data" : ""}`} suppressHydrationWarning={data}>{value}</dd></div>;
}

function StateCard({ title, children }: { title: string; children: string }) {
  return <section className="mt-6 rounded-panel border border-border bg-bg-surface p-6"><h2 className="text-section font-semibold">{title}</h2><p className="mt-2 text-text-secondary">{children}</p></section>;
}

function observationStateLabel(status: "available" | "empty" | "partial" | "unsupported" | undefined): string {
  switch (status) {
    case "available": return "Available";
    case "partial": return "Partial enrichment";
    case "empty": return "No current observations";
    case "unsupported": return "Unsupported";
    default: return "Not reported";
  }
}
