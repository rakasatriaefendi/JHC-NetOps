"use client";

import { useRef, useState, FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { LoadingSpinner, useActionFeedback } from "@/components/ui/action-feedback";
import type { MutationKind } from "@/lib/mutation-feedback";
import {
  REPORT_BRANDING_LOGO_MAX_BYTES,
  type ReportBranding,
  validReportBranding,
} from "@/lib/report-branding-contract";

export function ReportBrandingSettings({ initial }: { initial: ReportBranding }) {
  const { t } = useTranslation("admin");
  const notify = useActionFeedback();
  const inFlight = useRef(false);
  const [branding, setBranding] = useState(initial);
  const [busy, setBusy] = useState<"text" | "logo" | "remove" | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  async function saveText(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    const form = new FormData(event.currentTarget);
    await update("/admin/report-branding", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ institution_name: form.get("institution_name"), division_name: form.get("division_name") }),
    }, "text", "save");
  }

  async function uploadLogo() {
    if (inFlight.current) return;
    const file = fileRef.current?.files?.[0];
    if (!file || file.size > REPORT_BRANDING_LOGO_MAX_BYTES) { notify("upload", false); return; }
    if (!["image/png", "image/jpeg"].includes(file.type)) { notify("upload", false); return; }
    const form = new FormData(); form.set("logo", file);
    const saved = await update("/admin/report-branding/logo", { method: "POST", body: form }, "logo", "upload");
    if (saved) {
      if (fileRef.current) fileRef.current.value = "";
      setPreviewUrl(null);
    }
  }

  async function removeLogo() {
    await update("/admin/report-branding/logo", { method: "DELETE" }, "remove", "remove");
    setPreviewUrl(null);
  }

  async function update(path: string, init: RequestInit, operation: NonNullable<typeof busy>, kind: MutationKind) {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(operation);
    try {
      const response = await fetch(path, init);
      const payload: unknown = await response.json();
      if (!response.ok || !record(payload) || !validReportBranding(payload.data)) throw new Error("invalid response");
      setBranding(payload.data);
      if (payload.changed === true) notify(kind, true);
      return true;
    } catch { notify(kind, false); return false; }
    finally { inFlight.current = false; setBusy(null); }
  }

  function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function buildLogoSrc(): string {
    if (previewUrl) return previewUrl;
    if (!branding.logo_available) return "";
    const version = encodeURIComponent(branding.updated_at ?? "default");
    return `/admin/report-branding/logo?v=${version}`;
  }

  return (
    <section className="mt-6 rounded-panel border border-border bg-bg-surface p-4 md:p-6" aria-labelledby="report-branding-title">
      <p className="text-meta font-medium uppercase tracking-wide text-accent">{t("branding.eyebrow")}</p>
      <h2 className="mt-2 text-section font-semibold" id="report-branding-title">{t("branding.title")}</h2>
      <p className="mt-1 text-meta text-text-secondary">{t("branding.description")}</p>

      <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,320px)]">
        <form className="grid gap-4" onSubmit={saveText} aria-busy={busy === "text"}>
          <label className="grid gap-2 text-meta text-text-secondary">
            {t("branding.institution")}
            <input
              className="rounded-control border border-border bg-bg-base px-3 py-2 text-text-primary outline-none focus:border-accent"
              defaultValue={branding.institution_name}
              maxLength={160}
              name="institution_name"
              required
            />
          </label>
          <label className="grid gap-2 text-meta text-text-secondary">
            {t("branding.division")}
            <input
              className="rounded-control border border-border bg-bg-base px-3 py-2 text-text-primary outline-none focus:border-accent"
              defaultValue={branding.division_name}
              maxLength={160}
              name="division_name"
            />
          </label>
          <div className="flex items-center gap-2">
            <Button
              disabled={busy !== null}
              aria-busy={busy === "text"}
              type="submit"
            >
              {busy === "text" ? (
                <>
                  <LoadingSpinner />
                  {t("branding.saving")}
                </>
              ) : (
                t("branding.save")
              )}
            </Button>
          </div>
        </form>

        <div className="rounded-control border border-border bg-bg-base p-4 flex flex-col">
          <div className="flex items-center justify-between">
            <p className="text-meta font-medium text-text-secondary">{t("branding.logo")}</p>
          </div>

          <div className="mt-3 flex min-h-[140px] items-center justify-center rounded-control border border-dashed border-border bg-white/5 p-3 relative">
            {branding.logo_available ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                alt={t("branding.logoPreview")}
                className="max-h-28 w-auto object-contain transition-opacity duration-200"
                src={buildLogoSrc()}
                style={{ maxWidth: "100%" }}
              />
            ) : (
              <div className="flex flex-col items-center gap-2 text-center text-meta text-text-muted">
                <svg className="w-10 h-10 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <span>{t("branding.noLogo")}</span>
              </div>
            )}
          </div>

          <input
            disabled={busy !== null}
            accept=".png,.jpg,.jpeg,image/png,image/jpeg"
            className="mt-3 block w-full text-meta text-text-secondary file:mr-3 file:rounded-control file:border file:border-border file:bg-bg-surface file:px-3 file:py-2 file:text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-accent"
            ref={fileRef}
            type="file"
            aria-label={t("branding.logo")}
          />
          <p className="mt-2 text-meta text-text-muted">{t("branding.logoHelp")}</p>

          <div className="mt-4 flex flex-wrap items-center gap-2 pt-3 border-t border-border">
            <Button
              disabled={busy !== null}
              aria-busy={busy === "logo"}
              onClick={uploadLogo}
            >
              {busy === "logo" ? (
                <>
                  <LoadingSpinner />
                  {t("branding.uploading")}
                </>
              ) : (
                t(branding.logo_available ? "branding.replaceLogo" : "branding.uploadLogo")
              )}
            </Button>
            {branding.logo_available && (
              <Button
                disabled={busy !== null}
                aria-busy={busy === "remove"}
                onClick={removeLogo}
                variant="destructive"
              >
                {busy === "remove" ? (
                  <>
                    <LoadingSpinner />
                    {t("branding.removing")}
                  </>
                ) : (
                  t("branding.removeLogo")
                )}
              </Button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}