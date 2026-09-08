"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";

import { setLanguageAction } from "@/app/actions/language";
import { isAppLanguage } from "@/i18n/config";

export function LanguageSelector() {
  const { i18n, t } = useTranslation("common");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const language = i18n.resolvedLanguage === "en" ? "en" : "id";

  return <label className="mb-4 grid gap-1 text-meta text-text-muted">
    <span>{t("language.label")}</span>
    <select
      aria-label={t("language.label")}
      className="rounded-control border border-border bg-bg-base px-3 py-2 text-body text-text-primary outline-none focus:border-accent"
      disabled={pending}
      value={language}
      onChange={(event) => {
        const next = event.target.value;
        if (!isAppLanguage(next) || next === language) return;
        startTransition(async () => {
          await setLanguageAction(next);
          await i18n.changeLanguage(next);
          document.documentElement.lang = next;
          router.refresh();
        });
      }}
    >
      <option value="id">Indonesia</option>
      <option value="en">English</option>
    </select>
  </label>;
}
