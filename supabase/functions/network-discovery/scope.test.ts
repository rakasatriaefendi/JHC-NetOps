import { validDiscoveryResults, validateDiscoveryContext } from "./scope.ts";

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

Deno.test("wide private OS scope is exposed while its scan unit remains bounded", () => {
  const result = validateDiscoveryContext({
    connection_type: "ethernet",
    interface_alias: "Portable adapter",
    local_ipv4: "10.50.1.4",
    subnet_cidr: "10.50.0.0/16",
    scan_start_ipv4: "10.50.0.255",
    scan_end_ipv4: "10.50.1.252",
  });
  assert(result.ok, "valid /16 scope rejected");
  if (!result.ok) return;
  assert(result.value.subnet_cidr === "10.50.0.0/16", "actual scope was forced to /24");
  assert(result.scanRange.start_ipv4 === "10.50.0.255" && result.scanRange.end_ipv4 === "10.50.1.252", "bounded scan unit was not preserved");
  assert(result.value.total_hosts === 254, "scan host count is not bounded");
});

Deno.test("default, public, non-canonical, and RFC1918-wide scan units are rejected", () => {
  const common = { connection_type: "wifi", interface_alias: "Portable adapter", local_ipv4: "10.20.31.17" };
  for (const context of [
    { ...common, subnet_cidr: "0.0.0.0/0", scan_start_ipv4: "10.20.31.1", scan_end_ipv4: "10.20.31.254" },
    { ...common, subnet_cidr: "8.0.0.0/8", scan_start_ipv4: "8.8.8.1", scan_end_ipv4: "8.8.8.254" },
    { ...common, subnet_cidr: "10.20.31.0/23", scan_start_ipv4: "10.20.31.1", scan_end_ipv4: "10.20.31.254" },
    { ...common, subnet_cidr: "10.0.0.0/8", scan_cidr: "10.0.0.0/8" },
  ]) {
    assert(!validateDiscoveryContext(context).ok, `unsafe context accepted: ${JSON.stringify(context)}`);
  }
});

Deno.test("results must stay inside the bounded scan unit, not merely the wider scope", () => {
  const base = { evidence: ["icmp"], latency_ms: 1, is_this_device: false, is_gateway: false };
  const range = { start_ipv4: "10.50.0.255", end_ipv4: "10.50.1.252" };
  assert(validDiscoveryResults([{ ...base, ip_address: "10.50.1.20" }], range), "in-unit host rejected");
  assert(!validDiscoveryResults([{ ...base, ip_address: "10.50.2.20" }], range), "out-of-unit host accepted");
});

Deno.test("a host on an artificial /24 boundary remains valid inside a wider resolved scope", () => {
  const result = validateDiscoveryContext({
    connection_type: "ethernet",
    interface_alias: "Portable adapter",
    local_ipv4: "10.20.31.0",
    subnet_cidr: "10.20.30.0/23",
    scan_start_ipv4: "10.20.30.255",
    scan_end_ipv4: "10.20.31.252",
  });
  assert(result.ok, "valid wider-scope boundary host was rejected");
});

Deno.test("legacy bounded /24 context remains compatible without scan_cidr", () => {
  const result = validateDiscoveryContext({
    connection_type: "unknown",
    interface_alias: "Portable adapter",
    local_ipv4: "172.22.8.10",
    subnet_cidr: "172.22.8.0/24",
  });
  assert(result.ok, "legacy bounded context rejected");
});
