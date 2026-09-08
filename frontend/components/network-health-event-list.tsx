"use client";

import { useTranslation } from "react-i18next";
import type { NetworkHealthEvent } from "@/lib/network-health";
import { localeForLanguage } from "@/i18n/config";

export function NetworkHealthEventList({ events, empty }: { events: NetworkHealthEvent[]; empty?: string }) {
  const { t, i18n } = useTranslation("common");
  const format = (value: string) => new Intl.DateTimeFormat(localeForLanguage(i18n.language), { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value));
  if (!events.length) return <p className="mt-4 text-text-muted">{empty ?? t("healthEvents.empty")}</p>;
  return <div className="mt-4 grid gap-3">{events.map((event) => <article className="rounded-control border border-border bg-bg-base p-4" key={event.id}><div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between"><div><p className="font-medium"><span className={tone(event.severity)}>●</span> {event.title}</p><p className="mt-2 text-text-secondary">{event.description}</p><p className="mt-2 text-meta text-text-muted">{event.resolved_at ? t("healthEvents.resolvedAt", { date: format(event.resolved_at) }) : t("healthEvents.stillActive")}</p></div><time className="shrink-0 font-data text-meta text-text-muted">{format(event.created_at)}</time></div></article>)}</div>;
}
function tone(value: NetworkHealthEvent["severity"]) { return value === "low" ? "text-severity-low" : value === "medium" ? "text-severity-medium" : value === "high" ? "text-severity-high" : "text-severity-critical"; }
