"use server";

import { cookies } from "next/headers";

import { isAppLanguage, languageCookieName, type AppLanguage } from "@/i18n/config";

export async function setLanguageAction(language: AppLanguage): Promise<void> {
  if (!isAppLanguage(language)) return;
  (await cookies()).set(languageCookieName, language, {
    httpOnly: false,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365,
    path: "/",
  });
}
