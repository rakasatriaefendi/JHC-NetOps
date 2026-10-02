import type { PostgresNetworkInventoryRepository } from "../persistence/inventory.js";

export const ASSET_EVIDENCE_ROW_LIMIT = 1_000;
export const ASSET_EVIDENCE_LIMIT = 32;
export const ASSET_SERVICE_LIMIT = 32;

export type AssetConfidence = "low" | "medium" | "high" | null;
export type AssetEvidence = Readonly<{ source: string; label: string; value: string }>;
export type AssetService = Readonly<{
  protocol: "tcp" | "udp";
  port: number;
  name: string;
  product?: string;
  version?: string;
  extra_info?: string;
  tunnel?: string;
}>;

export type AssetFieldEvidence = Readonly<{
  name: "authoritative" | "observed" | "fallback";
  device_type: "authoritative" | "inferred" | "unobserved";
  services: "complete" | "partial" | "unobserved";
}>;

export type AssetObservation = Readonly<{
  stable_source_key: string;
  name: string;
  hostname: string | null;
  device_type: string;
  status: "online" | "offline" | "changed" | "unknown";
  ip_address: string | null;
  mac_address: string | null;
  vendor: string | null;
  platform: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  source: "manual" | "discovery" | "observed_host" | "device_inspector" | "managed_telemetry" | "active_scan" | "import";
  classification_confidence: AssetConfidence;
  os_confidence: AssetConfidence;
  classification_evidence: readonly AssetEvidence[];
  open_ports: readonly number[];
  detected_services: readonly AssetService[];
  latency_ms: number | null;
  evidence_updated_at: string | null;
  network_node_ref: string | null;
  health_target_ref: string | null;
  managed_telemetry_target_ref: string | null;
  observed_host_target_ref: string | null;
  field_evidence?: AssetFieldEvidence;
}>;

export type AssetEvidenceSnapshot = Readonly<{
  nodes: readonly Record<string, unknown>[];
  healthTargets: readonly Record<string, unknown>[];
  managedTargets: readonly Record<string, unknown>[];
  observedHosts: readonly Record<string, unknown>[];
}>;

export interface AssetEvidenceSource {
  load(signal: AbortSignal): Promise<AssetEvidenceSnapshot>;
}

export class PostgresAssetEvidenceSource implements AssetEvidenceSource {
  constructor(private readonly inventory: Pick<PostgresNetworkInventoryRepository,
    "listNodes" | "listHealthTargets" | "listManagedTargets" | "listManagedObservedHosts">) {}

  async load(signal: AbortSignal): Promise<AssetEvidenceSnapshot> {
    const [nodes, healthTargets, managedTargets, observedHosts] = await Promise.all([
      this.inventory.listNodes(signal),
      this.inventory.listHealthTargets(signal),
      this.inventory.listManagedTargets(signal),
      this.inventory.listManagedObservedHosts(undefined, signal),
    ]);
    return {
      nodes: nodes.slice(0, ASSET_EVIDENCE_ROW_LIMIT),
      healthTargets: healthTargets.slice(0, ASSET_EVIDENCE_ROW_LIMIT).map((row) => ({
        ...row,
        network_health_latest: row.latest,
      })),
      managedTargets: managedTargets.slice(0, ASSET_EVIDENCE_ROW_LIMIT).map((row) => ({
        ...row,
        managed_device_latest: row.latest,
      })),
      observedHosts: observedHosts.slice(0, ASSET_EVIDENCE_ROW_LIMIT),
    };
  }
}

type Draft = {
  stableKey: string;
  name: string;
  hostname: string | null;
  nodeType: string | null;
  status: AssetObservation["status"];
  statusPriority: number;
  ip: string | null;
  mac: string | null;
  macKind: "global" | "locally_administered" | "unavailable";
  vendor: string | null;
  platform: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
  source: AssetObservation["source"];
  confidence: AssetConfidence;
  osConfidence: AssetConfidence;
  evidence: AssetEvidence[];
  services: AssetService[];
  latency: number | null;
  evidenceUpdatedAt: string | null;
  nodeRef: string | null;
  healthRef: string | null;
  managedRef: string | null;
  observedRef: string | null;
  fingerprintType: string | null;
  nameEvidence: AssetFieldEvidence["name"];
  servicesEvidence: AssetFieldEvidence["services"];
};

export function buildAssetObservations(snapshot: AssetEvidenceSnapshot): AssetObservation[] {
  const drafts = new Map<string, Draft>();
  const nodeById = new Map<string, Draft>();

  for (const row of snapshot.nodes.slice(0, ASSET_EVIDENCE_ROW_LIMIT)) {
    const id = uuid(row.id);
    const ip = privateIpv4(row.ip_address);
    if (!id || !ip) continue;
    const fingerprint = record(row.detected_fingerprint) ? row.detected_fingerprint : null;
    const detected = fingerprint && record(fingerprint.detected_identity) ? fingerprint.detected_identity : null;
    const identity = fingerprint && record(fingerprint.network_identity) ? fingerprint.network_identity : null;
    const confidence = normalizeConfidence(fingerprint?.confidence);
    const services = normalizeServices(fingerprint?.observed_services);
    const macKind = normalizeMacKind(identity?.mac_kind);
    const mac = normalizeMac(identity?.mac);
    const inspectedAt = timestamp(row.last_inspected_at);
    const draft: Draft = {
      stableKey: `node:${id}`,
      name: boundedText(row.name, 200) ?? ip,
      hostname: boundedText(identity?.tls_identity, 255) ?? boundedText(detected?.likely_label, 255),
      nodeType: boundedIdentifier(row.device_type),
      status: "unknown",
      statusPriority: 0,
      ip,
      mac,
      macKind,
      vendor: macKind === "global"
        ? normalizeVendor(detected?.manufacturer) ?? normalizeVendor(identity?.mac_vendor)
        : normalizeVendor(detected?.manufacturer),
      platform: normalizePlatform(detected?.os_family),
      firstSeen: timestamp(row.created_at),
      lastSeen: inspectedAt ?? timestamp(row.updated_at),
      source: fingerprint ? "device_inspector" : "manual",
      confidence,
      osConfidence: normalizePlatform(detected?.os_family) ? capConfidence(confidence ?? "medium", macKind) : null,
      evidence: fingerprintEvidence(fingerprint),
      services,
      latency: null,
      evidenceUpdatedAt: inspectedAt ?? timestamp(row.updated_at),
      nodeRef: id,
      healthRef: null,
      managedRef: null,
      observedRef: null,
      fingerprintType: boundedIdentifier(fingerprint?.likely_device_type),
      nameEvidence: "authoritative",
      servicesEvidence: fingerprint && Array.isArray(fingerprint.observed_services) ? "partial" : "unobserved",
    };
    drafts.set(draft.stableKey, draft);
    nodeById.set(id, draft);
  }

  for (const row of snapshot.healthTargets.slice(0, ASSET_EVIDENCE_ROW_LIMIT)) {
    const targetId = uuid(row.id);
    const draft = nodeById.get(uuid(row.node_id) ?? "");
    if (!targetId || !draft) continue;
    draft.healthRef = targetId;
    const latest = relation(row.network_health_latest);
    if (!latest) continue;
    const status = latest.status === "online" ? "online" : latest.status === "offline" ? "offline"
      : latest.status === "degraded" ? "changed" : "unknown";
    setStatus(draft, status, 4);
    draft.latency = boundedNumber(latest.latency_ms, 0, 60_000);
    draft.lastSeen = latest.status === "online"
      ? latestTimestamp(draft.lastSeen, timestamp(latest.last_success_at), timestamp(latest.last_checked_at))
      : latestTimestamp(draft.lastSeen, timestamp(latest.last_checked_at));
    draft.evidenceUpdatedAt = latestTimestamp(draft.evidenceUpdatedAt, timestamp(latest.last_checked_at));
    addEvidence(draft, "health_watch", "ICMP status", String(latest.status));
  }

  for (const row of snapshot.managedTargets.slice(0, ASSET_EVIDENCE_ROW_LIMIT)) {
    const targetId = uuid(row.id);
    const draft = nodeById.get(uuid(row.node_id) ?? "");
    if (!targetId || !draft) continue;
    draft.managedRef = targetId;
    const latest = relation(row.managed_device_latest);
    if (!latest) continue;
    const polledAt = timestamp(latest.last_polled_at);
    const successAt = timestamp(latest.last_success_at);
    const status = latest.status === "connected" || latest.status === "partial" ? "online" : "unknown";
    setStatus(draft, status, 3);
    draft.hostname ??= boundedText(latest.sys_name, 255);
    draft.vendor ??= normalizeVendor(latest.manufacturer);
    const inferredPlatform = inferPlatform(latest.sys_descr);
    if (!draft.platform && inferredPlatform) {
      draft.platform = inferredPlatform;
      draft.osConfidence = "medium";
    }
    draft.lastSeen = latestTimestamp(draft.lastSeen, successAt, polledAt);
    draft.evidenceUpdatedAt = latestTimestamp(draft.evidenceUpdatedAt, polledAt);
    addEvidence(draft, "managed_telemetry", "SNMP status", String(latest.status));
    addOptionalEvidence(draft, "managed_telemetry", "System name", latest.sys_name);
    addOptionalEvidence(draft, "managed_telemetry", "Model", latest.model);
  }

  for (const row of snapshot.observedHosts.slice(0, ASSET_EVIDENCE_ROW_LIMIT)) {
    const targetId = uuid(row.target_id);
    const ip = privateIpv4(row.ip_address);
    if (!targetId || !ip) continue;
    const nodeId = uuid(row.node_id);
    const key = nodeId ? `node:${nodeId}` : `observed:${targetId}:${ip}`;
    let draft = drafts.get(key);
    if (!draft) {
      const firstSeen = timestamp(row.first_seen_at);
      const lastSeen = timestamp(row.last_seen_at);
      draft = {
        stableKey: key,
        name: boundedText(row.netbios_name, 200) ?? ip,
        hostname: boundedText(row.netbios_name, 255),
        nodeType: null,
        status: row.status === "current" ? "online" : "unknown",
        statusPriority: 2,
        ip,
        mac: normalizeMac(row.mac_address),
        macKind: macKindFromAddress(row.mac_address),
        vendor: null,
        platform: null,
        firstSeen,
        lastSeen,
        source: "observed_host",
        confidence: "low",
        osConfidence: null,
        evidence: [],
        services: [],
        latency: null,
        evidenceUpdatedAt: timestamp(row.updated_at) ?? lastSeen,
        nodeRef: nodeId,
        healthRef: null,
        managedRef: null,
        observedRef: targetId,
        fingerprintType: null,
        nameEvidence: boundedText(row.netbios_name, 200) ? "observed" : "fallback",
        servicesEvidence: "unobserved",
      };
      drafts.set(key, draft);
      if (nodeId) nodeById.set(nodeId, draft);
    } else {
      draft.hostname ??= boundedText(row.netbios_name, 255);
      draft.mac ??= normalizeMac(row.mac_address);
      draft.macKind = draft.macKind === "unavailable" ? macKindFromAddress(row.mac_address) : draft.macKind;
      draft.firstSeen = earliestTimestamp(draft.firstSeen, timestamp(row.first_seen_at));
      draft.lastSeen = latestTimestamp(draft.lastSeen, timestamp(row.last_seen_at));
      draft.evidenceUpdatedAt = latestTimestamp(draft.evidenceUpdatedAt, timestamp(row.updated_at));
      draft.observedRef = targetId;
      setStatus(draft, row.status === "current" ? "online" : "unknown", 2);
    }
    addEvidence(draft, "observed_host", "Neighbor evidence", String(row.observation_source ?? "observed"));
    if (draft.macKind === "locally_administered") {
      addEvidence(draft, "observed_host", "MAC address", "Locally administered/private");
    }
  }

  return [...drafts.values()].slice(0, ASSET_EVIDENCE_ROW_LIMIT).map(finalizeDraft);
}

function finalizeDraft(draft: Draft): AssetObservation {
  const vendor = normalizeVendor(draft.vendor);
  const classified = classifyAsset({
    nodeType: draft.nodeType,
    fingerprintType: draft.fingerprintType,
    vendor,
    hostname: draft.hostname ?? draft.name,
    platform: draft.platform,
    services: draft.services,
    macKind: draft.macKind,
    sourceConfidence: draft.confidence,
  });
  const services = [...draft.services].sort((left, right) => left.port - right.port || left.protocol.localeCompare(right.protocol));
  return {
    stable_source_key: draft.stableKey,
    name: draft.name,
    hostname: draft.hostname,
    device_type: classified.deviceType,
    status: draft.status,
    ip_address: draft.ip,
    mac_address: draft.mac,
    vendor,
    platform: draft.platform,
    first_seen_at: draft.firstSeen,
    last_seen_at: draft.lastSeen,
    source: draft.source,
    classification_confidence: classified.confidence,
    os_confidence: draft.osConfidence,
    classification_evidence: [...draft.evidence, ...classified.evidence].slice(0, ASSET_EVIDENCE_LIMIT),
    open_ports: [...new Set(services.map((item) => item.port))].slice(0, ASSET_SERVICE_LIMIT),
    detected_services: services.slice(0, ASSET_SERVICE_LIMIT),
    latency_ms: draft.latency,
    evidence_updated_at: draft.evidenceUpdatedAt,
    network_node_ref: draft.nodeRef,
    health_target_ref: draft.healthRef,
    managed_telemetry_target_ref: draft.managedRef,
    observed_host_target_ref: draft.observedRef,
    field_evidence: {
      name: draft.nameEvidence,
      device_type: draft.nodeType ? "authoritative" : classified.deviceType === "unknown" ? "unobserved" : "inferred",
      services: draft.servicesEvidence,
    },
  };
}

export function classifyAsset(input: Readonly<{
  nodeType: string | null;
  fingerprintType: string | null;
  vendor: string | null;
  hostname: string;
  platform: string | null;
  services: readonly AssetService[];
  macKind: Draft["macKind"];
  sourceConfidence: AssetConfidence;
}>): { deviceType: string; confidence: AssetConfidence; evidence: AssetEvidence[] } {
  const nodeMapped = mapKnownType(input.nodeType);
  if (nodeMapped) return classification(nodeMapped, "high", "inventory", "Operator category", input.nodeType ?? "");
  const fingerprintMapped = mapKnownType(input.fingerprintType);
  if (fingerprintMapped) return classification(fingerprintMapped, capConfidence(input.sourceConfidence ?? "medium", input.macKind), "device_inspector", "Detected type", input.fingerprintType ?? "");

  const ports = new Set(input.services.map((item) => item.port));
  const serviceEvidence = input.services.flatMap((item) => [item.name, item.product, item.version, item.extra_info]);
  const text = [input.vendor, input.hostname, input.platform, ...serviceEvidence].filter(Boolean).join(" ").toLowerCase();
  const vendor = (input.vendor ?? "").toLowerCase();
  const strong = capConfidence("high", input.macKind);
  const medium = capConfidence("medium", input.macKind);

  if (/integrated lights-out|\b(?:hp )?ilo(?:\s|$)|proliant/.test(text)) return classification("server", strong, "classification", "Product evidence", "iLO / remote management");
  if (/mindray|patient monitor|medical device|medical equipment/.test(text)) return classification("medical_device", strong, "classification", "Product evidence", "Medical equipment signature");
  if (/hikvision|dahua|axis camera|network camera|\bcctv\b/.test(text)) return classification("camera_cctv", strong, "classification", "Product evidence", "Camera signature");
  if (/audiocodes|voip gateway|mediant|voip adapter/.test(text)) return classification("voip_gateway", strong, "classification", "Product evidence", "VoIP gateway signature");
  if (/keyence|industrial controller|\bplc\b|\bhmi\b/.test(text)) return classification("industrial_controller", strong, "classification", "Product evidence", "Industrial control signature");
  if (/synology|qnap|asustor|storage server/.test(text)) return classification("nas_storage_server", strong, "classification", "Product evidence", "Storage signature");
  if (/access point|wireless ap|wifi ap|wlan ap/.test(text)) return classification("access_point", medium, "classification", "Network evidence", "Access point signature");
  if (/routeros|mikrotik|\brouter\b|\bfirewall\b/.test(text)) return classification("router_firewall", medium, "classification", "Network evidence", "Router/firewall signature");
  if (/\bswitch(?:ing)?\b|catalyst|sg250|ruijie|reyee/.test(text)) return classification("switch_network", medium, "classification", "Network evidence", "Switch/network signature");

  const dedicatedPrinterVendor = /epson|brother|canon|ricoh|xerox|kyocera|lexmark|zebra/.test(vendor);
  const printerEvidence = /printer|print server|jetdirect|ipp printer|lpd printer|cups printer|laserjet|deskjet|officejet|ecotank|workforce|multifunction/.test(text);
  if (dedicatedPrinterVendor || (printerEvidence && [515, 631, 9100].some((port) => ports.has(port)))) {
    return classification("printer", dedicatedPrinterVendor ? strong : medium, "classification", "Printer evidence", dedicatedPrinterVendor ? input.vendor ?? "printer vendor" : "service and port evidence");
  }

  if (/windows|microsoft/.test(input.platform?.toLowerCase() ?? "") || [135, 139, 445, 3389].filter((port) => ports.has(port)).length >= 2) {
    return classification("unknown", medium, "classification", "OS/service evidence", "Windows signature");
  }
  if (/linux|unix|ubuntu|debian|centos|red hat/.test(text) || (ports.has(22) && /ssh|openssh|dropbear/.test(text))) {
    return classification("unknown", medium, "classification", "OS/service evidence", "Linux/Unix signature");
  }
  if (/macos|mac os|darwin|apple/.test(text)) return classification("unknown", medium, "classification", "OS/vendor evidence", "Apple signature");
  if (/cisco|juniper|aruba|tp-link|d-link|netgear/.test(vendor)) return classification("network_device", medium, "classification", "Vendor evidence", input.vendor ?? "network vendor");
  if (/dell|lenovo|acer|asustek|gigabyte|micro-star|\bmsi\b/.test(vendor)) return classification("computer_workstation", medium, "classification", "Vendor evidence", input.vendor ?? "computer vendor");
  if (/iot|zigbee|smart device|smart plug|raspberry pi/.test(text)) return classification("iot_smart_device", medium, "classification", "Device evidence", "IoT signature");
  return { deviceType: "unknown", confidence: input.macKind === "locally_administered" ? "low" : input.sourceConfidence ?? "low", evidence: [] };
}

function mapKnownType(value: string | null): string | null {
  if (!value) return null;
  return ({
    gateway: "router_firewall", router: "router_firewall", firewall: "router_firewall",
    layer3_switch: "switch_network", managed_switch: "switch_network", switch: "switch_network",
    access_point: "access_point", printer: "printer", server: "server", workstation: "computer_workstation",
    computer: "computer_workstation", camera: "camera_cctv", iot: "iot_smart_device", phone: "voip_gateway",
    medical_device: "medical_device", network_device: "network_device",
  } as Record<string, string>)[value.toLowerCase()] ?? null;
}

function classification(deviceType: string, confidence: AssetConfidence, source: string, label: string, value: string) {
  return { deviceType, confidence, evidence: [{ source, label, value: value.slice(0, 256) }] };
}

function capConfidence(value: AssetConfidence, macKind: Draft["macKind"]): AssetConfidence {
  if (macKind !== "locally_administered") return value;
  return value === "high" ? "medium" : value ?? "low";
}

function fingerprintEvidence(fingerprint: Record<string, unknown> | null): AssetEvidence[] {
  if (!fingerprint) return [];
  const result: AssetEvidence[] = [];
  const input = Array.isArray(fingerprint.evidence) ? fingerprint.evidence : [];
  for (const item of input.slice(0, ASSET_EVIDENCE_LIMIT)) {
    if (!record(item)) continue;
    const source = boundedText(item.source, 64);
    const label = boundedText(item.label, 100);
    const value = boundedText(item.value, 256);
    if (source && label && value) result.push({ source, label, value });
  }
  return result;
}

function normalizeServices(value: unknown): AssetService[] {
  if (!Array.isArray(value)) return [];
  const byKey = new Map<string, AssetService>();
  for (const item of value.slice(0, ASSET_SERVICE_LIMIT)) {
    if (!record(item) || (item.protocol !== "tcp" && item.protocol !== "udp")) continue;
    const port = Number(item.port);
    const name = boundedText(item.name, 100);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535 || !name) continue;
    const product = boundedText(item.product, 160);
    const version = boundedText(item.version, 100);
    const extraInfo = boundedText(item.extra_info, 160);
    const tunnel = boundedText(item.tunnel, 32);
    byKey.set(`${item.protocol}:${port}`, {
      protocol: item.protocol,
      port,
      name,
      ...(product ? { product } : {}),
      ...(version ? { version } : {}),
      ...(extraInfo ? { extra_info: extraInfo } : {}),
      ...(tunnel ? { tunnel } : {}),
    });
  }
  return [...byKey.values()];
}

function normalizePlatform(value: unknown): string | null {
  const text = boundedText(value, 200);
  return text ? inferPlatform(text) ?? text : null;
}

export function normalizeVendor(value: unknown): string | null {
  const text = boundedText(value, 200);
  if (!text || /^(?:-|unknown|unknown vendor|n\/a|none|null|0x[0-9a-f]*)$/i.test(text) || !/[a-z]/i.test(text)) return null;
  if (/^raspberry\s*pi\s*f$/i.test(text) || /^raspberrypif$/i.test(text)) return "Raspberry Pi Foundation";
  return text;
}

function inferPlatform(value: unknown): string | null {
  const text = boundedText(value, 2_000)?.toLowerCase();
  if (!text) return null;
  if (/routeros|junos|cisco ios|ios-xe|ruijie|reyee/.test(text)) return "Network OS";
  if (/windows|microsoft/.test(text)) return "Windows";
  if (/linux|ubuntu|debian|centos|red hat|unix/.test(text)) return "Linux / Unix";
  if (/macos|mac os|darwin/.test(text)) return "macOS / Apple";
  if (/android/.test(text)) return "Android";
  return null;
}

function setStatus(draft: Draft, status: AssetObservation["status"], priority: number): void {
  if (priority >= draft.statusPriority) {
    draft.status = status;
    draft.statusPriority = priority;
  }
}

function addOptionalEvidence(draft: Draft, source: string, label: string, value: unknown): void {
  const text = boundedText(value, 256);
  if (text) addEvidence(draft, source, label, text);
}

function addEvidence(draft: Draft, source: string, label: string, value: string): void {
  if (draft.evidence.length >= ASSET_EVIDENCE_LIMIT) return;
  const normalized = { source: source.slice(0, 64), label: label.slice(0, 100), value: value.slice(0, 256) };
  if (!draft.evidence.some((item) => item.source === normalized.source && item.label === normalized.label && item.value === normalized.value)) {
    draft.evidence.push(normalized);
  }
}

function relation(value: unknown): Record<string, unknown> | null {
  if (record(value)) return value;
  return Array.isArray(value) && record(value[0]) ? value[0] : null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uuid(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

function privateIpv4(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parts = value.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return null;
  const [a = -1, b = -1] = parts.map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ? value : null;
}

function boundedText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= maximum && !/[\u0000-\u001f\u007f]/.test(text) ? text : null;
}

function boundedIdentifier(value: unknown): string | null {
  const text = boundedText(value, 64);
  return text && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(text) ? text.toLowerCase() : null;
}

function normalizeConfidence(value: unknown): AssetConfidence {
  return value === "high" || value === "medium" || value === "low" ? value : null;
}

function normalizeMacKind(value: unknown): Draft["macKind"] {
  return value === "global" || value === "locally_administered" ? value : "unavailable";
}

function normalizeMac(value: unknown): string | null {
  return typeof value === "string" && /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(value) && value.toLowerCase() !== "00:00:00:00:00:00"
    ? value.toLowerCase() : null;
}

function macKindFromAddress(value: unknown): Draft["macKind"] {
  const mac = normalizeMac(value);
  if (!mac) return "unavailable";
  return (Number.parseInt(mac.slice(0, 2), 16) & 2) !== 0 ? "locally_administered" : "global";
}

function boundedNumber(value: unknown, minimum: number, maximum: number): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
}

function timestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function latestTimestamp(...values: (string | null)[]): string | null {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
}

function earliestTimestamp(...values: (string | null)[]): string | null {
  return values.filter((value): value is string => Boolean(value)).sort()[0] ?? null;
}
