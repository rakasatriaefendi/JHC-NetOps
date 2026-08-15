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

export async function saveNetworkTargetAction(formData: FormData) {
  const nodeId = String(formData.get("node_id") ?? "");
  const runnerId = String(formData.get("runner_id") ?? "");
  const values = {
    probe_interval_seconds: Number(formData.get("probe_interval_seconds")),
    timeout_ms: Number(formData.get("timeout_ms")),
    failure_threshold: Number(formData.get("failure_threshold")),
    recovery_threshold: Number(formData.get("recovery_threshold")),
    latency_warning_ms: Number(formData.get("latency_warning_ms")),
    loss_warning_percent: Number(formData.get("loss_warning_percent")),
  };
  const validUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const validRunner = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
  const valid = validUuid.test(nodeId) && validRunner.test(runnerId)
    && integerBetween(values.probe_interval_seconds, 15, 3600)
    && integerBetween(values.timeout_ms, 250, 5000)
    && integerBetween(values.failure_threshold, 2, 10)
    && integerBetween(values.recovery_threshold, 1, 5)
    && Number.isFinite(values.latency_warning_ms) && values.latency_warning_ms >= 1 && values.latency_warning_ms <= 60000
    && Number.isFinite(values.loss_warning_percent) && values.loss_warning_percent >= 0 && values.loss_warning_percent <= 100;
  if (!valid) redirect("/admin?health_error=invalid-request#network-health-targets");

  const { supabase } = await requireAdminProfile();
  const [{ data: node }, { data: runner }] = await Promise.all([
    supabase.from("network_nodes").select("id").eq("id", nodeId).maybeSingle(),
    supabase.from("diagnostic_runners").select("id").eq("id", runnerId).maybeSingle(),
  ]);
  if (!node || !runner) redirect("/admin?health_error=unknown-target#network-health-targets");
  const { error } = await supabase.from("network_targets").upsert({
    node_id: nodeId,
    runner_id: runnerId,
    enabled: formData.get("enabled") === "on",
    critical: formData.get("critical") === "on",
    probe_method: "icmp",
    ...values,
  }, { onConflict: "runner_id,node_id" });
  if (error) redirect("/admin?health_error=save-failed#network-health-targets");
  revalidatePath("/admin");
  revalidatePath("/dashboard");
  redirect("/admin?health_notice=saved#network-health-targets");
}

function integerBetween(value: number, minimum: number, maximum: number) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
