"use client";

import { useActionState } from "react";
import { useTranslation } from "react-i18next";

import { loginAction, type AuthActionState } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";

const inputClasses =
  "mt-2 w-full rounded-control border border-border bg-bg-base px-3 py-2 text-body text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent focus:ring-1 focus:ring-accent";
const initialAuthState: AuthActionState = { error: null, message: null };

export function LoginForm() {
  const { t } = useTranslation("auth");
  const [state, formAction, pending] = useActionState(
    loginAction,
    initialAuthState,
  );

  return (
    <form action={formAction} className="space-y-4">
      <label className="block text-body font-medium">
        {t("fields.email")}
        <input
          className={inputClasses}
          name="email"
          type="email"
          autoComplete="email"
          required
        />
      </label>

      <label className="block text-body font-medium">
        {t("fields.password")}
        <input
          className={inputClasses}
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </label>

      {state.error ? (
        <p role="alert" className="text-meta text-severity-critical">
          {state.error}
        </p>
      ) : null}

      <Button className="w-full" disabled={pending} type="submit">
        {pending ? t("login.submitting") : t("login.submit")}
      </Button>
    </form>
  );
}
