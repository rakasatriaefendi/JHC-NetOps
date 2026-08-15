"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

export type AuthActionState = {
  error: string | null;
  message: string | null;
};

export async function loginAction(
  _previousState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: "Email dan password wajib diisi.", message: null };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    return { error: "Email atau password tidak valid.", message: null };
  }

  redirect("/auth/resolve");
}

export async function registerAction(
  _previousState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const fullName = String(formData.get("full_name") ?? "").trim();
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (fullName.length < 2 || !email || password.length < 8) {
    return {
      error: "Isi nama, email, dan password minimal 8 karakter.",
      message: null,
    };
  }

  const supabase = await createClient();
  const requestHeaders = await headers();
  const origin =
    requestHeaders.get("origin") ?? process.env.NEXT_PUBLIC_SITE_URL?.trim();

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
    return {
      error: "Registrasi gagal. Periksa data atau coba beberapa saat lagi.",
      message: null,
    };
  }

  if (data.session) {
    redirect("/pending");
  }

  return {
    error: null,
    message: "Registrasi berhasil. Periksa email untuk konfirmasi akun.",
  };
}

export async function logoutAction() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
