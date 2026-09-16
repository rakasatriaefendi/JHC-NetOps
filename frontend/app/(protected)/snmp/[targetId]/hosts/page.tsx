import Link from "next/link";

import { PortableFixtureBanner } from "@/components/portable-fixture-banner";
import { ObservedLanHostsWorkspace } from "@/components/snmp/observed-lan-hosts";
import { requireApprovedProfile } from "@/lib/auth";
import {
  formatDateTime,
  latestObservedAt,
} from "@/lib/managed-telemetry-client";
import { loadObservedHostsData } from "@/lib/managed-telemetry-source";
import { getServerTranslation } from "@/i18n/server";

export const dynamic = "force-dynamic";

type ObservedHostsPageProps = {
  params: Promise<{ targetId: string }>;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function ObservedHostsPage({ params }: ObservedHostsPageProps) {
  const { t, language } = await getServerTranslation(["snmp", "common"]);
  const { targetId } = await params;
  const { supabase } = await requireApprovedProfile();
  const result = UUID_PATTERN.test(targetId)
    ? await loadObservedHostsData(supabase, targetId)
    : { target: null, observedHosts: [], error: false, portable: { enabled: false as const, scenario: null } };
  const target = result.target;
  const latestObservation = target
    ? latestObservedAt(result.observedHosts, target.latest?.last_polled_at ?? null)
    : null;

  return <main className="p-4 md:p-6">
    <Link
      className="inline-flex items-center justify-center rounded-control border border-accent px-4 py-2 text-body font-medium text-accent transition-colors hover:bg-accent hover:text-bg-base focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent"
      href="/snmp"
    >{t("observed.back")}</Link>
    <div className="mt-5">
      <p className="text-meta font-medium uppercase tracking-wide text-accent">{t("observed.eyebrow")}</p>
      <h1 className="mt-2 text-heading font-semibold">{t("observed.title")}</h1>
      <p className="mt-2 max-w-3xl text-text-secondary">{t("observed.description")}</p>
    </div>
    {result.portable.enabled ? <PortableFixtureBanner scenario={result.portable.scenario} /> : null}

    {result.error ? <StateCard title={t("observed.loadErrorTitle")}>{t("observed.loadError")}</StateCard>
      : !target ? <StateCard title={t("observed.targetErrorTitle")}>{t("observed.targetError")}</StateCard>
      : <>
        <section className="mt-6 rounded-panel border border-border bg-bg-surface p-4 md:p-6" aria-label={t("observed.context")}>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div><h2 className="text-section font-semibold">{target.node.name}</h2><p className="mt-1 font-data text-meta text-text-secondary">{target.node.ip_address}</p></div>
            <span className="text-meta text-text-secondary">{t("observed.latestPoll", { date: formatDateTime(target.latest?.last_polled_at ?? null, language) })}</span>
          </div>
          <dl className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <ContextMetric label={t("observed.managedStatus")} value={target.latest ? t(`common:telemetryStatus.${target.latest.status}`) : t("common:status.unavailable")} />
            <ContextMetric label={t("observed.observationState")} value={observationStateLabel(target.latest?.observed_hosts_status, t)} />
            <ContextMetric label={t("observed.observedHosts")} value={String(result.observedHosts.length)} data />
            <ContextMetric label={t("observed.latestObservation")} value={formatDateTime(latestObservation, language)} data />
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

function observationStateLabel(status: "available" | "empty" | "partial" | "unsupported" | undefined, t: Awaited<ReturnType<typeof getServerTranslation>>["t"]): string {
  switch (status) {
    case "available": return t("observed.available");
    case "partial": return t("observed.partial");
    case "empty": return t("observed.empty");
    case "unsupported": return t("observed.unsupported");
    default: return t("observed.notReported");
  }
}
