"use client";

import { useActionState } from "react";

import { registerAction, type AuthActionState } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";

const inputClasses =
  "mt-2 w-full rounded-control border border-border bg-bg-base px-3 py-2 text-body text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent focus:ring-1 focus:ring-accent";
const initialAuthState: AuthActionState = { error: null, message: null };

export function RegisterForm() {
  const [state, formAction, pending] = useActionState(
    registerAction,
    initialAuthState,
  );

  return (
    <form action={formAction} className="space-y-4">
      <label className="block text-body font-medium">
        Nama lengkap
        <input
          className={inputClasses}
          name="full_name"
          type="text"
          autoComplete="name"
          minLength={2}
          required
        />
      </label>

      <label className="block text-body font-medium">
        Email
        <input
          className={inputClasses}
          name="email"
          type="email"
          autoComplete="email"
          required
        />
      </label>

      <label className="block text-body font-medium">
        Password
        <input
          className={inputClasses}
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
        />
        <span className="mt-1 block text-meta font-normal text-text-muted">
          Minimal 8 karakter.
        </span>
      </label>

      {state.error ? (
        <p role="alert" className="text-meta text-severity-critical">
          {state.error}
        </p>
      ) : null}

      {state.message ? (
        <p role="status" className="text-meta text-severity-low">
          {state.message}
        </p>
      ) : null}

      <Button className="w-full" disabled={pending} type="submit">
        {pending ? "Mendaftarkan..." : "Daftar"}
      </Button>
    </form>
  );
}
