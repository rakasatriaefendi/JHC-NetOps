"use client";

import { createContext, useContext, useState } from "react";

import {
  normalizeNetworkNodeIp,
  validateNetworkNodeInput,
  type NetworkNode,
  type NetworkNodeInput,
} from "@/lib/network-nodes";
import { deleteNetworkNodeClientAction, saveNetworkFingerprintClientAction,
  saveNetworkNodeClientAction } from "@/app/actions/network-nodes-client";
import type { DeviceFingerprint } from "@/lib/device-inspector";
import { canOperateNetwork, type ProfileRole } from "@/lib/authorization";

type NetworkNodesContextValue = {
  nodes: NetworkNode[];
  canManage: boolean;
  loadError: boolean;
  saveNode: (current: NetworkNode | null, input: NetworkNodeInput, fingerprint?: DeviceFingerprint | null) => Promise<string | null>;
  saveFingerprint: (node: NetworkNode, fingerprint: DeviceFingerprint) => Promise<string | null>;
  deleteNode: (node: NetworkNode) => Promise<string | null>;
};

const NetworkNodesContext = createContext<NetworkNodesContextValue | null>(null);

export function NetworkNodesProvider({
  children,
  initialNodes,
  loadError = false,
  role,
}: {
  children: React.ReactNode;
  initialNodes: NetworkNode[];
  loadError?: boolean;
  role: ProfileRole;
}) {
  const [nodes, setNodes] = useState(initialNodes);
  const canManage = canOperateNetwork(role);

  async function saveNode(current: NetworkNode | null, input: NetworkNodeInput, fingerprint?: DeviceFingerprint | null) {
    if (!canManage) return "Role Operator diperlukan untuk mengubah label network node.";
    const validationError = validateNetworkNodeInput(input);
    if (validationError) return validationError;

    const normalizedIp = normalizeNetworkNodeIp(input.ip_address);
    if (!normalizedIp) return "IP address tidak valid.";
    const { data, error } = await saveNetworkNodeClientAction(current?.id ?? null,
      { ...input, ip_address: normalizedIp, location: optionalText(input.location),
        notes: optionalText(input.notes) }, fingerprint ?? null);
    if (error || !data) {
      return error === "duplicate"
        ? "IP ini sudah memiliki network node. Gunakan Edit pada label yang sudah ada."
        : "Network node gagal disimpan. Periksa hak akses dan coba lagi.";
    }

    setNodes((values) => [data, ...values.filter((node) => node.id !== data.id)]
      .toSorted((left, right) => left.ip_address.localeCompare(right.ip_address)));
    return null;
  }

  async function saveFingerprint(node: NetworkNode, fingerprint: DeviceFingerprint) {
    if (!canManage) return "Role Operator diperlukan untuk menyimpan detected fingerprint.";
    if (fingerprint.ip !== normalizeNetworkNodeIp(node.ip_address)) return "Fingerprint tidak cocok dengan IP inventory.";
    const { data, error } = await saveNetworkFingerprintClientAction(node.id, fingerprint);
    if (error || !data) return "Detected fingerprint gagal disimpan.";
    setNodes((values) => values.map((value) => value.id === data.id ? data : value));
    return null;
  }

  async function deleteNode(node: NetworkNode) {
    if (!canManage) return "Role Operator diperlukan untuk menghapus label network node.";
    const { ok } = await deleteNetworkNodeClientAction(node.id);
    if (!ok) return "Network node gagal dihapus. Periksa hak akses dan coba lagi.";
    setNodes((values) => values.filter((value) => value.id !== node.id));
    return null;
  }

  return (
    <NetworkNodesContext.Provider
      value={{ nodes, canManage, loadError, saveNode, saveFingerprint, deleteNode }}
    >
      {children}
    </NetworkNodesContext.Provider>
  );
}

export function useNetworkNodes() {
  const value = useContext(NetworkNodesContext);
  if (!value) throw new Error("useNetworkNodes must be used inside NetworkNodesProvider");
  return value;
}

function optionalText(value: string | null) {
  const trimmed = value?.trim() ?? "";
  return trimmed || null;
}
