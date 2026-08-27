"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireAdminProfile } from "@/lib/auth";
import { validateManagedTelemetryForm } from "@/lib/managed-telemetry";

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

export async function saveManagedTelemetryTargetAction(formData: FormData) {
  const values = {
    node_id: String(formData.get("node_id") ?? ""),
    runner_id: String(formData.get("runner_id") ?? ""),
    credential_profile_ref: String(formData.get("credential_profile_ref") ?? "").trim(),
    snmp_version: String(formData.get("snmp_version") ?? ""),
    snmp_port: Number(formData.get("snmp_port")),
    poll_interval_seconds: Number(formData.get("poll_interval_seconds")),
    oper_error_threshold: Number(formData.get("oper_error_threshold")),
    discard_threshold: Number(formData.get("discard_threshold")),
    util_warning_percent: Number(formData.get("util_warning_percent")),
    util_critical_percent: Number(formData.get("util_critical_percent")),
    util_sustained_seconds: Number(formData.get("util_sustained_seconds")),
  };
  const validationError = validateManagedTelemetryForm(values);
  if (validationError) redirect("/admin?telemetry_error=invalid-request#managed-telemetry");

  const { supabase } = await requireAdminProfile();
  const [{ data: node }, { data: runner }] = await Promise.all([
    supabase.from("network_nodes").select("id").eq("id", values.node_id).maybeSingle(),
    supabase.from("diagnostic_runners").select("id").eq("id", values.runner_id).maybeSingle(),
  ]);
  if (!node || !runner) redirect("/admin?telemetry_error=unknown-target#managed-telemetry");
  const { error } = await supabase.from("managed_telemetry_targets").upsert({
    node_id: values.node_id,
    runner_id: values.runner_id,
    enabled: formData.get("enabled") === "on",
    credential_profile_ref: values.credential_profile_ref,
    snmp_version: values.snmp_version,
    snmp_port: values.snmp_port,
    poll_interval_seconds: values.poll_interval_seconds,
    oper_error_threshold: values.oper_error_threshold,
    discard_threshold: values.discard_threshold,
    util_warning_percent: values.util_warning_percent,
    util_critical_percent: values.util_critical_percent,
    util_sustained_seconds: values.util_sustained_seconds,
  }, { onConflict: "runner_id,node_id" });
  if (error) redirect("/admin?telemetry_error=save-failed#managed-telemetry");
  revalidatePath("/admin");
  revalidatePath("/dashboard");
  redirect("/admin?telemetry_notice=saved#managed-telemetry");
}

function integerBetween(value: number, minimum: number, maximum: number) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
