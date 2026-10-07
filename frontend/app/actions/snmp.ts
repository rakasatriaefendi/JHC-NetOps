"use server";

import { revalidatePath } from "next/cache";

import { requireApprovedProfile, requireOperatorProfile } from "@/lib/auth";
import { hasUnexpectedFormFields } from "@/lib/form-security";
import { loadManagedTelemetry, validateManagedTelemetryForm } from "@/lib/managed-telemetry";
import { portableDevMode } from "@/lib/portable-dev-mode";
import { applicationDeleted, localApplicationRequest, localManagedTarget, localNetworkNode,
  localManagedTargets, localRunner } from "@/lib/application-persistence";

const TELEMETRY_FIELDS = new Set([
  "node_id", "runner_id", "credential_profile_ref", "snmp_version",
  "snmp_port", "poll_interval_seconds", "oper_error_threshold",
  "discard_threshold", "util_warning_percent", "util_critical_percent",
  "util_sustained_seconds", "enabled",
]);
const DELETE_TELEMETRY_FIELDS = new Set(["target_id", "confirmation"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function loadManagedTelemetryForNodeAction(nodeId: string) {
  const authority = "local_postgres" as const;
  if (!UUID_PATTERN.test(nodeId)) {
    return { authority, target: null, interfaces: [], observedHosts: [], events: [], error: true };
  }
  await requireApprovedProfile();
  const telemetry = await loadManagedTelemetry();
  if (telemetry.error) return { authority, target: null, interfaces: [], observedHosts: [], events: [], error: true };
  const target = telemetry.data.find((item) => item.node_id === nodeId) ?? null;
  if (!target) return { authority, target: null, interfaces: [], observedHosts: [], events: [], error: false };
  return {
    authority,
    target,
    interfaces: telemetry.interfaces.filter((item) => item.target_id === target.id),
    observedHosts: telemetry.observedHosts.filter((item) => item.target_id === target.id),
    events: telemetry.events.filter((item) => item.source_ref === target.id),
    error: false,
  };
}

export async function saveManagedTelemetryTargetAction(formData: FormData) {
  if (portableDevMode()) {
    return { ok: false, code: "portable-read-only" };
  }
  if (hasUnexpectedFormFields(formData, TELEMETRY_FIELDS)) {
    return { ok: false, code: "invalid-request" };
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
  if (validationError) return { ok: false, code: "invalid-request" };

  const { userId } = await requireOperatorProfile();
  const [node, runner] = await Promise.all([localNetworkNode(values.node_id), localRunner(values.runner_id)]);
  if (!node || !runner) return { ok: false, code: "unknown-target" };

  const enabled = formData.get("enabled") === "on";
  if (enabled && !runnerCredentialProfiles(runner.capabilities).includes(values.credential_profile_ref)) {
    return { ok: false, code: "profile-unavailable" };
  }

  const saved = await localApplicationRequest("POST", "/api/application/managed-targets", {
    actor_id: userId, input: { ...values, enabled },
  });
  if (!saved.ok) return { ok: false, code: "save-failed" };
  const refreshed = await localManagedTargets();
  const current = refreshed?.find((row) => row.node_id === values.node_id && row.runner_id === values.runner_id);
  if (!current || current.enabled !== enabled || Object.entries(values).some(([key, value]) =>
    typeof value === "number" ? Number(current[key]) !== value : current[key] !== value)) return { ok: false, code: "refresh-failed" };
  revalidatePath("/snmp");
  revalidatePath("/dashboard");
  return { ok: true };
}

export async function deleteManagedTelemetryTargetAction(formData: FormData) {
  if (portableDevMode()) {
    return { ok: false, code: "portable-read-only" };
  }
  if (hasUnexpectedFormFields(formData, DELETE_TELEMETRY_FIELDS)) {
    return { ok: false, code: "invalid-request" };
  }
  const targetId = String(formData.get("target_id") ?? "");
  const confirmation = String(formData.get("confirmation") ?? "");
  if (!UUID_PATTERN.test(targetId) || !confirmation || confirmation.length > 500) {
    return { ok: false, code: "invalid-request" };
  }

  const { userId } = await requireOperatorProfile();
  const target = await localManagedTarget(targetId);
  if (!target || typeof target.node_name !== "string" || typeof target.ip_address !== "string" ||
    confirmation !== `${target.node_name} (${target.ip_address})`) {
    return { ok: false, code: "unknown-target" };
  }

  const deleted = await localApplicationRequest("DELETE", `/api/application/managed-targets/${targetId}`,
    { actor_id: userId, confirmation });
  if (!applicationDeleted(deleted)) return { ok: false, code: "delete-failed" };
  revalidatePath("/snmp");
  revalidatePath("/devices");
  revalidatePath("/dashboard");
  return verifiedTelemetryMutation(targetId, "id", true);
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

async function verifiedTelemetryMutation(value: string, field: string, deleted = false) {
  const rows = await localManagedTargets();
  if (!rows || rows.some((row) => row[field] === value) === deleted) return { ok: false, code: "refresh-failed" };
  return { ok: true };
}
