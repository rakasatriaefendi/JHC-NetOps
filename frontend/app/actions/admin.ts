"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireAdminProfile } from "@/lib/auth";
import { isAccessStatus, isProfileRole } from "@/lib/authorization";
import { hasUnexpectedFormFields } from "@/lib/form-security";
import { applicationAuthority, localApplicationRequest } from "@/lib/application-persistence";

const USER_ACCESS_FIELDS = new Set(["user_id", "role", "access_status"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function setUserAccessAction(formData: FormData) {
  const targetUserId = String(formData.get("user_id") ?? "");
  const role = String(formData.get("role") ?? "");
  const accessStatus = String(formData.get("access_status") ?? "");

  if (hasUnexpectedFormFields(formData, USER_ACCESS_FIELDS) || !UUID_PATTERN.test(targetUserId) || !isProfileRole(role) || !isAccessStatus(accessStatus)) {
    redirect("/admin?error=invalid-request");
  }

  const { supabase, userId } = await requireAdminProfile();
  const updated = applicationAuthority() === "local_postgres"
    ? await localApplicationRequest("PATCH", "/api/application/profiles/access", {
      actor_id: userId, target_id: targetUserId, role, access_status: accessStatus,
    })
    : await supabase.rpc("admin_update_profile_access", {
      p_target_id: targetUserId, p_role: role, p_access_status: accessStatus,
    }).then(({ data, error }) => ({ ok: !error && Boolean(data) }));

  if (!updated.ok) {
    redirect("/admin?error=update-failed");
  }

  revalidatePath("/admin");
  revalidatePath("/pending");
  redirect("/admin?notice=updated");
}
