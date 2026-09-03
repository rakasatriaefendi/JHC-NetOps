"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireAdminProfile } from "@/lib/auth";
import { hasUnexpectedFormFields } from "@/lib/form-security";
import { validateManagedTelemetryForm } from "@/lib/managed-telemetry";
import { portableDevMode } from "@/lib/portable-dev-mode";

const TELEMETRY_FIELDS = new Set([
  "node_id", "runner_id", "credential_profile_ref", "snmp_version",
  "snmp_port", "poll_interval_seconds", "oper_error_threshold",
  "discard_threshold", "util_warning_percent", "util_critical_percent",
  "util_sustained_seconds", "enabled",
]);

export async function saveManagedTelemetryTargetAction(formData: FormData) {
  if (portableDevMode()) {
    redirect("/snmp?telemetry_error=portable-read-only#managed-telemetry");
  }
  if (hasUnexpectedFormFields(formData, TELEMETRY_FIELDS)) {
    redirect("/snmp?telemetry_error=invalid-request#managed-telemetry");
  }
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
  if (validationError) redirect("/snmp?telemetry_error=invalid-request#managed-telemetry");

  const { supabase } = await requireAdminProfile();
  const [{ data: node }, { data: runner }] = await Promise.all([
    supabase.from("network_nodes").select("id").eq("id", values.node_id).maybeSingle(),
    supabase.from("diagnostic_runners").select("id,capabilities").eq("id", values.runner_id).maybeSingle(),
  ]);
  if (!node || !runner) redirect("/snmp?telemetry_error=unknown-target#managed-telemetry");

  const enabled = formData.get("enabled") === "on";
  const profiles = runnerCredentialProfiles(runner.capabilities);
  if (enabled && !profiles.includes(values.credential_profile_ref)) {
    redirect("/snmp?telemetry_error=profile-unavailable#managed-telemetry");
  }

  const { error } = await supabase.from("managed_telemetry_targets").upsert({
    node_id: values.node_id,
    runner_id: values.runner_id,
    enabled,
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
  if (error) redirect("/snmp?telemetry_error=save-failed#managed-telemetry");
  revalidatePath("/snmp");
  revalidatePath("/dashboard");
  redirect("/snmp?telemetry_notice=saved#managed-telemetry");
}

function runnerCredentialProfiles(capabilities: unknown): string[] {
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return [];
  const snmp = (capabilities as { snmp_telemetry?: unknown }).snmp_telemetry;
  if (!snmp || typeof snmp !== "object" || Array.isArray(snmp)) return [];
  const profiles = (snmp as { credential_profiles?: unknown }).credential_profiles;
  return Array.isArray(profiles) && profiles.every((value) => typeof value === "string")
    ? profiles
    : [];
}
