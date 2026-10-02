export const NETWORK_NODE_TYPES = [
  "gateway",
  "router",
  "layer3_switch",
  "managed_switch",
  "server",
  "firewall",
  "access_point",
  "workstation",
  "printer",
  "camera",
  "iot",
  "phone",
  "unknown",
  "other",
] as const;

export type NetworkNodeType = (typeof NETWORK_NODE_TYPES)[number];

export type NetworkNode = {
  id: string;
  ip_address: string;
  name: string;
  device_type: NetworkNodeType | null;
  location: string | null;
  notes: string | null;
  detected_fingerprint: import("@/lib/device-inspector").DeviceFingerprint | null;
  last_inspected_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type NetworkNodeInput = {
  ip_address: string;
  name: string;
  device_type: NetworkNodeType | null;
  location: string | null;
  notes: string | null;
};

export function findNetworkNode(
  nodes: NetworkNode[],
  ipAddress: string | null,
): NetworkNode | undefined {
  if (!ipAddress) return undefined;
  const normalized = normalizeNetworkNodeIp(ipAddress);
  if (!normalized) return undefined;
  return nodes.find(
    (node) => normalizeNetworkNodeIp(node.ip_address) === normalized,
  );
}

export function normalizeNetworkNodeIp(value: string): string | null {
  const candidate = value.trim();
  if (!candidate || candidate.includes("/") || candidate.includes("%")) return null;

  const octets = candidate.split(".");
  if (octets.length === 4) {
    if (!octets.every(
      (octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255,
    )) return null;
    return octets.map((octet) => String(Number(octet))).join(".");
  }

  if (!candidate.includes(":")) return null;
  try {
    const hostname = new URL(`http://[${candidate}]/`).hostname;
    const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return normalized.includes(":") ? normalized : null;
  } catch {
    return null;
  }
}

export function normalizeNetworkNodeIpv4(value: string): string | null {
  const normalized = normalizeNetworkNodeIp(value);
  return normalized && !normalized.includes(":") ? normalized : null;
}

export function validateNetworkNodeInput(input: NetworkNodeInput): string | null {
  if (!normalizeNetworkNodeIp(input.ip_address)) return "IP address tidak valid.";
  if (!input.name.trim()) return "Nama node wajib diisi.";
  if (input.name.trim().length > 200) return "Nama node maksimal 200 karakter.";
  if (input.location && input.location.length > 200) return "Lokasi maksimal 200 karakter.";
  if (input.notes && input.notes.length > 2000) return "Notes maksimal 2000 karakter.";
  if (input.device_type && !NETWORK_NODE_TYPES.includes(input.device_type)) {
    return "Device type tidak valid.";
  }
  return null;
}

export function validateManualNetworkNodeInput(input: NetworkNodeInput): string | null {
  if (!normalizeNetworkNodeIpv4(input.ip_address)) {
    return "IPv4 host wajib diisi tanpa subnet, range, atau CIDR.";
  }
  return validateNetworkNodeInput(input);
}

export function networkNodeTypeLabel(value: NetworkNodeType | null) {
  return ({
    gateway: "Gateway",
    router: "Router",
    layer3_switch: "Layer-3 switch",
    managed_switch: "Managed switch",
    server: "Server",
    firewall: "Firewall",
    access_point: "Access point",
    workstation: "Workstation",
    printer: "Printer",
    camera: "Camera",
    iot: "IoT",
    phone: "Phone",
    unknown: "Unknown",
    other: "Other",
  } as const)[value ?? "other"];
}

export function networkNodeDisplayName(
  node: NetworkNode | undefined,
  authoritativeTargetLabel?: string | null,
) {
  return authoritativeTargetLabel || node?.name || "Unknown node";
}
