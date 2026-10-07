"use server";

import { revalidatePath } from "next/cache";
import { normalizedProfile, requireApprovedProfile } from "@/lib/auth";
import { localApplicationRequest, localProfile } from "@/lib/application-persistence";
import { hasUnexpectedFormFields } from "@/lib/form-security";
import type { FormMutationResult } from "@/lib/mutation-feedback";
import { normalizeProfileName } from "@/lib/profile-display";

const NAME_FIELDS = new Set(["full_name"]);

export async function saveOwnProfileNameAction(form: FormData): Promise<FormMutationResult> {
  const { userId } = await requireApprovedProfile();
  const name = normalizeProfileName(form.get("full_name"));
  if (hasUnexpectedFormFields(form, NAME_FIELDS) || form.getAll("full_name").length !== 1 || !name) {
    return { ok: false, code: "INVALID_PROFILE" };
  }
  const updated = await localApplicationRequest("PATCH", "/api/application/profiles/self/name", {
    actor_id: userId, full_name: name,
  });
  if (!updated.ok) return { ok: false, code: updated.code };
  const result = updated.data;
  if (typeof result !== "object" || result === null || !("changed" in result) || typeof result.changed !== "boolean") {
    return { ok: false, code: "LOCAL_APPLICATION_UNAVAILABLE" };
  }
  const verified = normalizedProfile(await localProfile(userId));
  if (!verified || verified.id !== userId || verified.status !== "approved" || verified.full_name !== name) {
    return { ok: false, code: "LOCAL_APPLICATION_UNAVAILABLE" };
  }
  if (result.changed) {
    revalidatePath("/", "layout");
    revalidatePath("/admin");
  }
  return { ok: true, changed: result.changed };
}
