"use server";

import { revalidatePath } from "next/cache";

import { requireAdminProfile } from "@/lib/auth";
import { isAccessStatus, isProfileRole } from "@/lib/authorization";
import { hasUnexpectedFormFields } from "@/lib/form-security";
import { deleteAccountLocal, disableAccountLocal, reenableAccountLocal, localApplicationRequest,
  localProfile, localProfiles, type AccountLifecycleResult } from "@/lib/application-persistence";

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
    return { ok: false, code: "INVALID_PROFILE" };
  }

  const before = await localProfile(targetUserId);
  if (!before) return { ok: false, code: "PROFILE_NOT_FOUND" };

  const updated = await localApplicationRequest("PATCH", "/api/application/profiles/access", {
    actor_id: userId, target_id: targetUserId, role, access_status: accessStatus,
  });

  const status = accessStatus === "active" ? "approved" : accessStatus === "suspended" ? "rejected" : "pending";
  return finishLifecycle(updated, targetUserId, status, role, before.role !== role || before.status !== status);
}

export async function disableUserAction(formData: FormData) {
  const { userId } = await requireAdminProfile();
  const targetId = lifecycleTarget(formData, USER_LIFECYCLE_FIELDS);
  if (!targetId) return { ok: false, code: "INVALID_PROFILE" };
  return finishLifecycle(await disableAccountLocal(userId, targetId), targetId, "disabled");
}

export async function reenableUserAction(formData: FormData) {
  const { userId } = await requireAdminProfile();
  const targetId = lifecycleTarget(formData, USER_LIFECYCLE_FIELDS);
  if (!targetId) return { ok: false, code: "INVALID_PROFILE" };
  return finishLifecycle(await reenableAccountLocal(userId, targetId), targetId, "approved");
}

export async function deleteUserAction(formData: FormData) {
  const { userId } = await requireAdminProfile();
  const targetId = lifecycleTarget(formData, USER_DELETE_FIELDS);
  const confirmation = formData.get("confirmation");
  if (!targetId || confirmation !== "DELETE USER") return { ok: false, code: "INVALID_PROFILE" };
  return finishLifecycle(await deleteAccountLocal(userId, targetId, confirmation), targetId, null);
}

function lifecycleTarget(formData: FormData, allowed: ReadonlySet<string>): string | null {
  const targetId = formData.get("user_id");
  if (hasUnexpectedFormFields(formData, allowed) ||
    [...allowed].some((key) => formData.getAll(key).length !== 1) ||
    typeof targetId !== "string" || !UUID_PATTERN.test(targetId)) return null;
  return targetId;
}

async function finishLifecycle(result: AccountLifecycleResult, targetId: string, status: string | null, role?: string, changed = true) {
  if (!result.ok) return { ok: false, code: result.code };
  const profiles = await localProfiles();
  if (!profiles) return { ok: false, code: "LOCAL_APPLICATION_UNAVAILABLE" };
  const target = profiles.find((row) => row.id === targetId);
  if (status === null ? Boolean(target) : !target || target.status !== status || role !== undefined && target.role !== role) {
    return { ok: false, code: "LOCAL_APPLICATION_UNAVAILABLE" };
  }
  revalidatePath("/admin");
  revalidatePath("/pending");
  return { ok: true, changed };
}
