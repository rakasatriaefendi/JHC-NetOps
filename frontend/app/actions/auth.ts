"use server";

import { redirect } from "next/navigation";

import { logAuthFailure } from "@/lib/auth-logging";
import { localAuthLogin, localAuthLogout, localAuthRegister } from "@/lib/local-auth";
import { getServerTranslation } from "@/i18n/server";

export type AuthActionState = {
  error: string | null;
  message: string | null;
};

export type LoginActionState = AuthActionState & {
  authenticated: boolean;
};

export async function loginAction(
  _previousState: LoginActionState,
  formData: FormData,
): Promise<LoginActionState> {
  const { t } = await getServerTranslation("auth");
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: t("errors.required"), message: null, authenticated: false };
  }

  const result = await localAuthLogin(email, password);
  if (!result.ok) {
    logAuthFailure("login", { code: result.code });
    return { error: t("errors.invalid"), message: null, authenticated: false };
  }

  return { error: null, message: null, authenticated: true };
}

export async function registerAction(
  _previousState: LoginActionState,
  formData: FormData,
): Promise<LoginActionState> {
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
      authenticated: false,
    };
  }

  const result = await localAuthRegister(email, password, fullName);
  if (!result.ok) {
    logAuthFailure("register", { code: result.code });
    return {
      error: t("errors.registerFailed"),
      message: null,
      authenticated: false,
    };
  }

  return {
    error: null,
    message: t("messages.registered"),
    authenticated: true,
  };
}

export async function logoutAction() {
  await localAuthLogout();
  redirect("/login");
}
