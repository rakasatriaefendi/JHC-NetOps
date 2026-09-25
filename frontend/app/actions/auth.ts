"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { logAuthFailure } from "@/lib/auth-logging";
import { configuredAuthPublicOrigin, resolveAuthRedirectOrigin } from "@/lib/auth-redirect-origin";
import { createClient } from "@/lib/supabase/server";
import { getServerTranslation } from "@/i18n/server";

export type AuthActionState = {
  error: string | null;
  message: string | null;
};

export async function loginAction(
  _previousState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const { t } = await getServerTranslation("auth");
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: t("errors.required"), message: null };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    logAuthFailure("login", error);
    return { error: t("errors.invalid"), message: null };
  }

  redirect("/auth/resolve");
}

export async function registerAction(
  _previousState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const { t } = await getServerTranslation("auth");
  const fullName = String(formData.get("full_name") ?? "").trim();
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (fullName.length < 2 || !email || password.length < 8) {
    return {
      error: t("errors.registerValidation"),
      message: null,
    };
  }

  const supabase = await createClient();
  const requestHeaders = await headers();
  const requestOrigin = requestHeaders.get("origin");
  const configuredOrigin = configuredAuthPublicOrigin();
  const origin = requestOrigin
    ? resolveAuthRedirectOrigin(requestOrigin, requestHeaders)
    : configuredOrigin;

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: fullName },
      ...(origin
        ? { emailRedirectTo: `${origin}/auth/callback?next=/pending` }
        : {}),
    },
  });

  if (error) {
    logAuthFailure("register", error);
    return {
      error: t("errors.registerFailed"),
      message: null,
    };
  }

  if (data.session) {
    redirect("/pending");
  }

  return {
    error: null,
    message: t("messages.registered"),
  };
}

export async function logoutAction() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
