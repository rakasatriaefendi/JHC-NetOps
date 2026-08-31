"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireAdminProfile } from "@/lib/auth";

export async function setViewerAccessAction(formData: FormData) {
  const targetUserId = String(formData.get("user_id") ?? "");
  const requestedAccess = String(formData.get("enabled") ?? "");

  if (!targetUserId || !["true", "false"].includes(requestedAccess)) {
    redirect("/admin?error=invalid-request");
  }

  const enabled = requestedAccess === "true";
  const { supabase, userId } = await requireAdminProfile();
  const { data: updatedProfile, error } = await supabase
    .from("profiles")
    .update({
      status: enabled ? "approved" : "rejected",
      approved_at: enabled ? new Date().toISOString() : null,
      approved_by: enabled ? userId : null,
    })
    .eq("id", targetUserId)
    .eq("role", "viewer")
    .select("id")
    .maybeSingle();

  if (error || !updatedProfile) {
    redirect("/admin?error=update-failed");
  }

  revalidatePath("/admin");
  revalidatePath("/pending");
  redirect(`/admin?notice=${enabled ? "enabled" : "disabled"}`);
}
