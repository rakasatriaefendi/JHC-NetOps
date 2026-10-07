"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { type FormEvent, useRef, useState } from "react";
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
  const router = useRouter();
  const notify = useActionFeedback();
  const inFlight = useRef(false);
  const [branding, setBranding] = useState(initial);
  const [busy, setBusy] = useState<"text" | "logo" | "remove" | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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
    const form = new FormData(); form.set("logo", file);
    const saved = await update("/admin/report-branding/logo", { method: "POST", body: form }, "logo", "upload");
    if (saved && fileRef.current) fileRef.current.value = "";
  }

  async function removeLogo() {
    await update("/admin/report-branding/logo", { method: "DELETE" }, "remove", "remove");
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
      router.refresh(); // Audit read model; branding itself is the verified backend snapshot.
      if (payload.changed === true) notify(kind, true);
      return true;
    } catch { notify(kind, false); return false; }
    finally { inFlight.current = false; setBusy(null); }
  }

  const previewVersion = encodeURIComponent(branding.updated_at ?? "default");
  return <section className="mt-6 rounded-panel border border-border bg-bg-surface p-4 md:p-6" aria-labelledby="report-branding-title">
    <p className="text-meta font-medium uppercase tracking-wide text-accent">{t("branding.eyebrow")}</p>
    <h2 className="mt-2 text-section font-semibold" id="report-branding-title">{t("branding.title")}</h2>
    <p className="mt-1 text-meta text-text-secondary">{t("branding.description")}</p>
    <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
      <form className="grid gap-4" onSubmit={saveText} aria-busy={busy === "text"}>
        <label className="grid gap-2 text-meta text-text-secondary">{t("branding.institution")}
          <input className="rounded-control border border-border bg-bg-base px-3 py-2 text-text-primary" defaultValue={branding.institution_name} maxLength={160} name="institution_name" required />
        </label>
        <label className="grid gap-2 text-meta text-text-secondary">{t("branding.division")}
          <input className="rounded-control border border-border bg-bg-base px-3 py-2 text-text-primary" defaultValue={branding.division_name} maxLength={160} name="division_name" />
        </label>
        <div><Button disabled={busy !== null} aria-busy={busy === "text"} type="submit">{busy === "text" ? <><LoadingSpinner />{t("branding.saving")}</> : t("branding.save")}</Button></div>
      </form>
      <div className="rounded-control border border-border bg-bg-base p-4">
        <p className="text-meta font-medium text-text-secondary">{t("branding.logo")}</p>
        <div className="mt-3 flex min-h-24 items-center justify-center rounded-control border border-dashed border-border bg-white p-3">
          {branding.logo_available ? <Image alt={t("branding.logoPreview")} className="max-h-20 w-auto object-contain" height={80} key={previewVersion} src={`/admin/report-branding/logo?v=${previewVersion}`} unoptimized width={200} /> : <span className="text-meta text-text-muted">{t("branding.noLogo")}</span>}
        </div>
        <input disabled={busy !== null} accept=".png,.jpg,.jpeg,image/png,image/jpeg" className="mt-3 block w-full text-meta text-text-secondary file:mr-3 file:rounded-control file:border file:border-border file:bg-bg-surface file:px-3 file:py-2 file:text-text-primary" ref={fileRef} type="file" />
        <p className="mt-2 text-meta text-text-muted">{t("branding.logoHelp")}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button disabled={busy !== null} aria-busy={busy === "logo"} onClick={uploadLogo}>{busy === "logo" ? <><LoadingSpinner />{t("branding.uploading")}</> : t(branding.logo_available ? "branding.replaceLogo" : "branding.uploadLogo")}</Button>
          {branding.logo_available ? <Button disabled={busy !== null} aria-busy={busy === "remove"} onClick={removeLogo} variant="destructive">{busy === "remove" ? <><LoadingSpinner />{t("branding.removing")}</> : t("branding.removeLogo")}</Button> : null}
        </div>
      </div>
    </div>
  </section>;
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
