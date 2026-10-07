"use server";

import { revalidatePath } from "next/cache";

import { requireOperatorProfile } from "@/lib/auth";
import { applicationDeleted, localApplicationRequest, localHealthTarget, localNetworkNode,
  localNetworkNodes, localHealthTargets, localRunner } from "@/lib/application-persistence";
import { hasUnexpectedFormFields } from "@/lib/form-security";
import { isMonitoringInterval } from "@/lib/monitoring-modes";
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
    return { ok: false, code: "invalid-request" };
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
    return { ok: false, code: "invalid-request" };
  }
  const validationError = validateManualNetworkNodeInput(input);
  const normalizedIp = normalizeNetworkNodeIpv4(input.ip_address);
  if (validationError || !normalizedIp) {
    return { ok: false, code: "invalid-request" };
  }

  const { userId } = await requireOperatorProfile();
  const nodes = await localNetworkNodes();
  if (!nodes) return { ok: false, code: "save-failed" };
  if (nodes.some((node) => node.ip_address === normalizedIp)) {
    return { ok: true, changed: false };
  }
  const created = await localApplicationRequest("POST", "/api/application/network-nodes", {
    actor_id: userId,
    input: { ip_address: normalizedIp, name: input.name.trim(), device_type: input.device_type,
      location: input.location, notes: input.notes },
  });
  if (!created.ok) return { ok: false, code: "save-failed" };

  revalidatePath("/devices");
  revalidatePath("/snmp");
  revalidatePath("/dashboard");
  return verifiedDeviceMutation("nodes", normalizedIp, "ip_address");
}

export async function saveNetworkTargetAction(formData: FormData) {
  if (hasUnexpectedFormFields(formData, HEALTH_FIELDS)) {
    return { ok: false, code: "invalid-request" };
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
    && isMonitoringInterval(values.probe_interval_seconds)
    && integerBetween(values.timeout_ms, 250, 5000)
    && integerBetween(values.failure_threshold, 2, 10)
    && integerBetween(values.recovery_threshold, 1, 5)
    && Number.isFinite(values.latency_warning_ms) && values.latency_warning_ms >= 1 && values.latency_warning_ms <= 60000
    && Number.isFinite(values.loss_warning_percent) && values.loss_warning_percent >= 0 && values.loss_warning_percent <= 100;
  if (!valid) return { ok: false, code: "invalid-request" };

  const { userId } = await requireOperatorProfile();
  const [node, runner] = await Promise.all([localNetworkNode(nodeId), localRunner(runnerId)]);
  if (!node || !runner) return { ok: false, code: "unknown-target" };
  const saved = await localApplicationRequest("POST", "/api/application/network-targets", {
    actor_id: userId, input: { node_id: nodeId, runner_id: runnerId,
      enabled: formData.get("enabled") === "on", critical: formData.get("critical") === "on", ...values },
  });
  if (!saved.ok) return { ok: false, code: "save-failed" };
  const refreshed = await localHealthTargets();
  const current = refreshed?.find((row) => row.node_id === nodeId && row.runner_id === runnerId);
  if (!current || current.enabled !== (formData.get("enabled") === "on") ||
    current.critical !== (formData.get("critical") === "on") ||
    Object.entries(values).some(([key, value]) => Number(current[key]) !== value)) return { ok: false, code: "refresh-failed" };
  revalidatePath("/devices");
  revalidatePath("/dashboard");
  const data = saved.data;
  if (typeof data !== "object" || data === null || !("changed" in data) || typeof data.changed !== "boolean") return { ok: false, code: "refresh-failed" };
  return { ok: true, changed: data.changed };
}

export async function updateNetworkNodeAction(formData: FormData) {
  if (hasUnexpectedFormFields(formData, UPDATE_DEVICE_FIELDS)) {
    return { ok: false, code: "invalid-request" };
  }
  const nodeId = String(formData.get("node_id") ?? "");
  const deviceType = String(formData.get("device_type") ?? "").trim();
  if (!UUID_PATTERN.test(nodeId) || (deviceType && !NETWORK_NODE_TYPES.includes(deviceType as NetworkNodeType))) {
    return { ok: false, code: "invalid-request" };
  }

  const { userId } = await requireOperatorProfile();
  const existing = await localNetworkNode(nodeId);
  if (!existing || typeof existing.ip_address !== "string") {
    return { ok: false, code: "unknown-device" };
  }

  const input: NetworkNodeInput = {
    ip_address: existing.ip_address,
    name: String(formData.get("name") ?? ""),
    device_type: deviceType ? deviceType as NetworkNodeType : null,
    location: optionalText(formData.get("location")),
    notes: optionalText(formData.get("notes")),
  };
  if (validateManualNetworkNodeInput(input)) {
    return { ok: false, code: "invalid-request" };
  }

  const updated = await localApplicationRequest("PATCH", `/api/application/network-nodes/${nodeId}`, {
    actor_id: userId, input: { name: input.name.trim(), device_type: input.device_type,
      location: input.location, notes: input.notes },
  });
  if (!updated.ok) return { ok: false, code: "save-failed" };
  const changed = existing.name !== input.name.trim() || existing.device_type !== input.device_type ||
    existing.location !== input.location || existing.notes !== input.notes;
  const current = await localNetworkNode(nodeId);
  if (!current || current.name !== input.name.trim() || current.device_type !== input.device_type ||
    current.location !== input.location || current.notes !== input.notes) return { ok: false, code: "refresh-failed" };
  revalidateDevices();
  return { ok: true, changed };
}

export async function deleteNetworkTargetAction(formData: FormData) {
  if (hasUnexpectedFormFields(formData, DELETE_HEALTH_FIELDS)) {
    return { ok: false, code: "invalid-request" };
  }
  const targetId = String(formData.get("target_id") ?? "");
  const confirmation = String(formData.get("confirmation") ?? "");
  if (!UUID_PATTERN.test(targetId) || !confirmation || confirmation.length > 500) {
    return { ok: false, code: "invalid-request" };
  }

  const { userId } = await requireOperatorProfile();
  const target = await localHealthTarget(targetId);
  if (!target || typeof target.node_name !== "string" || typeof target.ip_address !== "string" ||
    confirmation !== confirmationLabel(target.node_name, target.ip_address)) {
    return { ok: false, code: "unknown-target" };
  }

  const deleted = await localApplicationRequest("DELETE", `/api/application/network-targets/${targetId}`,
    { actor_id: userId, confirmation });
  if (!applicationDeleted(deleted)) return { ok: false, code: "delete-failed" };
  revalidatePath("/devices");
  revalidatePath("/dashboard");
  return verifiedDeviceMutation("health", targetId, "id", true);
}

export async function deleteNetworkNodeAction(formData: FormData) {
  if (hasUnexpectedFormFields(formData, DELETE_DEVICE_FIELDS)) {
    return { ok: false, code: "invalid-request" };
  }
  const nodeId = String(formData.get("node_id") ?? "");
  const confirmation = String(formData.get("confirmation") ?? "");
  if (!UUID_PATTERN.test(nodeId) || !confirmation || confirmation.length > 500) {
    return { ok: false, code: "invalid-request" };
  }

  const { userId } = await requireOperatorProfile();
  const node = await localNetworkNode(nodeId);
  if (!node || typeof node.name !== "string" || typeof node.ip_address !== "string" ||
    confirmation !== confirmationLabel(node.name, node.ip_address)) {
    return { ok: false, code: "unknown-device" };
  }

  const deleted = await localApplicationRequest("DELETE", `/api/application/network-nodes/${nodeId}`,
    { actor_id: userId, confirmation });
  if (!applicationDeleted(deleted)) {
    return { ok: false, code: deleted.code === "DEPENDENT_TARGETS_PRESENT" ? "blocked-health-snmp" : "delete-failed" };
  }
  revalidateDevices();
  return verifiedDeviceMutation("nodes", nodeId, "id", true);
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

async function verifiedDeviceMutation(kind: "nodes" | "health", value: string, field: string, deleted = false) {
  const rows = kind === "nodes" ? await localNetworkNodes() : await localHealthTargets();
  if (!rows || rows.some((row) => row[field] === value) === deleted) return { ok: false, code: "refresh-failed" };
  return { ok: true };
}
