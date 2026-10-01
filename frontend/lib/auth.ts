import type { SupabaseClient } from "@supabase/supabase-js";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { canAdministerUsers, canOperateNetwork, isActiveUser, type ProfileRole, type ProfileStatus } from "@/lib/authorization";
import { localAuthenticatedProfile } from "@/lib/local-auth";
import { getApplicationAuthority } from "@/lib/application-authority";

export type { ProfileRole, ProfileStatus } from "@/lib/authorization";

export type Profile = {
  id: string;
  email: string;
  full_name: string | null;
  role: ProfileRole;
  status: ProfileStatus;
  created_at: string;
  approved_at: string | null;
  approved_by: string | null;
};

type AuthenticatedProfile = {
  supabase: SupabaseClient;
  userId: string;
  profile: Profile | null;
};

export async function getAuthenticatedProfile(): Promise<AuthenticatedProfile> {
  const profile = normalizedProfile(await localAuthenticatedProfile());
  if (!profile) redirect("/login");
  const supabase = getApplicationAuthority() === "supabase"
    ? await createClient()
    : unavailableSupabaseClient();
  const userId = profile.id;

  return { supabase, userId, profile };
}

function unavailableSupabaseClient(): SupabaseClient {
  return new Proxy({}, {
    get() {
      throw new Error("Supabase compatibility client is unavailable under local_postgres authority");
    },
  }) as SupabaseClient;
}

export function normalizedProfile(value: Record<string, unknown> | null): Profile | null {
  if (!value || typeof value.id !== "string" || typeof value.email !== "string" ||
    !["admin", "operator", "viewer"].includes(String(value.role)) ||
    !["pending", "approved", "rejected"].includes(String(value.status)) ||
    typeof value.created_at !== "string") return null;
  return {
    id: value.id, email: value.email,
    full_name: typeof value.full_name === "string" ? value.full_name : null,
    role: value.role as ProfileRole, status: value.status as ProfileStatus,
    created_at: value.created_at,
    approved_at: typeof value.approved_at === "string" ? value.approved_at : null,
    approved_by: typeof value.approved_by === "string" ? value.approved_by : null,
  };
}

export async function requireApprovedProfile() {
  const auth = await getAuthenticatedProfile();

  if (!auth.profile || !isActiveUser(auth.profile.status)) {
    redirect("/pending");
  }

  return { ...auth, profile: auth.profile };
}

export async function requireAdminProfile() {
  const auth = await requireApprovedProfile();

  if (!canAdministerUsers(auth.profile.role)) {
    redirect("/dashboard");
  }

  return auth;
}

export async function requireOperatorProfile() {
  const auth = await requireApprovedProfile();

  if (!canOperateNetwork(auth.profile.role)) {
    redirect("/dashboard");
  }

  return auth;
}
