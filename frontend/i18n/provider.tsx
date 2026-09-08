"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";

import { fallbackLanguage, type AppLanguage } from "@/i18n/config";
import { namespaces, resources } from "@/i18n/resources";

export function AppI18nProvider({ children, language }: { children: ReactNode; language: AppLanguage }) {
  const [instance] = useState(() => {
    const next = createInstance();
    void next.use(initReactI18next).init({
      lng: language,
      fallbackLng: fallbackLanguage,
      supportedLngs: [...Object.keys(resources)],
      ns: [...namespaces],
      defaultNS: "common",
      fallbackNS: "common",
      resources,
      // React escapes rendered text; i18next escaping here would display device names as HTML entities.
      interpolation: { escapeValue: false },
      initAsync: false,
      react: { useSuspense: false },
    });
    return next;
  });

  useEffect(() => {
    if (instance.resolvedLanguage !== language) void instance.changeLanguage(language);
  }, [instance, language]);

  return <I18nextProvider i18n={instance}>{children}</I18nextProvider>;
}
