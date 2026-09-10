import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { normalizeVendor, type AssetObservation, classifyAsset } from "../src/assets/evidence.js";
import { parseNmapXml } from "../src/assets/nmap-parser.js";
import { normalizeScannedHost, mergeActiveScanObservation } from "../src/assets/scan-normalize.js";
import { AssetScanController, AssetScanError } from "../src/assets/scan-controller.js";
import { ScanExecutionError, type NmapExecutionMode, type NmapExecutor } from "../src/assets/scan-executor.js";
import type { AssetScanRepository } from "../src/assets/scan-repository.js";
import { isUsableScanHost, normalizePrivateCidr, validateAssetScanRequest, type AssetScanMode, type AssetScanRecord } from "../src/assets/scan-contract.js";
import { buildServer } from "../src/server.js";

const TOKEN = "a".repeat(32);
const NETWORK = "192.168.1.0/24";
const STARTED = "2026-09-09T00:00:00.000Z";

test("scan contract accepts only canonical bounded RFC1918 networks and allowlisted requests", () => {
  for (const value of ["192.168.1.0/24", "10.20.0.0/22", "172.16.4.0/23"]) assert.equal(normalizePrivateCidr(value), value);
  assert.equal(normalizePrivateCidr("192.168.1.17/24"), "192.168.1.0/24");
  for (const value of ["8.8.8.0/24", "127.0.0.0/24", "169.254.1.0/24", "224.0.0.0/24", "0.0.0.0/0", "192.168.0.0/21", "192.168.1.0/33"]) assert.equal(normalizePrivateCidr(value), null);
  assert.deepEqual(validateAssetScanRequest({ mode: "deep", network: NETWORK }, [NETWORK]), { ok: true, value: { mode: "deep", network: NETWORK } });
  assert.equal(validateAssetScanRequest({ mode: "deep", network: "10.0.0.0/24" }, [NETWORK]).ok, false);
  assert.equal(validateAssetScanRequest({ mode: "deep", network: NETWORK, flags: "--script all" }, [NETWORK]).ok, false);
});

test("usable scan hosts exclude network, broadcast and out-of-scope addresses while preserving /31 and /32", () => {
  assert.equal(isUsableScanHost("192.168.1.0", "192.168.1.0/24"), false);
  assert.equal(isUsableScanHost("192.168.1.255", "192.168.1.0/24"), false);
  assert.equal(isUsableScanHost("192.168.1.1", "192.168.1.0/24"), true);
  assert.equal(isUsableScanHost("192.168.1.254", "192.168.1.0/24"), true);
  assert.equal(isUsableScanHost("192.168.2.1", "192.168.1.0/24"), false);
  assert.equal(isUsableScanHost("192.168.1.0", "192.168.1.0/30"), false);
  assert.equal(isUsableScanHost("192.168.1.3", "192.168.1.0/30"), false);
  assert.equal(isUsableScanHost("192.168.1.0", "192.168.1.0/31"), true);
  assert.equal(isUsableScanHost("192.168.1.1", "192.168.1.0/31"), true);
  assert.equal(isUsableScanHost("192.168.1.9", "192.168.1.9/32"), true);
});

test("missing network configuration keeps the scanner unavailable without invoking an executor", async () => {
  const repository = new FakeScanRepository();
  let availabilityChecks = 0;
  const executor: NmapExecutor = {
    async available() { availabilityChecks += 1; return true; },
    async run() { throw new Error("must not run"); },
  };
  const controller = new AssetScanController(repository, executor, []);
  const state = await controller.state();
  assert.equal(state.available, false);
  assert.equal(availabilityChecks, 0);
  await assert.rejects(() => controller.start("quick", NETWORK), (error: unknown) => error instanceof AssetScanError && error.code === "SCAN_NETWORK_NOT_ALLOWED");
  assert.equal(availabilityChecks, 0);
});

test("quick XML parses multiple hosts with bounded IP, MAC, vendor, hostname and latency evidence", () => {
  const hosts = parseNmapXml(nmapRun(`
    ${host("192.168.1.10", '<address addr="00:11:22:33:44:55" addrtype="mac" vendor="RaspberryPiF"/><hostnames><hostname name="lab-pi"/></hostnames><times srtt="1250"/>')}
    ${host("192.168.1.11", "")}
    <host><status state="down"/><address addr="192.168.1.12" addrtype="ipv4"/></host>
    <host><status state="up"/><address addr="8.8.8.8" addrtype="ipv4"/></host>`), NETWORK);
  assert.equal(hosts.length, 2);
  assert.deepEqual(hosts[0], {
    ip_address: "192.168.1.10", mac_address: "00:11:22:33:44:55", vendor: "RaspberryPiF", hostname: "lab-pi",
    latency_ms: 1.25, services: [], os_matches: [],
  });
  assert.equal(hosts[1]?.mac_address, null);
});

test("quick parser filters network, broadcast and outside-CIDR results before host bounds", () => {
  const hosts = parseNmapXml(nmapRun([
    host("192.168.1.0", ""),
    host("192.168.1.1", ""),
    host("192.168.1.254", ""),
    host("192.168.1.255", ""),
    host("192.168.2.1", ""),
  ].join("")), NETWORK);
  assert.deepEqual(hosts.map((item) => item.ip_address), ["192.168.1.1", "192.168.1.254"]);
});

test("deep XML normalizes Windows, Linux, macOS, network, NAS, printer and unknown evidence conservatively", () => {
  const windows = normalized("192.168.1.20", ports([
    service(135, "msrpc", "Microsoft Windows RPC"), service(139, "netbios-ssn", "Microsoft Windows"), service(445, "microsoft-ds", "Windows SMB"),
  ]) + os("Microsoft Windows 11", 96, "general purpose", "Windows"));
  assert.equal(windows.platform, "Windows"); assert.equal(windows.os_confidence, "high"); assert.equal(windows.device_type, "unknown");

  const linux = normalized("192.168.1.21", ports([service(22, "ssh", "OpenSSH", "9.6p1")]) + os("Linux 5.15", 92, "general purpose", "Linux"));
  assert.equal(linux.platform, "Linux / Unix"); assert.equal(linux.detected_services[0]?.product, "OpenSSH"); assert.equal(linux.detected_services[0]?.version, "9.6p1"); assert.equal(linux.device_type, "unknown");

  const apple = normalized("192.168.1.22", os("Apple macOS", 91, "general purpose", "Mac OS X"), "00:11:22:33:44:56", "Apple, Inc.");
  assert.equal(apple.platform, "macOS / Apple"); assert.equal(apple.device_type, "unknown");

  const router = normalized("192.168.1.23", ports([service(443, "https", "Router management")]) + os("Network appliance", 90, "router", "embedded"));
  assert.equal(router.platform, "Network Appliance"); assert.equal(router.device_type, "router_firewall");

  const nas = normalized("192.168.1.24", ports([service(5000, "http", "Synology NAS")]), "00:11:22:33:44:57", "Synology Incorporated");
  assert.equal(nas.device_type, "nas_storage_server");

  const printer = normalized("192.168.1.25", ports([service(631, "ipp", "HP printer")]));
  assert.equal(printer.device_type, "printer");
  const nmapPrinter = normalized("192.168.1.28", os("Embedded device", 88, "printer", "embedded"));
  assert.equal(nmapPrinter.device_type, "printer");
  const portOnly = normalized("192.168.1.26", ports([service(631, "ipp", null)]));
  assert.notEqual(portOnly.device_type, "printer");
  const unknown = normalized("192.168.1.27", "");
  assert.equal(unknown.platform, null); assert.equal(unknown.device_type, "unknown"); assert.equal(unknown.classification_confidence, "low");
});

test("vendor normalization rejects garbage, repairs known truncation and preserves useful names", () => {
  assert.equal(normalizeVendor("0x"), null);
  assert.equal(normalizeVendor("0x1234"), null);
  assert.equal(normalizeVendor("---"), null);
  assert.equal(normalizeVendor("RaspberryPiF"), "Raspberry Pi Foundation");
  assert.equal(normalizeVendor("Shenzhen Example Technology Company Limited"), "Shenzhen Example Technology Company Limited");
});

test("successful Deep evidence replaces measured services without wiping stronger operator identity", () => {
  const scanned = normalized("192.168.1.40", ports([service(22, "ssh", "OpenSSH", "9.6")]) + os("Linux", 80, "general purpose", "Linux"), "00:11:22:33:44:58", "Useful Vendor");
  const existing: AssetObservation = {
    ...scanned, stable_source_key: "node:11111111-1111-4111-8111-111111111111", name: "Operator Name", hostname: null,
    device_type: "medical_device", status: "offline", vendor: "Existing Vendor", platform: "Windows", source: "manual",
    classification_confidence: "high", os_confidence: "high", first_seen_at: "2026-01-01T00:00:00.000Z",
    last_seen_at: "2026-09-01T00:00:00.000Z", evidence_updated_at: "2026-09-01T00:00:00.000Z",
    open_ports: [443], detected_services: [{ protocol: "tcp", port: 443, name: "https" }],
    network_node_ref: "11111111-1111-4111-8111-111111111111", health_target_ref: "22222222-2222-4222-8222-222222222222",
  };
  const merged = mergeActiveScanObservation(existing, scanned);
  assert.equal(merged.stable_source_key, existing.stable_source_key);
  assert.equal(merged.device_type, "medical_device");
  assert.equal(merged.status, "offline");
  assert.equal(merged.platform, "Windows");
  assert.equal(merged.first_seen_at, existing.first_seen_at);
  assert.deepEqual(merged.open_ports, [22]);
  assert.deepEqual(merged.detected_services.map((service) => service.port), [22]);
  assert.deepEqual(mergeActiveScanObservation(merged, scanned), merged);
});

test("Quick and failed Deep observations preserve prior Deep-only enrichment", () => {
  const priorDeep = normalized("192.168.1.41", ports([service(22, "ssh", "OpenSSH"), service(443, "https", "nginx")]) + os("Linux", 95, "general purpose", "Linux"));
  const discovery = parseNmapXml(nmapRun(host("192.168.1.41", '<address addr="00:11:22:33:44:55" addrtype="mac" vendor="Example Vendor"/>')), NETWORK)[0];
  assert.ok(discovery);
  const quickOrFailedDeep = normalizeScannedHost(discovery, null, "2026-09-10T00:00:00.000Z");

  for (const observation of [quickOrFailedDeep, { ...quickOrFailedDeep, last_seen_at: "2026-09-10T00:01:00.000Z" }]) {
    const merged = mergeActiveScanObservation(priorDeep, observation);
    assert.deepEqual(merged.open_ports, priorDeep.open_ports);
    assert.deepEqual(merged.detected_services, priorDeep.detected_services);
    assert.equal(merged.device_type, priorDeep.device_type);
  }
});

test("successful Deep can explicitly clear services and replace supported classification", () => {
  const existing = normalized("192.168.1.42", ports([service(22, "ssh", "OpenSSH"), service(443, "https", "nginx")]));
  const discovery = parseNmapXml(nmapRun(host("192.168.1.42", '<address addr="00:11:22:33:44:55" addrtype="mac" vendor="Ruijie"/>')), NETWORK)[0];
  const emptyFingerprint = parseNmapXml(nmapRun(host("192.168.1.42", os("Network switch", 95, "switch", "embedded"))), NETWORK)[0];
  assert.ok(discovery); assert.ok(emptyFingerprint);
  const measuredEmpty = normalizeScannedHost(discovery, emptyFingerprint, "2026-09-10T00:00:00.000Z");
  const merged = mergeActiveScanObservation({ ...existing, device_type: "network_device", classification_confidence: "medium" }, measuredEmpty);
  assert.deepEqual(merged.open_ports, []);
  assert.deepEqual(merged.detected_services, []);
  assert.equal(merged.device_type, "switch_network");
});

test("active scan still updates IP and MAC identity evidence", () => {
  const existing = normalized("192.168.1.42", ports([service(22, "ssh", "OpenSSH")]), "00:11:22:33:44:55");
  const scanned = normalized("192.168.1.43", ports([service(22, "ssh", "OpenSSH")]), "00:11:22:33:44:66");
  const merged = mergeActiveScanObservation(existing, scanned);
  assert.equal(merged.ip_address, "192.168.1.43");
  assert.equal(merged.mac_address, "00:11:22:33:44:66");
});

test("controller supports one bounded scan, partial host failure, cancellation and restart recovery", async () => {
  const repository = new FakeScanRepository();
  const executor = new FixtureExecutor({
    [`discovery:${NETWORK}`]: nmapRun(host("192.168.1.50", "") + host("192.168.1.51", "")),
    "fingerprint:192.168.1.50": nmapRun(host("192.168.1.50", ports([service(22, "ssh", "OpenSSH")]))),
    "fingerprint:192.168.1.51": new ScanExecutionError("NMAP_FAILED"),
  });
  const controller = new AssetScanController(repository, executor, [NETWORK], 2, 5_000, 5_000, () => new Date(STARTED));
  await controller.initialize();
  const started = await controller.start("deep", NETWORK);
  await waitForIdle(controller);
  assert.equal(repository.recovered, true);
  assert.equal(repository.lastRecord?.status, "completed");
  assert.equal(repository.lastRecord?.fingerprinted_count, 1);
  assert.equal(repository.lastRecord?.failed_count, 1);
  assert.equal(repository.ingested.length, 2);
  assert.deepEqual(repository.ingestScanRunIds, [started.id]);
  assert.equal(started.id, repository.lastRecord?.id);

  const blocking = new BlockingExecutor();
  const cancelRepository = new FakeScanRepository();
  const cancelController = new AssetScanController(cancelRepository, blocking, [NETWORK], 1, 5_000, 5_000, () => new Date(STARTED));
  const active = await cancelController.start("quick", NETWORK);
  await assert.rejects(() => cancelController.start("deep", NETWORK), (error: unknown) => error instanceof AssetScanError && error.code === "SCAN_ALREADY_RUNNING");
  const cancelled = await cancelController.cancel(active.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(blocking.cancelled, true);
  await cancelController.start("quick", NETWORK);
  await cancelController.shutdown();
  assert.equal(cancelRepository.lastRecord?.status, "cancelled");
});

test("invalid discovery hosts never become Deep fingerprint candidates", async () => {
  const repository = new FakeScanRepository();
  const executor = new FixtureExecutor({
    [`discovery:${NETWORK}`]: nmapRun(host("192.168.1.0", "") + host("192.168.1.1", "") + host("192.168.1.255", "")),
    "fingerprint:192.168.1.1": nmapRun(host("192.168.1.1", ports([service(22, "ssh", "OpenSSH")]))),
  });
  const controller = new AssetScanController(repository, executor, [NETWORK], 2, 5_000, 5_000, () => new Date(STARTED));
  await controller.start("deep", NETWORK);
  await waitForIdle(controller);
  assert.deepEqual(executor.calls, [`discovery:${NETWORK}`, "fingerprint:192.168.1.1"]);
  assert.equal(repository.lastRecord?.discovered_count, 1);
  assert.deepEqual(repository.ingested.map((item) => item.ip_address), ["192.168.1.1"]);
});

test("broadcast discovery cannot replace a valid asset IP through MAC reconciliation", async () => {
  const repository = new MacReconcilingFakeScanRepository("192.168.1.250", "04:eb:40:ed:a6:0e");
  const broadcastMac = '<address addr="04:EB:40:ED:A6:0E" addrtype="mac"/>';
  const executor = new FixtureExecutor({
    [`discovery:${NETWORK}`]: nmapRun(host("192.168.1.0", broadcastMac) + host("192.168.1.255", broadcastMac)),
  });
  const controller = new AssetScanController(repository, executor, [NETWORK], 1, 5_000, 5_000, () => new Date(STARTED));
  await controller.start("quick", NETWORK);
  await waitForIdle(controller);
  assert.equal(repository.lastRecord?.discovered_count, 0);
  assert.equal(repository.existingIp, "192.168.1.250");
  assert.deepEqual(repository.ingested, []);
});

test("malformed Nmap output fails safely without ingesting raw output", async () => {
  const repository = new FakeScanRepository();
  const controller = new AssetScanController(repository, new FixtureExecutor({ [`discovery:${NETWORK}`]: "not xml" }), [NETWORK], 1, 5_000, 5_000, () => new Date(STARTED));
  await controller.start("quick", NETWORK);
  await waitForIdle(controller);
  assert.equal(repository.lastRecord?.status, "failed");
  assert.equal(repository.lastRecord?.error_code, "NMAP_OUTPUT_INVALID");
  assert.equal(repository.ingested.length, 0);
});

test("one fingerprint timeout becomes a bounded partial result instead of stalling the scan", async () => {
  const repository = new FakeScanRepository();
  const controller = new AssetScanController(repository, new TimeoutFingerprintExecutor(), [NETWORK], 1, 10, 5_000, () => new Date(STARTED));
  await controller.start("deep", NETWORK);
  await waitForIdle(controller);
  assert.equal(repository.lastRecord?.status, "completed");
  assert.equal(repository.lastRecord?.failed_count, 1);
  assert.equal(repository.lastRecord?.fingerprinted_count, 0);
  assert.equal(repository.ingested.length, 1);
});

test("scan routes authenticate, validate, expose state, conflict and cancel without raw errors", async () => {
  let starts = 0;
  const record = scanRecord("running");
  const controller = {
    networks: [NETWORK],
    async state() { return { available: true, networks: [NETWORK], current: null, last: null }; },
    async start() { starts += 1; if (starts > 1) throw new AssetScanError("SCAN_ALREADY_RUNNING"); return record; },
    async cancel() { return { ...record, status: "cancelled" as const, cancelled_at: STARTED }; },
  };
  const server = buildServer({ logger: false, assetScan: { token: TOKEN, controller } });
  assert.equal((await server.inject({ method: "GET", url: "/api/assets/scan" })).statusCode, 401);
  assert.equal((await server.inject({ method: "POST", url: "/api/assets/scan", headers: auth(), payload: { mode: "deep", network: "8.8.8.0/24" } })).statusCode, 400);
  assert.equal((await server.inject({ method: "POST", url: "/api/assets/scan", headers: auth(), payload: { mode: "deep", network: NETWORK } })).statusCode, 202);
  assert.equal((await server.inject({ method: "POST", url: "/api/assets/scan", headers: auth(), payload: { mode: "deep", network: NETWORK } })).statusCode, 409);
  assert.equal((await server.inject({ method: "DELETE", url: `/api/assets/scan/${record.id}`, headers: auth() })).statusCode, 200);
  await server.close();
});

test("migration and privileged helper remain bounded, fixed-argument and isolated", () => {
  const migration = readFileSync(new URL("../migrations/003_active_inventory_scan.sql", import.meta.url), "utf8");
  const executor = readFileSync(new URL("../src/assets/scan-executor.ts", import.meta.url), "utf8");
  const helper = readFileSync(new URL("../../deploy/jhc-netops-asset-scan", import.meta.url), "utf8");
  const provision = readFileSync(new URL("../../deploy/provision-asset-scanner.sh", import.meta.url), "utf8");
  assert.match(migration, /asset\.scan_runs/); assert.match(migration, /active_scan/); assert.match(migration, /WHERE status = 'running'/);
  assert.doesNotMatch(migration, /DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE|REFERENCES\s+(?:public|auth)\./i);
  assert.match(helper, /-sn -PR --send-ip -T4 -oX -/); assert.match(helper, /-Pn -O -sV --version-light --osscan-guess --open -oX -/);
  assert.match(helper, /discovery-routed/); assert.match(helper, /-PE -PS22,80,443 -PA80,443/);
  assert.doesNotMatch(helper, /\beval\b|sh -c|bash -c/);
  assert.match(executor, /process\.kill\(-child\.pid, signal\)/);
  assert.match(executor, /SIGTERM/); assert.match(executor, /SIGKILL/);
  assert.match(provision, /root -g root/); assert.match(provision, /visudo -cf/); assert.doesNotMatch(provision, /pm2|systemctl/);
});

class FakeScanRepository implements AssetScanRepository {
  recovered = false;
  ingested: AssetObservation[] = [];
  ingestScanRunIds: string[] = [];
  lastRecord: AssetScanRecord | null = null;
  async recoverInterrupted(): Promise<void> { this.recovered = true; }
  async create(mode: AssetScanMode, network: string, startedAt: string): Promise<AssetScanRecord> {
    this.lastRecord = { ...scanRecord("running"), mode, network, started_at: startedAt };
    return this.lastRecord;
  }
  async update(record: AssetScanRecord): Promise<void> { this.lastRecord = record; }
  async last(): Promise<AssetScanRecord | null> { return this.lastRecord?.status === "running" ? null : this.lastRecord; }
  async ingest(observations: readonly AssetObservation[], scanRunId: string, signal: AbortSignal): Promise<number> {
    signal.throwIfAborted(); this.ingested.push(...observations); this.ingestScanRunIds.push(scanRunId); return observations.length;
  }
}

class MacReconcilingFakeScanRepository extends FakeScanRepository {
  constructor(public existingIp: string, private readonly existingMac: string) { super(); }
  override async ingest(observations: readonly AssetObservation[], scanRunId: string, signal: AbortSignal): Promise<number> {
    const matched = observations.find((observation) => observation.mac_address === this.existingMac);
    if (matched?.ip_address) this.existingIp = matched.ip_address;
    return super.ingest(observations, scanRunId, signal);
  }
}

class FixtureExecutor implements NmapExecutor {
  calls: string[] = [];
  constructor(private readonly fixtures: Readonly<Record<string, string | Error>>) {}
  async available(): Promise<boolean> { return true; }
  async run(mode: NmapExecutionMode, target: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    this.calls.push(`${mode}:${target}`);
    const value = this.fixtures[`${mode}:${target}`];
    if (value instanceof Error) throw value;
    if (typeof value !== "string") throw new ScanExecutionError("NMAP_FAILED");
    return value;
  }
}

class BlockingExecutor implements NmapExecutor {
  cancelled = false;
  async available(): Promise<boolean> { return true; }
  run(mode: NmapExecutionMode, target: string, signal: AbortSignal): Promise<string> {
    void mode;
    void target;
    return new Promise((resolve, reject) => {
      void resolve;
      signal.addEventListener("abort", () => {
      this.cancelled = true; reject(new ScanExecutionError("NMAP_CANCELLED"));
      }, { once: true });
    });
  }
}

class TimeoutFingerprintExecutor implements NmapExecutor {
  async available(): Promise<boolean> { return true; }
  run(mode: NmapExecutionMode, target: string, signal: AbortSignal): Promise<string> {
    if (mode === "discovery") return Promise.resolve(nmapRun(host("192.168.1.60", "")));
    void target;
    return new Promise((resolve, reject) => {
      void resolve;
      signal.addEventListener("abort", () => reject(new ScanExecutionError("NMAP_CANCELLED")), { once: true });
    });
  }
}

function normalized(ip: string, inner: string, mac = "00:11:22:33:44:55", vendor = "Example Vendor") {
  const discovery = parseNmapXml(nmapRun(host(ip, `<address addr="${mac}" addrtype="mac" vendor="${vendor}"/>`)), NETWORK)[0];
  const fingerprint = parseNmapXml(nmapRun(host(ip, inner)), NETWORK)[0];
  assert.ok(discovery); assert.ok(fingerprint);
  return normalizeScannedHost(discovery, fingerprint, STARTED);
}
function nmapRun(inner: string) { return `<?xml version="1.0"?><nmaprun>${inner}</nmaprun>`; }
function host(ip: string, inner: string) { return `<host><status state="up"/><address addr="${ip}" addrtype="ipv4"/>${inner}</host>`; }
function ports(items: string[]) { return `<ports>${items.join("")}</ports>`; }
function service(port: number, name: string, product: string | null, version?: string) { return `<port protocol="tcp" portid="${port}"><state state="open"/><service name="${name}"${product ? ` product="${product}"` : ""}${version ? ` version="${version}"` : ""}/></port>`; }
function os(name: string, accuracy: number, type: string, family: string) { return `<os><osmatch name="${name}" accuracy="${accuracy}"><osclass type="${type}" osfamily="${family}"/></osmatch></os>`; }
function scanRecord(status: AssetScanRecord["status"]): AssetScanRecord { return { id: "11111111-1111-4111-8111-111111111111", mode: "deep", network: NETWORK, status, discovered_count: 0, fingerprinted_count: 0, failed_count: 0, current_target: null, started_at: STARTED, completed_at: null, cancelled_at: null, error_code: null }; }
function auth() { return { authorization: `Bearer ${TOKEN}` }; }
async function waitForIdle(controller: AssetScanController) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!(await controller.state()).current) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("scan did not become idle");
}

test("regression: existing known device type preserved when scan returns unknown", () => {
  const scanned = normalized("192.168.1.70", ports([service(22, "ssh", "OpenSSH")]), "00:11:22:33:44:70", "0x");
  const existing: AssetObservation = {
    ...scanned, stable_source_key: "node:existing", name: "Known Device", hostname: "known",
    device_type: "switch_network", vendor: "Cisco", platform: "Network OS", source: "manual",
    classification_confidence: "high", os_confidence: "high", first_seen_at: "2026-01-01T00:00:00.000Z",
    last_seen_at: "2026-09-01T00:00:00.000Z", evidence_updated_at: "2026-09-01T00:00:00.000Z",
    open_ports: [], detected_services: [], network_node_ref: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  };
  const merged = mergeActiveScanObservation(existing, scanned);
  assert.equal(merged.device_type, "switch_network");
  assert.equal(merged.vendor, "Cisco");
});

test("regression: operator classification wins over scan classification", () => {
  const scanned = normalized("192.168.1.71", ports([service(443, "https", "Web UI")]) + os("RouterOS", 95, "router", "embedded"), "00:11:22:33:44:71", "MikroTik");
  const existing: AssetObservation = {
    ...scanned, stable_source_key: "node:operator", name: "Operator Device", hostname: "op-device",
    device_type: "router_firewall", vendor: "MikroTik", platform: "Network OS", source: "manual",
    classification_confidence: "high", os_confidence: "high", first_seen_at: "2026-01-01T00:00:00.000Z",
    last_seen_at: "2026-09-01T00:00:00.000Z", evidence_updated_at: "2026-09-01T00:00:00.000Z",
    open_ports: [], detected_services: [], network_node_ref: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  };
  const merged = mergeActiveScanObservation(existing, scanned);
  assert.equal(merged.device_type, "router_firewall");
  assert.equal(merged.source, "manual");
});

test("regression: canonical scanner type output only - no windows_pc_server or linux_unix_server", () => {
  const windows = normalized("192.168.1.80", ports([
    service(135, "msrpc", "Microsoft Windows RPC"), service(139, "netbios-ssn", null), service(445, "microsoft-ds", null),
  ]) + os("Windows 10", 90, "general purpose", "Windows"));
  assert.equal(windows.device_type, "unknown");
  assert.notEqual(windows.device_type, "windows_pc_server");

  const linux = normalized("192.168.1.81", ports([service(22, "ssh", "OpenSSH")]) + os("Linux 6.1", 90, "general purpose", "Linux"));
  assert.equal(linux.device_type, "unknown");
  assert.notEqual(linux.device_type, "linux_unix_server");

  const apple = normalized("192.168.1.82", os("macOS 14", 90, "general purpose", "Mac OS X"), "00:11:22:33:44:82", "Apple");
  assert.equal(apple.device_type, "unknown");
  assert.notEqual(apple.device_type, "mac_apple_workstation");
});

test("regression: Windows/Linux OS evidence alone does not invent server/workstation", () => {
  const windowsOnlyOS = { nodeType: null, fingerprintType: null, vendor: null, hostname: "host", platform: "Windows", services: [], macKind: "global" as const, sourceConfidence: "medium" as const };
  assert.equal(classifyAsset(windowsOnlyOS).deviceType, "unknown");

  const linuxOnlyOS = { nodeType: null, fingerprintType: null, vendor: null, hostname: "host", platform: "Linux / Unix", services: [], macKind: "global" as const, sourceConfidence: "medium" as const };
  assert.equal(classifyAsset(linuxOnlyOS).deviceType, "unknown");

  const windowsPorts = { nodeType: null, fingerprintType: null, vendor: null, hostname: "host", platform: "Windows", services: [{ protocol: "tcp" as const, port: 445, name: "microsoft-ds" }], macKind: "global" as const, sourceConfidence: "medium" as const };
  assert.equal(classifyAsset(windowsPorts).deviceType, "unknown");

  const linuxSSH = { nodeType: null, fingerprintType: null, vendor: null, hostname: "host", platform: "Linux / Unix", services: [{ protocol: "tcp" as const, port: 22, name: "ssh" }], macKind: "global" as const, sourceConfidence: "medium" as const };
  assert.equal(classifyAsset(linuxSSH).deviceType, "unknown");
});

test("regression: generic Apple vendor or macOS evidence does not invent a workstation role", () => {
  const base = { nodeType: null, fingerprintType: null, hostname: "host", services: [], macKind: "global" as const, sourceConfidence: "medium" as const };
  assert.equal(classifyAsset({ ...base, vendor: "Apple, Inc.", platform: null }).deviceType, "unknown");
  assert.equal(classifyAsset({ ...base, vendor: null, platform: "macOS / Apple" }).deviceType, "unknown");
  assert.equal(classifyAsset({ ...base, vendor: null, hostname: "apple-device", platform: null }).deviceType, "unknown");
});

test("regression: stale scanner-generated noncanonical types self-heal to unknown", () => {
  const scanned = normalized("192.168.1.83", "", "00:11:22:33:44:83");
  for (const staleType of ["windows_pc_server", "linux_unix_server", "mac_apple_workstation"]) {
    const existing: AssetObservation = {
      ...scanned,
      stable_source_key: `active_scan:stale:${staleType}`,
      device_type: staleType,
      classification_confidence: "high",
    };
    const merged = mergeActiveScanObservation(existing, scanned);
    assert.equal(merged.device_type, "unknown");
    assert.equal(merged.classification_confidence, scanned.classification_confidence);
  }
});

test("regression: noncanonical scanned type cannot replace unknown while an operator-owned type is preserved", () => {
  const baseline = normalized("192.168.1.84", "", "00:11:22:33:44:84");
  const noncanonicalScan: AssetObservation = { ...baseline, device_type: "windows_pc_server", classification_confidence: "high" };
  assert.equal(mergeActiveScanObservation(baseline, noncanonicalScan).device_type, "unknown");

  const operatorOwned: AssetObservation = {
    ...baseline,
    stable_source_key: "manual:operator-category",
    source: "manual",
    device_type: "operator_specific_category",
    classification_confidence: "high",
  };
  assert.equal(mergeActiveScanObservation(operatorOwned, baseline).device_type, "operator_specific_category");
});

test("regression: existing invalid vendor 0x with no valid new vendor becomes null", () => {
  const scanned = normalized("192.168.1.90", "", "00:11:22:33:44:90", "0x");
  const existing: AssetObservation = {
    ...scanned, stable_source_key: "node:vendor0x", name: "Bad Vendor", hostname: "bad",
    device_type: "unknown", vendor: "0x", platform: null, source: "discovery",
    classification_confidence: "low", os_confidence: null, first_seen_at: "2026-01-01T00:00:00.000Z",
    last_seen_at: "2026-09-01T00:00:00.000Z", evidence_updated_at: "2026-09-01T00:00:00.000Z",
    open_ports: [], detected_services: [],
  };
  const merged = mergeActiveScanObservation(existing, scanned);
  assert.equal(merged.vendor, null);
});

test("regression: invalid 0x vendor replaced by valid new vendor", () => {
  const normalizedScan = normalized("192.168.1.91", ports([service(22, "ssh", "OpenSSH")]), "00:11:22:33:44:91", "RaspberryPiF");
  const scanned: AssetObservation = { ...normalizedScan, vendor: "RaspberryPiF" };
  const existing: AssetObservation = {
    ...scanned, stable_source_key: "node:vendor0x2", name: "Bad Vendor 2", hostname: "bad2",
    device_type: "unknown", vendor: "0x", platform: "Linux / Unix", source: "discovery",
    classification_confidence: "low", os_confidence: "medium", first_seen_at: "2026-01-01T00:00:00.000Z",
    last_seen_at: "2026-09-01T00:00:00.000Z", evidence_updated_at: "2026-09-01T00:00:00.000Z",
    open_ports: [], detected_services: [],
  };
  const merged = mergeActiveScanObservation(existing, scanned);
  assert.equal(merged.vendor, "Raspberry Pi Foundation");
});

test("regression: valid existing vendor preserved when new vendor missing", () => {
  const scanned = normalized("192.168.1.92", ports([service(22, "ssh", "OpenSSH")]), "00:11:22:33:44:92", "0x");
  const existing: AssetObservation = {
    ...scanned, stable_source_key: "node:vendorgood", name: "Good Vendor", hostname: "good",
    device_type: "computer_workstation", vendor: "Dell", platform: "Windows", source: "manual",
    classification_confidence: "high", os_confidence: "high", first_seen_at: "2026-01-01T00:00:00.000Z",
    last_seen_at: "2026-09-01T00:00:00.000Z", evidence_updated_at: "2026-09-01T00:00:00.000Z",
    open_ports: [], detected_services: [], network_node_ref: "cccccccc-cccc-cccc-cccc-cccccccccccc",
  };
  const merged = mergeActiveScanObservation(existing, scanned);
  assert.equal(merged.vendor, "Dell");
});

test("regression: valid existing vendor is normalized when scanned vendor is invalid", () => {
  const scanned = normalized("192.168.1.93", "", "00:11:22:33:44:93", "0x1234");
  const existing: AssetObservation = {
    ...scanned,
    stable_source_key: "active_scan:vendor-normalized",
    vendor: "RaspberryPiF",
  };
  assert.equal(mergeActiveScanObservation(existing, scanned).vendor, "Raspberry Pi Foundation");
});

test("regression: repeated Deep enrichment is idempotent", () => {
  const scanned = normalized("192.168.1.100", ports([service(22, "ssh", "OpenSSH"), service(80, "http", "nginx")]) + os("Linux 6.5", 95, "general purpose", "Linux"), "00:11:22:33:44:99", "CanonicalVendor");
  const mergedOnce = mergeActiveScanObservation(scanned, scanned);
  const mergedTwice = mergeActiveScanObservation(mergedOnce, scanned);
  assert.deepEqual(mergedOnce, mergedTwice);
});
