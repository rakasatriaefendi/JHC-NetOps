"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { assetExportHref } from "@/lib/asset-report-query";
import type { AssetInventoryQuery } from "@/lib/assets";

export function AssetExportButton({ query, disabled = false }: { query: AssetInventoryQuery; disabled?: boolean }) {
  const { t, i18n } = useTranslation("assets");
  const [state, setState] = useState<"idle" | "loading" | "success" | "error">("idle");

  async function download() {
    if (disabled || state === "loading") return;
    setState("loading");
    try {
      const response = await fetch(assetExportHref(query, i18n.language === "en" ? "en" : "id"), { cache: "no-store" });
      if (!response.ok) throw new Error("Asset report request failed");
      const blob = await response.blob();
      const filename = response.headers.get("content-disposition")?.match(/filename="([^"]+\.xlsx)"/)?.[1];
      if (!filename || blob.size === 0) throw new Error("Asset report response is invalid");
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(href);
      setState("success");
    } catch {
      setState("error");
    }
  }

  return <div className="text-right">
    <Button disabled={disabled || state === "loading"} variant="secondary" onClick={() => void download()}>
      {t(state === "loading" ? "report.exporting" : "report.action")}
    </Button>
    {state === "success" || state === "error" ? <p className={`mt-1 text-meta ${state === "error" ? "text-severity-critical" : "text-severity-low"}`} role="status">{t(`report.${state}`)}</p> : null}
  </div>;
}
