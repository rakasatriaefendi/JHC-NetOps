import {
  ASSET_EVIDENCE_LIMIT,
  ASSET_SERVICE_LIMIT,
  classifyAsset,
  normalizeVendor,
  type AssetConfidence,
  type AssetEvidence,
  type AssetObservation,
  type AssetService,
} from "./evidence.js";
import type { NmapHost, NmapService } from "./nmap-parser.js";

export function normalizeScannedHost(discovery: NmapHost, fingerprint: NmapHost | null, observedAt: string): AssetObservation {
  const combined = fingerprint ?? discovery;
  const mac = discovery.mac_address ?? combined.mac_address;
  const vendor = normalizeVendor(discovery.vendor) ?? normalizeVendor(combined.vendor);
  const hostname = usefulHostname(combined.hostname ?? discovery.hostname, discovery.ip_address);
  const services = combined.services.map(normalizeService).slice(0, ASSET_SERVICE_LIMIT);
  const os = normalizeOs(combined, services);
  const macKind = macKindFromAddress(mac);
  const nmapType = combined.os_matches.flatMap((match) => match.device_types)[0] ?? null;
  const classified = classifyAsset({
    nodeType: null,
    fingerprintType: normalizeNmapDeviceType(nmapType),
    vendor,
    hostname: hostname ?? discovery.ip_address,
    platform: os.platform,
    services,
    macKind,
    sourceConfidence: os.confidence ?? (nmapType ? "medium" : "low"),
  });
  const evidence: AssetEvidence[] = [
    { source: "active_scan", label: "Nmap discovery", value: "Host responded during an explicit inventory scan" },
    ...(vendor ? [{ source: "active_scan", label: "MAC vendor", value: vendor }] : []),
    ...os.evidence,
    ...services.slice(0, 8).map((service) => ({
      source: "active_scan",
      label: `${service.protocol.toUpperCase()}/${service.port}`,
      value: serviceDescription(service),
    })),
    ...classified.evidence,
  ].slice(0, ASSET_EVIDENCE_LIMIT);
  return {
    // Source observation only. The ingestion resolver chooses durable identity;
    // its provisional key also includes the immutable scan run/timestamp.
    stable_source_key: `active_scan:observation:${discovery.ip_address}`,
    name: hostname ?? discovery.ip_address,
    hostname,
    device_type: classified.deviceType,
    status: "online",
    ip_address: discovery.ip_address,
    mac_address: mac,
    vendor,
    platform: os.platform,
    first_seen_at: observedAt,
    last_seen_at: observedAt,
    source: "active_scan",
    classification_confidence: classified.confidence,
    os_confidence: os.confidence,
    classification_evidence: evidence,
    open_ports: services.map((service) => service.port),
    detected_services: services,
    latency_ms: discovery.latency_ms ?? combined.latency_ms,
    evidence_updated_at: observedAt,
    network_node_ref: null,
    health_target_ref: null,
    managed_telemetry_target_ref: null,
    observed_host_target_ref: null,
    field_evidence: {
      name: hostname ? "observed" : "fallback",
      device_type: classified.deviceType === "unknown" ? "unobserved" : "inferred",
      services: fingerprint ? "complete" : "unobserved",
    },
  };
}

const CANONICAL_DEVICE_TYPES = new Set([
  "computer_workstation",
  "server",
  "nas_storage_server",
  "printer",
  "router_firewall",
  "switch_network",
  "access_point",
  "network_device",
  "camera_cctv",
  "voip_gateway",
  "industrial_controller",
  "iot_smart_device",
  "medical_device",
]);

function isCanonicalKnownType(type: string): boolean {
  return CANONICAL_DEVICE_TYPES.has(type);
}

export function mergeActiveScanObservation(existing: AssetObservation, scanned: AssetObservation): AssetObservation {
  const preserveOperatorType = (existing.source === "manual" || existing.network_node_ref !== null)
    && existing.device_type !== "unknown"
    && existing.device_type.trim() !== "";
  const scanOsWins = confidenceRank(scanned.os_confidence) >= confidenceRank(existing.os_confidence) && scanned.platform !== null;
  const scannedTypeKnown = isCanonicalKnownType(scanned.device_type);
  const existingTypeKnown = isCanonicalKnownType(existing.device_type);
  const scanTypeWins = !preserveOperatorType
    && scannedTypeKnown
    && (!existingTypeKnown || confidenceRank(scanned.classification_confidence) >= confidenceRank(existing.classification_confidence));
  const selfHealExistingType = !preserveOperatorType
    && existing.device_type !== "unknown"
    && !existingTypeKnown;
  const mergedDeviceType = preserveOperatorType
    ? existing.device_type
    : scanTypeWins
      ? scanned.device_type
      : existingTypeKnown
        ? existing.device_type
        : "unknown";
  const mergedClassificationConfidence = scanTypeWins || selfHealExistingType
    ? scanned.classification_confidence
    : existing.classification_confidence;
  const mergedVendor = normalizeVendor(scanned.vendor) ?? normalizeVendor(existing.vendor);
  const completeServiceEvidence = scanned.field_evidence?.services === "complete";
  return {
    ...existing,
    stable_source_key: existing.stable_source_key,
    name: usefulHostname(existing.name, existing.ip_address ?? "") ? existing.name : scanned.name,
    hostname: scanned.hostname ?? existing.hostname,
    device_type: mergedDeviceType,
    status: existing.health_target_ref ? existing.status : "online",
    ip_address: scanned.ip_address ?? existing.ip_address,
    mac_address: scanned.mac_address ?? existing.mac_address,
    vendor: mergedVendor,
    platform: scanOsWins ? scanned.platform : existing.platform,
    first_seen_at: earliest(existing.first_seen_at, scanned.first_seen_at),
    last_seen_at: latest(existing.last_seen_at, scanned.last_seen_at),
    source: preserveOperatorType ? existing.source : "active_scan",
    classification_confidence: mergedClassificationConfidence,
    os_confidence: scanOsWins ? scanned.os_confidence : existing.os_confidence,
    classification_evidence: mergeEvidence(existing.classification_evidence, scanned.classification_evidence),
    open_ports: completeServiceEvidence
      ? scanned.open_ports
      : scanned.open_ports.length ? uniqueNumbers([...existing.open_ports, ...scanned.open_ports]) : existing.open_ports,
    detected_services: completeServiceEvidence
      ? scanned.detected_services
      : scanned.detected_services.length ? mergeServices(existing.detected_services, scanned.detected_services) : existing.detected_services,
    latency_ms: scanned.latency_ms ?? existing.latency_ms,
    evidence_updated_at: latest(existing.evidence_updated_at, scanned.evidence_updated_at),
    ...(scanned.field_evidence ? { field_evidence: scanned.field_evidence } : {}),
  };
}

function normalizeOs(host: NmapHost, services: readonly AssetService[]): { platform: string | null; confidence: AssetConfidence; evidence: AssetEvidence[] } {
  const best = host.os_matches[0];
  const serviceText = services.map(serviceDescription).join(" ").toLowerCase();
  const osText = [best?.name, ...(best?.os_families ?? []), ...host.services.map((service) => service.os_type)].filter(Boolean).join(" ");
  const platform = platformFromText(osText);
  if (platform) {
    const confidence: AssetConfidence = best ? best.accuracy >= 90 ? "high" : best.accuracy >= 70 ? "medium" : "low" : "medium";
    return { platform, confidence, evidence: [{ source: "active_scan", label: "Nmap OS", value: `${best?.name ?? osText}${best ? ` (${best.accuracy}%)` : ""}`.slice(0, 256) }] };
  }
  const ports = new Set(services.map((service) => service.port));
  const windowsMarkers = /microsoft-ds|msrpc|netbios|smb|windows/.test(serviceText);
  const windowsPorts = [135, 139, 445, 3389].filter((port) => ports.has(port)).length;
  if (windowsMarkers || windowsPorts >= 2) return inferred("Windows", windowsMarkers && windowsPorts >= 2 ? "high" : "medium", "Windows service/port evidence");
  if ((ports.has(22) && /openssh|dropbear|linux|unix/.test(serviceText))) return inferred("Linux / Unix", "high", "SSH implementation evidence");
  if (ports.has(22)) return inferred("Linux / Unix", "medium", "SSH service evidence");
  if (/apple|darwin|macos|mac os/.test(serviceText)) return inferred("macOS / Apple", "medium", "Apple service evidence");
  return { platform: null, confidence: null, evidence: [] };
}

function inferred(platform: string, confidence: AssetConfidence, value: string) {
  return { platform, confidence, evidence: [{ source: "active_scan", label: "OS inference", value }] };
}

function platformFromText(value: string): string | null {
  const text = value.toLowerCase();
  if (/windows|microsoft/.test(text)) return "Windows";
  if (/linux|unix|ubuntu|debian|centos|red hat|freebsd|openbsd|netbsd/.test(text)) return "Linux / Unix";
  if (/macos|mac os|darwin|apple/.test(text)) return "macOS / Apple";
  if (/routeros|junos|cisco ios|ios-xe|network appliance/.test(text)) return "Network Appliance";
  return null;
}

function normalizeNmapDeviceType(value: string | null): string | null {
  const text = value?.toLowerCase() ?? "";
  if (/router|firewall/.test(text)) return "router";
  if (/switch/.test(text)) return "switch";
  if (/access point|wireless/.test(text)) return "access_point";
  if (/printer/.test(text)) return "printer";
  if (/storage|nas/.test(text)) return "nas_storage_server";
  if (/server/.test(text)) return "server";
  return null;
}

function normalizeService(service: NmapService): AssetService {
  return {
    protocol: service.protocol,
    port: service.port,
    name: service.name,
    ...(service.product ? { product: service.product } : {}),
    ...(service.version ? { version: service.version } : {}),
    ...(service.extra_info ? { extra_info: service.extra_info } : {}),
    ...(service.tunnel ? { tunnel: service.tunnel } : {}),
  };
}

function serviceDescription(service: AssetService): string {
  return [service.name, service.product, service.version, service.extra_info].filter(Boolean).join(" ").slice(0, 256);
}

function usefulHostname(value: string | null, ip: string): string | null {
  const text = value?.trim();
  return text && text !== ip && text.length <= 255 && !/[\u0000-\u001f\u007f]/.test(text) ? text : null;
}

function macKindFromAddress(mac: string | null): "global" | "locally_administered" | "unavailable" {
  if (!mac) return "unavailable";
  return (Number.parseInt(mac.slice(0, 2), 16) & 2) === 0 ? "global" : "locally_administered";
}

function confidenceRank(value: AssetConfidence): number { return value === "high" ? 3 : value === "medium" ? 2 : value === "low" ? 1 : 0; }
function earliest(...values: (string | null)[]): string | null { return values.filter((value): value is string => Boolean(value)).sort()[0] ?? null; }
function latest(...values: (string | null)[]): string | null { return values.filter((value): value is string => Boolean(value)).sort().at(-1) ?? null; }
function uniqueNumbers(values: readonly number[]): number[] { return [...new Set(values)].sort((a, b) => a - b).slice(0, ASSET_SERVICE_LIMIT); }
function mergeEvidence(left: readonly AssetEvidence[], right: readonly AssetEvidence[]): AssetEvidence[] {
  const result = new Map<string, AssetEvidence>();
  for (const item of [...left, ...right]) result.set(`${item.source}\0${item.label}\0${item.value}`, item);
  return [...result.values()].slice(-ASSET_EVIDENCE_LIMIT);
}
function mergeServices(left: readonly AssetService[], right: readonly AssetService[]): AssetService[] {
  const result = new Map(left.map((item) => [`${item.protocol}:${item.port}`, item]));
  for (const item of right) result.set(`${item.protocol}:${item.port}`, item);
  return [...result.values()].sort((a, b) => a.port - b.port).slice(0, ASSET_SERVICE_LIMIT);
}
