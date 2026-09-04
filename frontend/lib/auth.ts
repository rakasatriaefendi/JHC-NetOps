import type { SupabaseClient } from "@supabase/supabase-js";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { canAdministerUsers, canOperateNetwork, isActiveUser, type ProfileRole, type ProfileStatus } from "@/lib/authorization";

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
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;

  if (error || !userId) {
    redirect("/login");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select(
      "id, email, full_name, role, status, created_at, approved_at, approved_by",
    )
    .eq("id", userId)
    .maybeSingle<Profile>();

  return { supabase, userId, profile };
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
