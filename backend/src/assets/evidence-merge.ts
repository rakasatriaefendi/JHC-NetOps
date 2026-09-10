import {
  ASSET_EVIDENCE_LIMIT,
  ASSET_SERVICE_LIMIT,
  type AssetConfidence,
  type AssetEvidence,
  type AssetFieldEvidence,
  type AssetObservation,
  type AssetService,
} from "./evidence.js";

const KNOWN_DEVICE_TYPES = new Set([
  "computer_workstation", "server", "nas_storage_server", "printer", "router_firewall",
  "switch_network", "access_point", "network_device", "camera_cctv", "voip_gateway",
  "industrial_controller", "iot_smart_device", "medical_device",
]);

export function mergeAssetEvidence(existing: AssetObservation, incoming: AssetObservation): AssetObservation {
  const fields = fieldEvidence(incoming);
  const operatorOwned = existing.source === "manual" || existing.network_node_ref !== null;
  const preserveName = meaningfulName(existing.name)
    && (fields.name === "fallback" || fields.name === "observed" && operatorOwned);
  const existingTypeKnown = KNOWN_DEVICE_TYPES.has(existing.device_type);
  const incomingTypeKnown = KNOWN_DEVICE_TYPES.has(incoming.device_type);
  const useIncomingType = fields.device_type === "authoritative"
    || fields.device_type === "inferred" && incomingTypeKnown && !operatorOwned
      && (!existingTypeKnown || confidenceRank(incoming.classification_confidence) >= confidenceRank(existing.classification_confidence));
  const services = mergeServiceEvidence(existing, incoming, fields.services);

  return {
    ...incoming,
    stable_source_key: existing.stable_source_key,
    name: preserveName ? existing.name : incoming.name,
    hostname: incoming.hostname ?? existing.hostname,
    device_type: useIncomingType ? incoming.device_type : existing.device_type,
    ip_address: incoming.ip_address ?? existing.ip_address,
    mac_address: incoming.mac_address ?? existing.mac_address,
    vendor: incoming.vendor ?? existing.vendor,
    platform: incoming.platform ?? existing.platform,
    first_seen_at: earliest(existing.first_seen_at, incoming.first_seen_at),
    last_seen_at: latest(existing.last_seen_at, incoming.last_seen_at),
    classification_confidence: useIncomingType ? incoming.classification_confidence : existing.classification_confidence,
    os_confidence: incoming.platform ? incoming.os_confidence : existing.os_confidence,
    classification_evidence: mergeEvidence(existing.classification_evidence, incoming.classification_evidence),
    open_ports: services.ports,
    detected_services: services.services,
    latency_ms: incoming.latency_ms ?? existing.latency_ms,
    network_node_ref: incoming.network_node_ref ?? existing.network_node_ref,
    health_target_ref: incoming.health_target_ref ?? existing.health_target_ref,
    managed_telemetry_target_ref: incoming.managed_telemetry_target_ref ?? existing.managed_telemetry_target_ref,
    observed_host_target_ref: incoming.observed_host_target_ref ?? existing.observed_host_target_ref,
    field_evidence: fields,
  };
}

function fieldEvidence(observation: AssetObservation): AssetFieldEvidence {
  if (observation.field_evidence) return observation.field_evidence;
  const fallbackName = !meaningfulName(observation.name);
  if (observation.source === "manual" || observation.source === "import") {
    return { name: "authoritative", device_type: "authoritative", services: "unobserved" };
  }
  if (observation.source === "device_inspector") {
    return { name: fallbackName ? "fallback" : "observed", device_type: knownOrUnobserved(observation), services: "partial" };
  }
  return {
    name: fallbackName ? "fallback" : "observed",
    device_type: knownOrUnobserved(observation),
    services: "unobserved",
  };
}

function knownOrUnobserved(observation: AssetObservation): AssetFieldEvidence["device_type"] {
  return KNOWN_DEVICE_TYPES.has(observation.device_type) ? "inferred" : "unobserved";
}

function mergeServiceEvidence(
  existing: AssetObservation,
  incoming: AssetObservation,
  mode: AssetFieldEvidence["services"],
): { ports: readonly number[]; services: readonly AssetService[] } {
  if (mode === "complete") return { ports: incoming.open_ports, services: incoming.detected_services };
  if (mode === "unobserved") return { ports: existing.open_ports, services: existing.detected_services };
  return {
    ports: [...new Set([...existing.open_ports, ...incoming.open_ports])].sort((left, right) => left - right).slice(0, ASSET_SERVICE_LIMIT),
    services: mergeServices(existing.detected_services, incoming.detected_services),
  };
}

function mergeEvidence(left: readonly AssetEvidence[], right: readonly AssetEvidence[]): AssetEvidence[] {
  const result = new Map<string, AssetEvidence>();
  for (const item of [...left, ...right]) result.set(`${item.source}\0${item.label}\0${item.value}`, item);
  return [...result.values()].slice(-ASSET_EVIDENCE_LIMIT);
}

function mergeServices(left: readonly AssetService[], right: readonly AssetService[]): AssetService[] {
  const result = new Map(left.map((item) => [`${item.protocol}:${item.port}`, item]));
  for (const item of right) {
    const key = `${item.protocol}:${item.port}`;
    const previous = result.get(key);
    result.set(key, previous ? { ...previous, ...item } : item);
  }
  return [...result.values()].sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol)).slice(0, ASSET_SERVICE_LIMIT);
}

function meaningfulName(value: string): boolean {
  const parts = value.trim().split(".");
  return parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255);
}

function confidenceRank(value: AssetConfidence): number {
  return value === "high" ? 3 : value === "medium" ? 2 : value === "low" ? 1 : 0;
}

function earliest(...values: (string | null)[]): string | null {
  return values.filter((value): value is string => Boolean(value)).sort()[0] ?? null;
}

function latest(...values: (string | null)[]): string | null {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
}
