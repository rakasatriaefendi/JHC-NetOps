import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { normalizeVendor, type AssetObservation } from "../src/assets/evidence.js";
import { parseNmapXml } from "../src/assets/nmap-parser.js";
import { normalizeScannedHost, mergeActiveScanObservation } from "../src/assets/scan-normalize.js";
import { AssetScanController, AssetScanError } from "../src/assets/scan-controller.js";
import { ScanExecutionError, type NmapExecutionMode, type NmapExecutor } from "../src/assets/scan-executor.js";
import type { AssetScanRepository } from "../src/assets/scan-repository.js";
import { normalizePrivateCidr, validateAssetScanRequest, type AssetScanMode, type AssetScanRecord } from "../src/assets/scan-contract.js";
import { buildServer } from "../src/server.js";

const TOKEN = "a".repeat(32);
const NETWORK = "192.168.1.0/24";
const STARTED = "2026-09-09T00:00:00.000Z";

test("scan contract accepts only canonical bounded RFC1918 networks and allowlisted requests", () => {
  for (const value of ["192.168.1.0/24", "10.20.0.0/22", "172.16.4.0/23"]) assert.equal(normalizePrivateCidr(value), value);
  for (const value of ["8.8.8.0/24", "127.0.0.0/24", "169.254.1.0/24", "224.0.0.0/24", "0.0.0.0/0", "192.168.1.1/24", "192.168.0.0/21", "192.168.1.0/33"]) assert.equal(normalizePrivateCidr(value), null);
  assert.deepEqual(validateAssetScanRequest({ mode: "deep", network: NETWORK }, [NETWORK]), { ok: true, value: { mode: "deep", network: NETWORK } });
  assert.equal(validateAssetScanRequest({ mode: "deep", network: "10.0.0.0/24" }, [NETWORK]).ok, false);
  assert.equal(validateAssetScanRequest({ mode: "deep", network: NETWORK, flags: "--script all" }, [NETWORK]).ok, false);
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
  await assert.rejects(() => controller.start("quick", NETWORK), (error: unknown) => error instanceof AssetScanError && error.code === "SCANNER_UNAVAILABLE");
  assert.equal(availabilityChecks, 0);
});

test("quick XML parses multiple hosts with bounded IP, MAC, vendor, hostname and latency evidence", () => {
  const hosts = parseNmapXml(nmapRun(`
    ${host("192.168.1.10", '<address addr="00:11:22:33:44:55" addrtype="mac" vendor="RaspberryPiF"/><hostnames><hostname name="lab-pi"/></hostnames><times srtt="1250"/>')}
    ${host("192.168.1.11", "")}
    <host><status state="down"/><address addr="192.168.1.12" addrtype="ipv4"/></host>
    <host><status state="up"/><address addr="8.8.8.8" addrtype="ipv4"/></host>`));
  assert.equal(hosts.length, 2);
  assert.deepEqual(hosts[0], {
    ip_address: "192.168.1.10", mac_address: "00:11:22:33:44:55", vendor: "RaspberryPiF", hostname: "lab-pi",
    latency_ms: 1.25, services: [], os_matches: [],
  });
  assert.equal(hosts[1]?.mac_address, null);
});

test("deep XML normalizes Windows, Linux, macOS, network, NAS, printer and unknown evidence conservatively", () => {
  const windows = normalized("192.168.1.20", ports([
    service(135, "msrpc", "Microsoft Windows RPC"), service(139, "netbios-ssn", "Microsoft Windows"), service(445, "microsoft-ds", "Windows SMB"),
  ]) + os("Microsoft Windows 11", 96, "general purpose", "Windows"));
  assert.equal(windows.platform, "Windows"); assert.equal(windows.os_confidence, "high"); assert.equal(windows.device_type, "windows_pc_server");

  const linux = normalized("192.168.1.21", ports([service(22, "ssh", "OpenSSH", "9.6p1")]) + os("Linux 5.15", 92, "general purpose", "Linux"));
  assert.equal(linux.platform, "Linux / Unix"); assert.equal(linux.detected_services[0]?.product, "OpenSSH"); assert.equal(linux.detected_services[0]?.version, "9.6p1");

  const apple = normalized("192.168.1.22", os("Apple macOS", 91, "general purpose", "Mac OS X"), "00:11:22:33:44:56", "Apple, Inc.");
  assert.equal(apple.platform, "macOS / Apple");

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
  assert.equal(normalizeVendor("---"), null);
  assert.equal(normalizeVendor("RaspberryPiF"), "Raspberry Pi Foundation");
  assert.equal(normalizeVendor("Shenzhen Example Technology Company Limited"), "Shenzhen Example Technology Company Limited");
});

test("active evidence enriches by existing identity without wiping stronger/operator evidence", () => {
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
  assert.deepEqual(merged.open_ports, [22, 443]);
  assert.equal(merged.detected_services.length, 2);
  assert.deepEqual(mergeActiveScanObservation(merged, scanned), merged);
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
  assert.doesNotMatch(helper, /\beval\b|sh -c|bash -c/);
  assert.match(executor, /process\.kill\(-child\.pid, signal\)/);
  assert.match(executor, /SIGTERM/); assert.match(executor, /SIGKILL/);
  assert.match(provision, /root -g root/); assert.match(provision, /visudo -cf/); assert.doesNotMatch(provision, /pm2|systemctl/);
});

class FakeScanRepository implements AssetScanRepository {
  recovered = false;
  ingested: AssetObservation[] = [];
  lastRecord: AssetScanRecord | null = null;
  async recoverInterrupted(): Promise<void> { this.recovered = true; }
  async create(mode: AssetScanMode, network: string, startedAt: string): Promise<AssetScanRecord> {
    this.lastRecord = { ...scanRecord("running"), mode, network, started_at: startedAt };
    return this.lastRecord;
  }
  async update(record: AssetScanRecord): Promise<void> { this.lastRecord = record; }
  async last(): Promise<AssetScanRecord | null> { return this.lastRecord?.status === "running" ? null : this.lastRecord; }
  async ingest(observations: readonly AssetObservation[], signal: AbortSignal): Promise<number> {
    signal.throwIfAborted(); this.ingested.push(...observations); return observations.length;
  }
}

class FixtureExecutor implements NmapExecutor {
  constructor(private readonly fixtures: Readonly<Record<string, string | Error>>) {}
  async available(): Promise<boolean> { return true; }
  async run(mode: NmapExecutionMode, target: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
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
  const discovery = parseNmapXml(nmapRun(host(ip, `<address addr="${mac}" addrtype="mac" vendor="${vendor}"/>`)))[0];
  const fingerprint = parseNmapXml(nmapRun(host(ip, inner)))[0];
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
