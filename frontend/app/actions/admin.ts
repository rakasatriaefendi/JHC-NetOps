"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireAdminProfile } from "@/lib/auth";
import { isAccessStatus, isProfileRole } from "@/lib/authorization";
import { hasUnexpectedFormFields } from "@/lib/form-security";
import { deleteAccountLocal, disableAccountLocal, reenableAccountLocal, localApplicationRequest,
  type AccountLifecycleResult } from "@/lib/application-persistence";

const USER_ACCESS_FIELDS = new Set(["user_id", "role", "access_status"]);
const USER_LIFECYCLE_FIELDS = new Set(["user_id"]);
const USER_DELETE_FIELDS = new Set(["user_id", "confirmation"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function setUserAccessAction(formData: FormData) {
  const { userId } = await requireAdminProfile();
  const targetUserId = String(formData.get("user_id") ?? "");
  const role = String(formData.get("role") ?? "");
  const accessStatus = String(formData.get("access_status") ?? "");

  if (hasUnexpectedFormFields(formData, USER_ACCESS_FIELDS) ||
    [...USER_ACCESS_FIELDS].some((key) => formData.getAll(key).length !== 1) ||
    !UUID_PATTERN.test(targetUserId) || !isProfileRole(role) || !isAccessStatus(accessStatus)) {
    redirect("/admin?error=invalid-request");
  }

  const updated = await localApplicationRequest("PATCH", "/api/application/profiles/access", {
    actor_id: userId, target_id: targetUserId, role, access_status: accessStatus,
  });

  finishLifecycle(updated);
}

export async function disableUserAction(formData: FormData) {
  const { userId } = await requireAdminProfile();
  const targetId = lifecycleTarget(formData, USER_LIFECYCLE_FIELDS);
  finishLifecycle(await disableAccountLocal(userId, targetId));
}

export async function reenableUserAction(formData: FormData) {
  const { userId } = await requireAdminProfile();
  const targetId = lifecycleTarget(formData, USER_LIFECYCLE_FIELDS);
  finishLifecycle(await reenableAccountLocal(userId, targetId));
}

export async function deleteUserAction(formData: FormData) {
  const { userId } = await requireAdminProfile();
  const targetId = lifecycleTarget(formData, USER_DELETE_FIELDS);
  const confirmation = formData.get("confirmation");
  if (confirmation !== "DELETE USER") redirect("/admin?error=invalid-request");
  finishLifecycle(await deleteAccountLocal(userId, targetId, confirmation));
}

function lifecycleTarget(formData: FormData, allowed: ReadonlySet<string>): string {
  const targetId = formData.get("user_id");
  if (hasUnexpectedFormFields(formData, allowed) ||
    [...allowed].some((key) => formData.getAll(key).length !== 1) ||
    typeof targetId !== "string" || !UUID_PATTERN.test(targetId)) redirect("/admin?error=invalid-request");
  return targetId;
}

function finishLifecycle(result: AccountLifecycleResult): never {
  if (!result.ok) redirect(`/admin?error=${encodeURIComponent(result.code)}`);
  revalidatePath("/admin");
  revalidatePath("/pending");
  redirect("/admin?notice=updated");
}
