"use client";

import { useTranslation } from "react-i18next";

import type { PortableDevScenario } from "@/lib/portable-dev-mode";
import type { ManagedTelemetryEvent } from "@/lib/managed-telemetry-client";

export function PortableFixtureBanner({
  scenario,
  events = [],
}: {
  scenario: PortableDevScenario;
  events?: ManagedTelemetryEvent[];
}) {
  const { t } = useTranslation("common");
  return <aside className="mt-4 rounded-control border border-severity-medium bg-severity-medium/5 p-4" role="status">
    <p className="font-medium text-severity-medium">{t("portable.title")}</p>
    <p className="mt-1 text-meta text-text-secondary">{t("portable.description", { scenario })}</p>
    {events.length > 0 ? <details className="mt-3 text-meta text-text-secondary">
      <summary className="cursor-pointer">{t("portable.events", { count: events.length })}</summary>
      <ul className="mt-2 grid gap-1">{events.map((event) => <li key={event.id}>
        <span className={event.resolved_at ? "text-text-muted" : "text-severity-medium"}>{event.title}</span>
        {event.resolved_at ? <span className="text-text-muted"> · {t("portable.resolved")}</span> : null}
      </li>)}</ul>
    </details> : null}
  </aside>;
}
