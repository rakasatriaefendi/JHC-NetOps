"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import Link from "next/link";

import { profileDisplayLabel } from "@/lib/profile-display";

type AuditEntry = {
  id: string;
  source: "account" | "administrative";
  action: string;
  actor_id: string | null;
  actor_name: string | null;
  target_name: string | null;
  actor_email: string | null;
  target_email: string | null;
  resource_type: "profile" | "report_branding";
  resource_key: string;
  before_state: Record<string, unknown>;
  after_state: Record<string, unknown>;
  occurred_at: string;
};

type Props = {
  entries: AuditEntry[];
  page: number;
  more: boolean;
  error: boolean;
};

function formatDateTime(dateString: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(dateString));
}

function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function summary(entry: AuditEntry, state: Record<string, unknown>, t: ReturnType<typeof useTranslation>["t"]): string {
  if (entry.source === "account") {
    return [state.role && t(`common:roles.${state.role}`), state.status && t(`common:status.${state.status}`)].filter(Boolean).join(" / ") || "-";
  }
  return [safeIdentity(state.institution_name), safeIdentity(state.division_name),
    t(state.logo_available === true ? "audit.logoPresent" : "audit.logoAbsent")].filter(Boolean).join(" / ");
}

function safeIdentity(value: unknown): string {
  return typeof value === "string" && value.length <= 160 &&
    !/[\x00-\x1f\x7f]|bearer\s+\S+|(?:password|auth_password|priv_password|community|authorization|session_token)\s*[:=]/i.test(value) ? value : "-";
}

export function AdministrativeAuditCompact({ entries, page, more, error }: Props) {
  const { t, i18n } = useTranslation("admin");
  const locale = i18n.language;
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <section className="mt-6 rounded-panel border border-border bg-bg-surface p-4 md:p-6" aria-labelledby="audit-title">
      <h2 id="audit-title" className="text-section font-semibold">{t("audit.title")}</h2>
      <p className="mt-1 text-meta text-text-secondary">{t("audit.description")}</p>

      {error ? <p role="alert" className="mt-4 text-severity-critical">{t("audit.error")}</p> :
        entries.length === 0 ? <p className="mt-4 text-text-muted">{t("audit.empty")}</p> :
        <ol className="mt-4 grid gap-2" role="list">
          {entries.map((entry) => {
            const isExpanded = expandedId === `${entry.source}:${entry.id}`;
            const actorLabel = profileDisplayLabel(entry.actor_name, entry.actor_email, entry.actor_id, t("audit.unavailable"));
            const showActorUid = entry.actor_id && actorLabel !== entry.actor_id;
            const resourceLabel = entry.resource_type === "profile"
              ? profileDisplayLabel(entry.target_name, entry.target_email, entry.resource_key)
              : t("branding.title");
            const showResourceUid = entry.resource_type === "profile" && resourceLabel !== entry.resource_key;

            return (
              <li key={`${entry.source}:${entry.id}`} className="min-w-0 rounded-control border border-border bg-bg-base">
                <button
                  type="button"
                  className="w-full p-3 flex items-center justify-between gap-4 text-left focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
                  onClick={() => setExpandedId(isExpanded ? null : `${entry.source}:${entry.id}`)}
                  aria-expanded={isExpanded}
                  aria-controls={`audit-detail-${entry.source}-${entry.id}`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate">{t(`audit.actions.${entry.action}`)}</p>
                    <p className="mt-1 truncate text-meta text-text-secondary">{t("audit.actor")}: {actorLabel}</p>
                  </div>
                  <div className="flex items-center gap-3 text-meta text-text-muted whitespace-nowrap shrink-0">
                    <time dateTime={entry.occurred_at}>{formatDateTime(entry.occurred_at, i18n.language)}</time>
                    <ChevronDownIcon className={`w-4 h-4 transition-transform ${isExpanded ? "rotate-180" : ""}`} aria-hidden="true" />
                  </div>
                </button>

                <div id={`audit-detail-${entry.source}-${entry.id}`} role="region" aria-labelledby={`audit-title-${entry.source}-${entry.id}`} className={isExpanded ? "px-3 pb-3 border-t border-border animate-slide-down" : "hidden"}>
                  <div className="mt-3 grid gap-3 text-meta">
                    <div className="grid gap-1">
                      <span className="font-medium text-text-secondary">{t("audit.actor")}</span>
                      <p className="break-words text-text-secondary">{actorLabel}</p>
                      {showActorUid && <p className="break-all text-text-muted" title={entry.actor_id!}>{t("common:profile.uid")}: {entry.actor_id}</p>}
                    </div>
                    <div className="grid gap-1">
                      <span className="font-medium text-text-secondary">{t("audit.resource")}</span>
                      <p className="break-words text-text-secondary">{resourceLabel}</p>
                      {showResourceUid && <p className="break-all text-text-muted" title={entry.resource_key}>{t("common:profile.uid")}: {entry.resource_key}</p>}
                    </div>
                    <div className="grid gap-1">
                      <span className="font-medium text-text-secondary">{t("audit.before")}</span>
                      <p className="break-words text-text-secondary">{summary(entry, entry.before_state, t)}</p>
                    </div>
                    <div className="grid gap-1">
                      <span className="font-medium text-text-secondary">{t("audit.after")}</span>
                      <p className="break-words text-text-secondary">{summary(entry, entry.after_state, t)}</p>
                    </div>
                    <div className="grid gap-1">
                      <span className="font-medium text-text-secondary">{t("audit.timestamp")}</span>
                      <time className="text-text-secondary" dateTime={entry.occurred_at}>{formatDateTime(entry.occurred_at, locale)}</time>
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      }

      <nav className="mt-4 flex flex-wrap gap-4 text-meta" aria-label={t("audit.pagination")}>
        {page > 0 ? <Link className="text-accent" href={`/admin?audit_page=${page - 1}#audit-title`}>{t("common:actions.previous")}</Link> : null}
        <span>{t("audit.page", { page: page + 1 })}</span>
        {more && page < 200 ? <Link className="text-accent" href={`/admin?audit_page=${page + 1}#audit-title`}>{t("common:actions.next")}</Link> : null}
      </nav>
    </section>
  );
}