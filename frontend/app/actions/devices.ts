"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireOperatorProfile } from "@/lib/auth";
import { applicationDeleted, localApplicationRequest, localHealthTarget, localNetworkNode,
  localNetworkNodes, localRunner } from "@/lib/application-persistence";
import { hasUnexpectedFormFields } from "@/lib/form-security";
import {
  NETWORK_NODE_TYPES,
  normalizeNetworkNodeIpv4,
  validateManualNetworkNodeInput,
  type NetworkNodeInput,
  type NetworkNodeType,
} from "@/lib/network-nodes";

const DEVICE_FIELDS = new Set(["ip_address", "name", "device_type", "location", "notes"]);
const UPDATE_DEVICE_FIELDS = new Set(["node_id", "name", "device_type", "location", "notes"]);
const DELETE_DEVICE_FIELDS = new Set(["node_id", "confirmation"]);
const HEALTH_FIELDS = new Set([
  "node_id", "runner_id", "probe_interval_seconds", "timeout_ms",
  "failure_threshold", "recovery_threshold", "latency_warning_ms",
  "loss_warning_percent", "enabled", "critical",
]);
const DELETE_HEALTH_FIELDS = new Set(["target_id", "confirmation"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

  const { userId } = await requireOperatorProfile();
  const nodes = await localNetworkNodes();
  if (!nodes) redirect("/devices?device_error=save-failed#device-inventory");
  if (nodes.some((node) => node.ip_address === normalizedIp)) {
    redirect("/devices?device_notice=existing#device-inventory");
  }
  const created = await localApplicationRequest("POST", "/api/application/network-nodes", {
    actor_id: userId,
    input: { ip_address: normalizedIp, name: input.name.trim(), device_type: input.device_type,
      location: input.location, notes: input.notes },
  });
  if (!created.ok) redirect("/devices?device_error=save-failed#device-inventory");

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
  const validRunner = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
  const valid = UUID_PATTERN.test(nodeId) && validRunner.test(runnerId)
    && integerBetween(values.probe_interval_seconds, 15, 3600)
    && integerBetween(values.timeout_ms, 250, 5000)
    && integerBetween(values.failure_threshold, 2, 10)
    && integerBetween(values.recovery_threshold, 1, 5)
    && Number.isFinite(values.latency_warning_ms) && values.latency_warning_ms >= 1 && values.latency_warning_ms <= 60000
    && Number.isFinite(values.loss_warning_percent) && values.loss_warning_percent >= 0 && values.loss_warning_percent <= 100;
  if (!valid) redirect("/devices?health_error=invalid-request#network-health-targets");

  const { userId } = await requireOperatorProfile();
  const [node, runner] = await Promise.all([localNetworkNode(nodeId), localRunner(runnerId)]);
  if (!node || !runner) redirect("/devices?health_error=unknown-target#network-health-targets");
  const saved = await localApplicationRequest("POST", "/api/application/network-targets", {
    actor_id: userId, input: { node_id: nodeId, runner_id: runnerId,
      enabled: formData.get("enabled") === "on", critical: formData.get("critical") === "on", ...values },
  });
  if (!saved.ok) redirect("/devices?health_error=save-failed#network-health-targets");
  revalidatePath("/devices");
  revalidatePath("/dashboard");
  redirect("/devices?health_notice=saved#network-health-targets");
}

export async function updateNetworkNodeAction(formData: FormData) {
  if (hasUnexpectedFormFields(formData, UPDATE_DEVICE_FIELDS)) {
    redirect("/devices?device_error=invalid-request#device-inventory");
  }
  const nodeId = String(formData.get("node_id") ?? "");
  const deviceType = String(formData.get("device_type") ?? "").trim();
  if (!UUID_PATTERN.test(nodeId) || (deviceType && !NETWORK_NODE_TYPES.includes(deviceType as NetworkNodeType))) {
    redirect("/devices?device_error=invalid-request#device-inventory");
  }

  const { userId } = await requireOperatorProfile();
  const existing = await localNetworkNode(nodeId);
  if (!existing || typeof existing.ip_address !== "string") {
    redirect("/devices?device_error=unknown-device#device-inventory");
  }

  const input: NetworkNodeInput = {
    ip_address: existing.ip_address,
    name: String(formData.get("name") ?? ""),
    device_type: deviceType ? deviceType as NetworkNodeType : null,
    location: optionalText(formData.get("location")),
    notes: optionalText(formData.get("notes")),
  };
  if (validateManualNetworkNodeInput(input)) {
    redirect("/devices?device_error=invalid-request#device-inventory");
  }

  const updated = await localApplicationRequest("PATCH", `/api/application/network-nodes/${nodeId}`, {
    actor_id: userId, input: { name: input.name.trim(), device_type: input.device_type,
      location: input.location, notes: input.notes },
  });
  if (!updated.ok) redirect("/devices?device_error=save-failed#device-inventory");

  revalidateDevices();
  redirect("/devices?device_notice=updated#device-inventory");
}

export async function deleteNetworkTargetAction(formData: FormData) {
  if (hasUnexpectedFormFields(formData, DELETE_HEALTH_FIELDS)) {
    redirect("/devices?health_error=invalid-request#network-health-targets");
  }
  const targetId = String(formData.get("target_id") ?? "");
  const confirmation = String(formData.get("confirmation") ?? "");
  if (!UUID_PATTERN.test(targetId) || !confirmation || confirmation.length > 500) {
    redirect("/devices?health_error=invalid-request#network-health-targets");
  }

  const { userId } = await requireOperatorProfile();
  const target = await localHealthTarget(targetId);
  if (!target || typeof target.node_name !== "string" || typeof target.ip_address !== "string" ||
    confirmation !== confirmationLabel(target.node_name, target.ip_address)) {
    redirect("/devices?health_error=unknown-target#network-health-targets");
  }

  const deleted = await localApplicationRequest("DELETE", `/api/application/network-targets/${targetId}`,
    { actor_id: userId, confirmation });
  if (!applicationDeleted(deleted)) redirect("/devices?health_error=delete-failed#network-health-targets");
  revalidatePath("/devices");
  revalidatePath("/dashboard");
  redirect("/devices?health_notice=deleted#network-health-targets");
}

export async function deleteNetworkNodeAction(formData: FormData) {
  if (hasUnexpectedFormFields(formData, DELETE_DEVICE_FIELDS)) {
    redirect("/devices?device_error=invalid-request#device-inventory");
  }
  const nodeId = String(formData.get("node_id") ?? "");
  const confirmation = String(formData.get("confirmation") ?? "");
  if (!UUID_PATTERN.test(nodeId) || !confirmation || confirmation.length > 500) {
    redirect("/devices?device_error=invalid-request#device-inventory");
  }

  const { userId } = await requireOperatorProfile();
  const node = await localNetworkNode(nodeId);
  if (!node || typeof node.name !== "string" || typeof node.ip_address !== "string" ||
    confirmation !== confirmationLabel(node.name, node.ip_address)) {
    redirect("/devices?device_error=unknown-device#device-inventory");
  }

  const deleted = await localApplicationRequest("DELETE", `/api/application/network-nodes/${nodeId}`,
    { actor_id: userId, confirmation });
  if (!applicationDeleted(deleted)) {
    redirect(`/devices?device_error=${deleted.code === "DEPENDENT_TARGETS_PRESENT" ? "blocked-health-snmp" : "delete-failed"}#device-inventory`);
  }
  revalidateDevices();
  redirect("/devices?device_notice=deleted#device-inventory");
}

function optionalText(value: FormDataEntryValue | null) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function integerBetween(value: number, minimum: number, maximum: number) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function confirmationLabel(name: string, ipAddress: string) {
  return `${name} (${ipAddress})`;
}

function revalidateDevices() {
  revalidatePath("/devices");
  revalidatePath("/snmp");
  revalidatePath("/dashboard");
  revalidatePath("/diagnostics");
}
