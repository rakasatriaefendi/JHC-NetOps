export const supportedLanguages = ["id", "en"] as const;
export type AppLanguage = (typeof supportedLanguages)[number];

export const defaultLanguage: AppLanguage = "id";
export const fallbackLanguage: AppLanguage = "en";
export const languageCookieName = "jhc-netops-language";

export function isAppLanguage(value: unknown): value is AppLanguage {
  return typeof value === "string" && supportedLanguages.includes(value as AppLanguage);
}

export function localeForLanguage(language: string): "id-ID" | "en-US" {
  return language === "en" ? "en-US" : "id-ID";
}
