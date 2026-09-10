import { ASSET_SCAN_MAX_HOSTS, isUsableScanHost, normalizePrivateCidr, normalizePrivateIpv4 } from "./scan-contract.js";

export const NMAP_XML_MAX_BYTES = 2 * 1024 * 1024;
export const NMAP_PORT_LIMIT = 32;

export type NmapService = Readonly<{
  protocol: "tcp" | "udp";
  port: number;
  name: string;
  product: string | null;
  version: string | null;
  extra_info: string | null;
  tunnel: string | null;
  os_type: string | null;
}>;

export type NmapOsEvidence = Readonly<{
  name: string;
  accuracy: number;
  device_types: readonly string[];
  os_families: readonly string[];
}>;

export type NmapHost = Readonly<{
  ip_address: string;
  mac_address: string | null;
  vendor: string | null;
  hostname: string | null;
  latency_ms: number | null;
  services: readonly NmapService[];
  os_matches: readonly NmapOsEvidence[];
}>;

export function parseNmapXml(xml: string, requestedNetwork: string): NmapHost[] {
  const network = normalizePrivateCidr(requestedNetwork);
  if (!network || !xml || Buffer.byteLength(xml, "utf8") > NMAP_XML_MAX_BYTES || !/<nmaprun\b/.test(xml) || !/<\/nmaprun>\s*$/.test(xml)) {
    throw new Error("NMAP_OUTPUT_INVALID");
  }
  const hosts = new Map<string, NmapHost>();
  for (const match of xml.matchAll(/<host\b[^>]*>([\s\S]*?)<\/host>/g)) {
    const body = match[1] ?? "";
    if (!/<status\b[^>]*\bstate="up"/.test(body)) continue;
    const addressTags = [...body.matchAll(/<address\b([^>]*)\/?\s*>/g)].map((item) => attributes(item[1] ?? ""));
    const ip = normalizePrivateIpv4(addressTags.find((item) => item.addrtype === "ipv4")?.addr);
    if (!ip || !isUsableScanHost(ip, network)) continue;
    const macTag = addressTags.find((item) => item.addrtype === "mac");
    const hostnameTag = /<hostname\b([^>]*)\/?\s*>/.exec(body);
    const timesTag = /<times\b([^>]*)\/?\s*>/.exec(body);
    const services = parseServices(body);
    const osMatches = parseOsMatches(body);
    hosts.set(ip, {
      ip_address: ip,
      mac_address: normalizeMac(macTag?.addr),
      vendor: bounded(macTag?.vendor, 200),
      hostname: bounded(hostnameTag ? attributes(hostnameTag[1] ?? "").name : null, 255),
      latency_ms: latency(timesTag ? attributes(timesTag[1] ?? "").srtt : null),
      services,
      os_matches: osMatches,
    });
    if (hosts.size >= ASSET_SCAN_MAX_HOSTS) break;
  }
  return [...hosts.values()];
}

function parseServices(body: string): NmapService[] {
  const result = new Map<string, NmapService>();
  for (const match of body.matchAll(/<port\b([^>]*)>([\s\S]*?)<\/port>/g)) {
    const portAttributes = attributes(match[1] ?? "");
    const content = match[2] ?? "";
    const protocol = portAttributes.protocol;
    const port = Number(portAttributes.portid);
    if ((protocol !== "tcp" && protocol !== "udp") || !Number.isSafeInteger(port) || port < 1 || port > 65_535 ||
        !/<state\b[^>]*\bstate="open"/.test(content)) continue;
    const serviceMatch = /<service\b([^>]*)\/?\s*>/.exec(content);
    const service = serviceMatch ? attributes(serviceMatch[1] ?? "") : {};
    result.set(`${protocol}:${port}`, {
      protocol,
      port,
      name: bounded(service.name, 100) ?? "unknown",
      product: bounded(service.product, 160),
      version: bounded(service.version, 100),
      extra_info: bounded(service.extrainfo, 160),
      tunnel: bounded(service.tunnel, 32),
      os_type: bounded(service.ostype, 100),
    });
    if (result.size >= NMAP_PORT_LIMIT) break;
  }
  return [...result.values()].sort((left, right) => left.port - right.port || left.protocol.localeCompare(right.protocol));
}

function parseOsMatches(body: string): NmapOsEvidence[] {
  const result: NmapOsEvidence[] = [];
  for (const match of body.matchAll(/<osmatch\b([^>]*)>([\s\S]*?)<\/osmatch>|<osmatch\b([^>]*)\/>/g)) {
    const matchAttributes = attributes(match[1] ?? match[3] ?? "");
    const name = bounded(matchAttributes.name, 300);
    const accuracy = Number(matchAttributes.accuracy);
    if (!name || !Number.isSafeInteger(accuracy) || accuracy < 0 || accuracy > 100) continue;
    const classBody = match[2] ?? "";
    const classes = [...classBody.matchAll(/<osclass\b([^>]*)\/?\s*>/g)].map((item) => attributes(item[1] ?? ""));
    result.push({
      name,
      accuracy,
      device_types: unique(classes.map((item) => bounded(item.type, 100)).filter(isString)),
      os_families: unique(classes.map((item) => bounded(item.osfamily, 100)).filter(isString)),
    });
    if (result.length >= 8) break;
  }
  return result.sort((left, right) => right.accuracy - left.accuracy);
}

function attributes(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of value.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*(["'])(.*?)\2/g)) {
    const key = match[1];
    if (key) result[key] = decodeXml(match[3] ?? "");
  }
  return result;
}

function decodeXml(value: string): string {
  return value.replace(/&(quot|apos|lt|gt|amp|#\d+|#x[0-9a-f]+);/gi, (entity, code: string) => {
    const named: Record<string, string> = { quot: '"', apos: "'", lt: "<", gt: ">", amp: "&" };
    if (named[code.toLowerCase()]) return named[code.toLowerCase()] ?? "";
    const numeric = code.startsWith("#x") ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
    return Number.isSafeInteger(numeric) && numeric > 0 && numeric <= 0x10ffff ? String.fromCodePoint(numeric) : "";
  });
}

function latency(value: string | null | undefined): number | null {
  const microseconds = Number(value);
  return Number.isFinite(microseconds) && microseconds >= 0 && microseconds <= 60_000_000
    ? Math.round(microseconds / 10) / 100
    : null;
}

function normalizeMac(value: string | undefined): string | null {
  return value && /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(value) && value !== "00:00:00:00:00:00"
    ? value.toLowerCase()
    : null;
}

function bounded(value: string | null | undefined, maximum: number): string | null {
  const text = value?.trim();
  return text && text.length <= maximum && !/[\u0000-\u001f\u007f]/.test(text) ? text : null;
}

function unique(values: string[]): string[] { return [...new Set(values)].slice(0, 8); }
function isString(value: string | null): value is string { return value !== null; }
