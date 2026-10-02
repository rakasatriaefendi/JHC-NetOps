"use server";

import { requireOperatorProfile } from "@/lib/auth";
import { applicationDeleted, localApplicationRequest, localNetworkNode, uuid } from "@/lib/application-persistence";
import type { DeviceFingerprint } from "@/lib/device-inspector";
import { normalizeNetworkNodeIp, validateNetworkNodeInput,
  type NetworkNode, type NetworkNodeInput } from "@/lib/network-nodes";

export type NodeMutationResult = { data: NetworkNode | null; error: "duplicate" | "invalid" | "failed" | null };

export async function saveNetworkNodeClientAction(
  currentId: string | null,
  input: NetworkNodeInput,
  fingerprint: DeviceFingerprint | null,
): Promise<NodeMutationResult> {
  const normalizedIp = normalizeNetworkNodeIp(input.ip_address);
  if (!normalizedIp || validateNetworkNodeInput(input) || (currentId !== null && !uuid(currentId)) ||
    (fingerprint !== null && fingerprint.ip !== normalizedIp)) return { data: null, error: "invalid" };
  const { userId } = await requireOperatorProfile();
  const payload = {
    ip_address: normalizedIp, name: input.name.trim(), device_type: input.device_type,
    location: optionalText(input.location), notes: optionalText(input.notes),
    ...(fingerprint ? { detected_fingerprint: fingerprint, last_inspected_at: new Date().toISOString() } : {}),
  };
  const result = await localApplicationRequest(currentId ? "PATCH" : "POST",
    currentId ? `/api/application/network-nodes/${currentId}` : "/api/application/network-nodes",
    { actor_id: userId, input: currentId ? { name: payload.name, device_type: payload.device_type,
      location: payload.location, notes: payload.notes,
      ...(fingerprint ? { detected_fingerprint: fingerprint, last_inspected_at: payload.last_inspected_at } : {}) }
      : payload });
  const stored = result.ok ? networkNode(result.data) : null;
  return stored ? { data: stored, error: null }
    : { data: null, error: result.code === "INVENTORY_DUPLICATE" ? "duplicate" : "failed" };
}

export async function saveNetworkFingerprintClientAction(nodeId: string, fingerprint: DeviceFingerprint): Promise<NodeMutationResult> {
  if (!uuid(nodeId) || !normalizeNetworkNodeIp(fingerprint.ip)) return { data: null, error: "invalid" };
  const { userId } = await requireOperatorProfile();
  const node = await localNetworkNode(nodeId);
  if (!node || node.ip_address !== fingerprint.ip) return { data: null, error: "invalid" };
  const result = await localApplicationRequest("PATCH", `/api/application/network-nodes/${nodeId}/fingerprint`,
    { actor_id: userId, fingerprint });
  const stored = result.ok ? networkNode(result.data) : null;
  return stored ? { data: stored, error: null } : { data: null, error: "failed" };
}

export async function deleteNetworkNodeClientAction(nodeId: string): Promise<{ ok: boolean }> {
  if (!uuid(nodeId)) return { ok: false };
  const { userId } = await requireOperatorProfile();
  const node = await localNetworkNode(nodeId);
  if (!node || typeof node.name !== "string" || typeof node.ip_address !== "string") return { ok: false };
  const result = await localApplicationRequest("DELETE", `/api/application/network-nodes/${nodeId}`,
    { actor_id: userId, confirmation: `${node.name} (${node.ip_address})` });
  return { ok: applicationDeleted(result) };
}

function networkNode(value: unknown): NetworkNode | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.ip_address !== "string" || typeof row.name !== "string") return null;
  return row as NetworkNode;
}

function optionalText(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed || null;
}
