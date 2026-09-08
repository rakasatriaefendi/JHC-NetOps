import "server-only";

import { cookies } from "next/headers";
import { createInstance, type TFunction } from "i18next";

import { defaultLanguage, fallbackLanguage, isAppLanguage, languageCookieName, localeForLanguage, type AppLanguage } from "@/i18n/config";
import { namespaces, resources, type AppNamespace } from "@/i18n/resources";

export async function getRequestLanguage(): Promise<AppLanguage> {
  const value = (await cookies()).get(languageCookieName)?.value;
  return isAppLanguage(value) ? value : defaultLanguage;
}

export async function getServerTranslation(namespace: AppNamespace | AppNamespace[] = "common"): Promise<{
  language: AppLanguage;
  locale: "id-ID" | "en-US";
  t: TFunction;
}> {
  const language = await getRequestLanguage();
  const instance = createInstance();
  await instance.init({
    lng: language,
    fallbackLng: fallbackLanguage,
    supportedLngs: [...Object.keys(resources)],
    ns: [...namespaces],
    defaultNS: Array.isArray(namespace) ? namespace[0] : namespace,
    fallbackNS: "common",
    resources,
    // Server translations are rendered as React text, which provides the escaping boundary.
    interpolation: { escapeValue: false },
    initAsync: false,
  });
  return { language, locale: localeForLanguage(language), t: instance.getFixedT(language, namespace) };
}
