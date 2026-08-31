"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireAdminProfile } from "@/lib/auth";
import { hasUnexpectedFormFields } from "@/lib/form-security";
import {
  NETWORK_NODE_TYPES,
  normalizeNetworkNodeIpv4,
  validateManualNetworkNodeInput,
  type NetworkNodeInput,
  type NetworkNodeType,
} from "@/lib/network-nodes";

const DEVICE_FIELDS = new Set(["ip_address", "name", "device_type", "location", "notes"]);
const HEALTH_FIELDS = new Set([
  "node_id", "runner_id", "probe_interval_seconds", "timeout_ms",
  "failure_threshold", "recovery_threshold", "latency_warning_ms",
  "loss_warning_percent", "enabled", "critical",
]);

export async function saveManualNetworkNodeAction(formData: FormData) {
  if (hasUnexpectedFormFields(formData, DEVICE_FIELDS)) {
    redirect("/devices?device_error=invalid-request#device-inventory");
  }

  const deviceType = String(formData.get("device_type") ?? "").trim();
  const input: NetworkNodeInput = {
    ip_address: String(formData.get("ip_address") ?? ""),
    name: String(formData.get("name") ?? ""),
    device_type: deviceType && NETWORK_NODE_TYPES.includes(deviceType as NetworkNodeType)
      ? deviceType as NetworkNodeType
      : deviceType ? "unknown" as const : null,
    location: optionalText(formData.get("location")),
    notes: optionalText(formData.get("notes")),
  };
  if (deviceType && !NETWORK_NODE_TYPES.includes(deviceType as NetworkNodeType)) {
    redirect("/devices?device_error=invalid-request#device-inventory");
  }
  const validationError = validateManualNetworkNodeInput(input);
  const normalizedIp = normalizeNetworkNodeIpv4(input.ip_address);
  if (validationError || !normalizedIp) {
    redirect("/devices?device_error=invalid-request#device-inventory");
  }

  const { supabase, userId } = await requireAdminProfile();
  const { data: existing, error: lookupError } = await supabase
    .from("network_nodes")
    .select("id")
    .eq("ip_address", normalizedIp)
    .maybeSingle();
  if (lookupError) redirect("/devices?device_error=save-failed#device-inventory");
  if (existing) redirect("/devices?device_notice=existing#device-inventory");

  const { error } = await supabase.from("network_nodes").insert({
    ip_address: normalizedIp,
    name: input.name.trim(),
    device_type: input.device_type,
    location: input.location,
    notes: input.notes,
    created_by: userId,
  });
  if (error?.code === "23505") {
    redirect("/devices?device_notice=existing#device-inventory");
  }
  if (error) redirect("/devices?device_error=save-failed#device-inventory");

  revalidatePath("/devices");
  revalidatePath("/snmp");
  revalidatePath("/dashboard");
  redirect("/devices?device_notice=created#device-inventory");
}

export async function saveNetworkTargetAction(formData: FormData) {
  if (hasUnexpectedFormFields(formData, HEALTH_FIELDS)) {
    redirect("/devices?health_error=invalid-request#network-health-targets");
  }
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
  if (!valid) redirect("/devices?health_error=invalid-request#network-health-targets");

  const { supabase } = await requireAdminProfile();
  const [{ data: node }, { data: runner }] = await Promise.all([
    supabase.from("network_nodes").select("id").eq("id", nodeId).maybeSingle(),
    supabase.from("diagnostic_runners").select("id").eq("id", runnerId).maybeSingle(),
  ]);
  if (!node || !runner) redirect("/devices?health_error=unknown-target#network-health-targets");
  const { error } = await supabase.from("network_targets").upsert({
    node_id: nodeId,
    runner_id: runnerId,
    enabled: formData.get("enabled") === "on",
    critical: formData.get("critical") === "on",
    probe_method: "icmp",
    ...values,
  }, { onConflict: "runner_id,node_id" });
  if (error) redirect("/devices?health_error=save-failed#network-health-targets");
  revalidatePath("/devices");
  revalidatePath("/dashboard");
  redirect("/devices?health_notice=saved#network-health-targets");
}

function optionalText(value: FormDataEntryValue | null) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function integerBetween(value: number, minimum: number, maximum: number) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
