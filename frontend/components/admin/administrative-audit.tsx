import Link from "next/link";
import { getServerTranslation } from "@/i18n/server";
import type { loadAdministrativeAudit, AuditEntry } from "@/lib/administrative-audit";
import { profileDisplayLabel } from "@/lib/profile-display";

export async function AdministrativeAudit({ result, page }: {
  result: Awaited<ReturnType<typeof loadAdministrativeAudit>>; page: number;
}) {
  const { t, locale } = await getServerTranslation("admin");
  const summary = (entry: AuditEntry, state: Record<string, unknown>) => entry.source === "account"
    ? [state.role && t(`common:roles.${state.role}`), state.status && t(`common:status.${state.status}`)].filter(Boolean).join(" / ") || "-"
    : [safeIdentity(state.institution_name), safeIdentity(state.division_name),
      t(state.logo_available === true ? "audit.logoPresent" : "audit.logoAbsent")].filter(Boolean).join(" / ");
  return <section className="mt-6 rounded-panel border border-border bg-bg-surface p-4 md:p-6" aria-labelledby="audit-title">
    <h2 id="audit-title" className="text-section font-semibold">{t("audit.title")}</h2>
    <p className="mt-1 text-meta text-text-secondary">{t("audit.description")}</p>
    {result.error ? <p role="alert" className="mt-4 text-severity-critical">{t("audit.error")}</p> : result.entries.length === 0 ? <p className="mt-4 text-text-muted">{t("audit.empty")}</p> :
      <ol className="mt-4 grid gap-3">{result.entries.map((entry) => <li key={`${entry.source}:${entry.id}`} className="min-w-0 rounded-control border border-border p-3">
        <p className="font-medium">{t(`audit.actions.${entry.action}`)}</p>
        <p className="mt-1 break-words text-meta text-text-secondary">{t("audit.actor")}: {profileDisplayLabel(entry.actor_name, entry.actor_email, entry.actor_id, t("audit.unavailable"))}</p>
        {entry.actor_id && profileDisplayLabel(entry.actor_name, entry.actor_email, entry.actor_id) !== entry.actor_id ? <p className="break-all text-meta text-text-muted" title={entry.actor_id}>{t("common:profile.uid")}: {entry.actor_id}</p> : null}
        <p className="break-words text-meta text-text-secondary">{t("audit.resource")}: {entry.resource_type === "profile" ? profileDisplayLabel(entry.target_name, entry.target_email, entry.resource_key) : t("branding.title")}</p>
        {entry.resource_type === "profile" && profileDisplayLabel(entry.target_name, entry.target_email, entry.resource_key) !== entry.resource_key ? <p className="break-all text-meta text-text-muted" title={entry.resource_key}>{t("common:profile.uid")}: {entry.resource_key}</p> : null}
        <p className="mt-2 break-words text-meta">{t("audit.before")}: {summary(entry, entry.before_state)}<br />{t("audit.after")}: {summary(entry, entry.after_state)}</p>
        <time className="mt-2 block text-meta text-text-muted" dateTime={entry.occurred_at}>{new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(entry.occurred_at))}</time>
      </li>)}</ol>}
    <nav className="mt-4 flex flex-wrap gap-4 text-meta" aria-label={t("audit.pagination")}>
      {page > 0 ? <Link className="text-accent" href={`/admin?audit_page=${page - 1}#audit-title`}>{t("common:actions.previous")}</Link> : null}
      <span>{t("audit.page", { page: page + 1 })}</span>
      {result.more && page < 200 ? <Link className="text-accent" href={`/admin?audit_page=${page + 1}#audit-title`}>{t("common:actions.next")}</Link> : null}
    </nav>
  </section>;
}

function safeIdentity(value: unknown): string {
  return typeof value === "string" && value.length <= 160 &&
    !/[\x00-\x1f\x7f]|bearer\s+\S+|(?:password|auth_password|priv_password|community|authorization|session_token)\s*[:=]/i.test(value) ? value : "-";
}
