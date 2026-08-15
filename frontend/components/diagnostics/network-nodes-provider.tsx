"use client";

import { createContext, useContext, useState } from "react";

import {
  NETWORK_NODE_SELECT,
  normalizeNetworkNodeIp,
  validateNetworkNodeInput,
  type NetworkNode,
  type NetworkNodeInput,
} from "@/lib/network-nodes";
import { createClient } from "@/lib/supabase/client";

type NetworkNodesContextValue = {
  nodes: NetworkNode[];
  canManage: boolean;
  loadError: boolean;
  saveNode: (current: NetworkNode | null, input: NetworkNodeInput) => Promise<string | null>;
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
  role: "admin" | "viewer";
}) {
  const [nodes, setNodes] = useState(initialNodes);
  const canManage = role === "admin";

  async function saveNode(current: NetworkNode | null, input: NetworkNodeInput) {
    if (!canManage) return "Hanya admin yang boleh mengubah label network node.";
    const validationError = validateNetworkNodeInput(input);
    if (validationError) return validationError;

    const normalizedIp = normalizeNetworkNodeIp(input.ip_address);
    if (!normalizedIp) return "IP address tidak valid.";
    const payload = {
      ip_address: normalizedIp,
      name: input.name.trim(),
      device_type: input.device_type,
      location: optionalText(input.location),
      notes: optionalText(input.notes),
    };
    const supabase = createClient();
    const query = current
      ? supabase.from("network_nodes").update({
          name: payload.name,
          device_type: payload.device_type,
          location: payload.location,
          notes: payload.notes,
        }).eq("id", current.id)
      : supabase.from("network_nodes").insert(payload);
    const { data, error } = await query
      .select(NETWORK_NODE_SELECT)
      .single<NetworkNode>();

    if (error || !data) {
      return error?.code === "23505"
        ? "IP ini sudah memiliki network node. Gunakan Edit pada label yang sudah ada."
        : "Network node gagal disimpan. Periksa hak akses dan coba lagi.";
    }

    setNodes((values) => [data, ...values.filter((node) => node.id !== data.id)]
      .toSorted((left, right) => left.ip_address.localeCompare(right.ip_address)));
    return null;
  }

  async function deleteNode(node: NetworkNode) {
    if (!canManage) return "Hanya admin yang boleh menghapus label network node.";
    const supabase = createClient();
    const { error } = await supabase.from("network_nodes").delete().eq("id", node.id);
    if (error) return "Network node gagal dihapus. Periksa hak akses dan coba lagi.";
    setNodes((values) => values.filter((value) => value.id !== node.id));
    return null;
  }

  return (
    <NetworkNodesContext.Provider
      value={{ nodes, canManage, loadError, saveNode, deleteNode }}
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
