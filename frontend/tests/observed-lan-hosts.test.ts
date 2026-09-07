import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  filterObservedHosts,
  latestObservedAt,
  observedHostDisplayName,
  observedHostFilterCounts,
  observedHostMacLabel,
  sortObservedHosts,
  type ManagedObservedHostLatest,
} from "../lib/managed-telemetry.ts";

const baseHost: ManagedObservedHostLatest = {
  target_id: "target-1",
  node_id: null,
  ip_address: "192.168.1.20",
  mac_address: "00:11:22:33:44:55",
  netbios_name: null,
  observation_source: "ip_net_to_physical",
  enrichment_status: "not_attempted",
  first_seen_at: "2026-08-31T08:00:00Z",
  last_seen_at: "2026-08-31T08:05:00Z",
  status: "current",
  updated_at: "2026-08-31T08:05:00Z",
  network_nodes: null,
};

test("observed host naming falls back from inventory to NetBIOS to IP", () => {
  assert.equal(observedHostDisplayName({ ...baseHost, network_nodes: { name: "Core AP" }, netbios_name: "AP-NETBIOS" }), "Core AP");
  assert.equal(observedHostDisplayName({ ...baseHost, netbios_name: "DESKTOP-01" }), "DESKTOP-01");
  assert.equal(observedHostDisplayName(baseHost), "192.168.1.20");
});

test("observed host MAC formatting hides missing, malformed, and all-zero values", () => {
  assert.equal(observedHostMacLabel({ mac_address: "AA:BB:CC:DD:EE:FF" }), "AA:BB:CC:DD:EE:FF");
  assert.equal(observedHostMacLabel({ mac_address: null }), "-");
  assert.equal(observedHostMacLabel({ mac_address: "00:00:00:00:00:00" }), "-");
  assert.equal(observedHostMacLabel({ mac_address: "not-a-mac" }), "-");
});

test("Device sorting uses the displayed inventory, NetBIOS, and IP fallback names", () => {
  const inventory = { ...baseHost, ip_address: "192.168.1.100", network_nodes: { name: "alpha Switch" } };
  const netbios = { ...baseHost, ip_address: "192.168.1.20", netbios_name: "Bravo-PC" };
  const ipFallback = { ...baseHost, ip_address: "192.168.1.3" };
  const hosts = [netbios, ipFallback, inventory];

  assert.deepEqual(sortObservedHosts(hosts, "device", "asc"), [ipFallback, inventory, netbios]);
  assert.deepEqual(sortObservedHosts(hosts, "device", "desc"), [netbios, inventory, ipFallback]);
  assert.deepEqual(hosts, [netbios, ipFallback, inventory], "sorting must not mutate the loaded observations");
});

test("IP sorting compares IPv4 octets numerically in both directions", () => {
  const low = { ...baseHost, ip_address: "192.168.1.3" };
  const middle = { ...baseHost, ip_address: "192.168.1.20" };
  const high = { ...baseHost, ip_address: "192.168.1.100" };
  const hosts = [high, low, middle];

  assert.deepEqual(sortObservedHosts(hosts, "ip_address", "asc"), [low, middle, high]);
  assert.deepEqual(sortObservedHosts(hosts, "ip_address", "desc"), [high, middle, low]);
});

test("sorting applies to the collection produced by existing search and filters", () => {
  const zulu = { ...baseHost, ip_address: "192.168.1.100", netbios_name: "Zulu-PC" };
  const alpha = { ...baseHost, ip_address: "192.168.1.20", network_nodes: { name: "Alpha Printer" } };
  const stale = { ...baseHost, ip_address: "192.168.1.3", netbios_name: "Alpha Old", status: "stale" as const };
  const visible = filterObservedHosts([zulu, stale, alpha], "alpha", "fresh");

  assert.deepEqual(sortObservedHosts(visible, "device", "asc"), [alpha]);
});

test("observed host search is case-insensitive across inventory, NetBIOS, IP, and MAC", () => {
  const inventory = { ...baseHost, ip_address: "192.168.1.21", network_nodes: { name: "Finance Printer" } };
  const netbios = { ...baseHost, ip_address: "192.168.1.22", netbios_name: "DESKTOP-OPS" };
  const mac = { ...baseHost, ip_address: "192.168.1.23", mac_address: "DE:AD:BE:EF:00:01" };
  const hosts = [inventory, netbios, mac];
  assert.deepEqual(filterObservedHosts(hosts, "FINANCE", "all"), [inventory]);
  assert.deepEqual(filterObservedHosts(hosts, "desktop-ops", "all"), [netbios]);
  assert.deepEqual(filterObservedHosts(hosts, "192.168.1.23", "all"), [mac]);
  assert.deepEqual(filterObservedHosts(hosts, "de:ad", "all"), [mac]);
});

test("observed host filters distinguish named, unnamed, fresh, and stale observations", () => {
  const inventoryNamed = { ...baseHost, ip_address: "192.168.1.21", network_nodes: { name: "Known node" } };
  const netbiosNamed = { ...baseHost, ip_address: "192.168.1.22", netbios_name: "KNOWN-PC" };
  const unnamedStale = { ...baseHost, ip_address: "192.168.1.23", status: "stale" as const };
  const hosts = [inventoryNamed, netbiosNamed, unnamedStale];
  assert.deepEqual(filterObservedHosts(hosts, "", "all"), hosts);
  assert.deepEqual(filterObservedHosts(hosts, "", "named"), [inventoryNamed, netbiosNamed]);
  assert.deepEqual(filterObservedHosts(hosts, "", "unnamed"), [unnamedStale]);
  assert.deepEqual(filterObservedHosts(hosts, "", "fresh"), [inventoryNamed, netbiosNamed]);
  assert.deepEqual(filterObservedHosts(hosts, "", "stale"), [unnamedStale]);
});

test("observed host category counts describe the complete loaded dataset", () => {
  const hosts = [
    { ...baseHost, ip_address: "192.168.1.21", network_nodes: { name: "Known node" } },
    { ...baseHost, ip_address: "192.168.1.22", netbios_name: "KNOWN-PC" },
    { ...baseHost, ip_address: "192.168.1.23", status: "stale" as const },
    { ...baseHost, ip_address: "192.168.1.24", status: "stale" as const },
  ];
  assert.deepEqual(observedHostFilterCounts(hosts), {
    all: 4,
    named: 2,
    unnamed: 2,
    fresh: 2,
    stale: 2,
  });
  assert.deepEqual(observedHostFilterCounts([]), { all: 0, named: 0, unnamed: 0, fresh: 0, stale: 0 });
});

test("visible and total counts respond to filter/search and restore when cleared", () => {
  const hosts = [
    { ...baseHost, ip_address: "192.168.1.21", network_nodes: { name: "Finance Printer" } },
    { ...baseHost, ip_address: "192.168.1.22", netbios_name: "FINANCE-PC" },
    { ...baseHost, ip_address: "192.168.1.23", status: "stale" as const },
  ];
  assert.deepEqual([filterObservedHosts(hosts, "", "all").length, hosts.length], [3, 3]);
  assert.deepEqual([filterObservedHosts(hosts, "", "named").length, hosts.length], [2, 3]);
  assert.deepEqual([filterObservedHosts(hosts, "printer", "named").length, hosts.length], [1, 3]);
  assert.deepEqual([filterObservedHosts(hosts, "", "all").length, hosts.length], [3, 3]);
});

test("latest observation prefers valid host evidence and safely falls back to the poll", () => {
  const newer = { ...baseHost, ip_address: "192.168.1.21", last_seen_at: "2026-08-31T08:10:00Z" };
  assert.equal(latestObservedAt([baseHost, newer], "2026-08-31T08:20:00Z"), newer.last_seen_at);
  assert.equal(latestObservedAt([], "2026-08-31T08:20:00Z"), "2026-08-31T08:20:00Z");
});

test("SNMP detail uses only the compact observed-host summary and dedicated route link", () => {
  const detail = source("../components/snmp/managed-telemetry-detail.tsx");
  const deviceProfile = source("../components/device-profile/managed-telemetry-section.tsx");
  assert.match(detail, /ObservedLanHostsSummary/);
  assert.doesNotMatch(detail, /ObservedLanHostsWorkspace/);
  assert.match(deviceProfile, /ObservedLanHostsSummary/);
  assert.doesNotMatch(deviceProfile, /ObservedLanHostsWorkspace/);
  const component = source("../components/snmp/observed-lan-hosts.tsx");
  assert.match(component, /View Observed LAN Hosts/);
  assert.match(component, /href={`\/snmp\/\$\{targetId\}\/hosts`}/);
});

test("dedicated observed-host workspace is approved-viewer read-only and handles required states", () => {
  const route = source("../app/(protected)/snmp/[targetId]/hosts/page.tsx");
  const dataSource = source("../lib/managed-telemetry-source.ts");
  const component = source("../components/snmp/observed-lan-hosts.tsx");
  assert.match(route, /requireApprovedProfile/);
  assert.match(route, /loadObservedHostsData/);
  assert.match(dataSource, /loadManagedObservedHostsPage/);
  assert.match(route, /ObservedLanHostsWorkspace/);
  assert.doesNotMatch(route, /requireAdmin|profile\.role/);
  assert.match(route, /href="\/snmp"/);
  assert.match(route, /Back to SNMP workspace/);
  assert.match(route, /Managed SNMP target unavailable/);
  assert.match(route, /Observed hosts unavailable/);
  assert.match(component, /unsupported by this managed device/i);
  assert.match(component, /optional NetBIOS naming enrichment is partial/i);
  assert.match(component, /No hosts are currently observed/i);
  assert.match(component, /Stale observations are retained/i);
  assert.doesNotMatch(`${route}\n${component}`, /<form|type="password"|credential_profile_ref|auth_password|priv_password|community_string/i);
  assert.doesNotMatch(`${route}\n${component}`, /fetch\(|invoke\(|startScan|runDiscovery|snmpwalk|arbitrary OID/i);
});

test("dedicated workspace exposes search and all five requested filters", () => {
  const component = source("../components/snmp/observed-lan-hosts.tsx");
  assert.match(component, /type="search"/);
  for (const label of ["All", "Named", "Unnamed", "Fresh", "Stale"]) {
    assert.match(component, new RegExp(`label: "${label}"`));
  }
  assert.match(component, /overflow-x-auto/);
  assert.match(component, /IP-MIB neighbor/);
  assert.match(component, /Legacy IP neighbor/);
  assert.match(component, /Observed hosts: \{displayed\.length\} \/ \{hosts\.length\}/);
  assert.match(component, /filterCounts\[option\.value\]/);
  assert.match(component, /label="Device" sortKey="device"/);
  assert.match(component, /label="IP address" sortKey="ip_address"/);
  assert.match(component, /aria-sort=/);
});

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}
