import type { RunnerCapabilities } from "./diagnostic-jobs.ts";
import type {
  ManagedDeviceLatest,
  ManagedInterfaceLatest,
  ManagedObservedHostLatest,
  ManagedTelemetryEvent,
  ManagedTelemetryTarget,
} from "./managed-telemetry.ts";
import type { NetworkNode } from "./network-nodes.ts";
import type { PortableDevScenario } from "./portable-dev-mode.ts";

export const PORTABLE_TARGET_ID = "65000000-0000-4000-8000-000000000001";
export const PORTABLE_NODE_ID = "65000000-0000-4000-8000-000000000002";
export const PORTABLE_RUNNER_ID = "portable-fixture-runner";

const POLLED_AT = "2026-01-15T08:30:00.000Z";
const FIRST_SEEN_AT = "2026-01-14T08:30:00.000Z";

export type PortableManagedTelemetryFixture = {
  scenario: PortableDevScenario;
  nodes: NetworkNode[];
  runners: { id: string; display_name: string; capabilities: RunnerCapabilities }[];
  targets: ManagedTelemetryTarget[];
  interfaces: ManagedInterfaceLatest[];
  observedHosts: ManagedObservedHostLatest[];
  events: ManagedTelemetryEvent[];
};

export function managedTelemetryFixture(scenario: PortableDevScenario): PortableManagedTelemetryFixture {
  const node = fixtureNode();
  const latest = fixtureDevice();
  const target = fixtureTarget(node, latest);
  const base = {
    scenario,
    nodes: [node],
    runners: [fixtureRunner()],
    targets: [target],
    interfaces: fixtureInterfaces(),
    observedHosts: fixtureObservedHosts(),
    events: [] as ManagedTelemetryEvent[],
  };

  if (scenario === "partial") {
    base.targets[0] = fixtureTarget(node, {
      ...latest,
      status: "partial",
      sys_descr: null,
      observed_hosts_status: "partial",
    });
    base.interfaces = base.interfaces.map((row, index) => index === 0 ? {
      ...row,
      rx_rate_bps: null,
      tx_rate_bps: null,
      rx_util_percent: null,
      tx_util_percent: null,
      rx_errors_delta: null,
      tx_errors_delta: null,
      in_discards_delta: null,
      out_discards_delta: null,
    } : row);
    base.observedHosts = base.observedHosts.map((host, index) => index === 1 ? {
      ...host,
      netbios_name: null,
      enrichment_status: "unavailable",
    } : host);
  }

  if (scenario === "alert_recovery") {
    base.events = alertRecoveryEvents();
    base.interfaces[0] = {
      ...base.interfaces[0],
      rx_rate_bps: 42_000_000,
      tx_rate_bps: 18_000_000,
      rx_util_percent: 4.2,
      tx_util_percent: 1.8,
    };
  }

  if (scenario === "large_observed_hosts") {
    base.observedHosts = largeObservedHosts(200);
  }

  return base;
}

function fixtureNode(): NetworkNode {
  return {
    id: PORTABLE_NODE_ID,
    ip_address: "10.254.250.10",
    name: "Portable Fixture Switch",
    device_type: "managed_switch",
    location: "Synthetic development environment",
    notes: "Committed sanitized fixture; not a live managed device.",
    detected_fingerprint: null,
    last_inspected_at: null,
    created_by: null,
    created_at: FIRST_SEEN_AT,
    updated_at: POLLED_AT,
  };
}

function fixtureRunner() {
  return {
    id: PORTABLE_RUNNER_ID,
    display_name: "Portable Fixture Runner",
    capabilities: {
      source_locations: [],
      targets: [],
      durations: [5],
      operations: [],
      snmp_telemetry: {
        enabled: true,
        max_concurrent: 1,
        poll_intervals_seconds: [60],
        versions: ["3"],
        credential_profiles: ["portable-fixture-readonly"],
      },
    } satisfies RunnerCapabilities,
  };
}

function fixtureDevice(): ManagedDeviceLatest {
  return {
    target_id: PORTABLE_TARGET_ID,
    status: "connected",
    sys_name: "portable-switch-01",
    sys_descr: "Synthetic managed network device for local UI development",
    sys_object_id: "1.3.6.1.4.1.55555.1.1",
    uptime_seconds: 432_900,
    manufacturer: "Example Networks",
    model: "FixtureSwitch 24",
    serial_number: "SYNTHETIC-0001",
    last_polled_at: POLLED_AT,
    last_success_at: POLLED_AT,
    consecutive_poll_failures: 0,
    error_category: null,
    updated_at: POLLED_AT,
    observed_hosts_status: "available",
  };
}

function fixtureTarget(node: NetworkNode, latest: ManagedDeviceLatest): ManagedTelemetryTarget {
  return {
    id: PORTABLE_TARGET_ID,
    node_id: node.id,
    runner_id: PORTABLE_RUNNER_ID,
    enabled: true,
    credential_profile_ref: "portable-fixture-readonly",
    snmp_version: "3",
    snmp_port: 161,
    poll_interval_seconds: 60,
    oper_error_threshold: 5,
    discard_threshold: 10,
    util_warning_percent: 80,
    util_critical_percent: 95,
    util_sustained_seconds: 300,
    node: {
      id: node.id,
      ip_address: node.ip_address,
      name: node.name,
      device_type: node.device_type,
      location: node.location,
      detected_fingerprint: null,
      last_inspected_at: null,
    },
    latest,
  };
}

function fixtureInterfaces(): ManagedInterfaceLatest[] {
  return [
    fixtureInterface({
      if_index: 1,
      name: "port1",
      description: "Synthetic physical uplink",
      if_type: 6,
      is_physical: true,
      speed_bps: 1_000_000_000,
      rx_rate_bps: 120_000_000,
      tx_rate_bps: 45_000_000,
      rx_util_percent: 12,
      tx_util_percent: 4.5,
      rx_errors_cumulative: 12,
      tx_errors_cumulative: 3,
      in_discards_cumulative: 4,
      out_discards_cumulative: 1,
      rx_errors_delta: 0,
      tx_errors_delta: 0,
      in_discards_delta: 0,
      out_discards_delta: 0,
    }),
    fixtureInterface({
      if_index: 2,
      name: "port2",
      description: "Synthetic physical access port",
      if_type: 6,
      is_physical: true,
      speed_bps: 1_000_000_000,
      rx_rate_bps: 8_000_000,
      tx_rate_bps: 2_000_000,
      rx_util_percent: 0.8,
      tx_util_percent: 0.2,
    }),
    fixtureInterface({
      if_index: 100,
      name: "Vlan100",
      description: "Synthetic logical VLAN interface",
      if_type: 53,
      is_physical: false,
      speed_bps: null,
      rx_rate_bps: null,
      tx_rate_bps: null,
      rx_util_percent: null,
      tx_util_percent: null,
    }),
  ];
}

function fixtureInterface(overrides: Partial<ManagedInterfaceLatest>): ManagedInterfaceLatest {
  return {
    target_id: PORTABLE_TARGET_ID,
    if_index: 1,
    name: null,
    description: null,
    if_type: null,
    is_physical: false,
    admin_status: "up",
    oper_status: "up",
    speed_bps: null,
    rx_rate_bps: null,
    tx_rate_bps: null,
    rx_util_percent: null,
    tx_util_percent: null,
    rx_errors_cumulative: 0,
    tx_errors_cumulative: 0,
    in_discards_cumulative: 0,
    out_discards_cumulative: 0,
    rx_errors_delta: 0,
    tx_errors_delta: 0,
    in_discards_delta: 0,
    out_discards_delta: 0,
    last_polled_at: POLLED_AT,
    updated_at: POLLED_AT,
    ...overrides,
  };
}

function fixtureObservedHosts(): ManagedObservedHostLatest[] {
  return [
    fixtureHost(21, { netbios_name: "DEV-CLIENT-01", enrichment_status: "resolved", network_nodes: { name: "Fixture workstation" }, node_id: "65000000-0000-4000-8000-000000000021" }),
    fixtureHost(22, { netbios_name: "DEV-PRINTER", enrichment_status: "resolved" }),
    fixtureHost(23, { mac_address: null, netbios_name: null, enrichment_status: "unavailable" }),
    fixtureHost(24, { netbios_name: null, enrichment_status: "not_attempted", status: "stale", last_seen_at: "2026-01-14T10:00:00.000Z" }),
  ];
}

function largeObservedHosts(count: number): ManagedObservedHostLatest[] {
  return Array.from({ length: count }, (_, index) => {
    const third = Math.floor(index / 250);
    const fourth = (index % 250) + 1;
    return fixtureHost(fourth, {
      ip_address: `10.254.${third}.${fourth}`,
      mac_address: index % 5 === 0 ? null : deterministicMac(index),
      netbios_name: index % 3 === 0 ? `DEV-${String(index + 1).padStart(3, "0")}` : null,
      enrichment_status: index % 3 === 0 ? "resolved" : "not_attempted",
      status: index % 4 === 0 ? "stale" : "current",
    });
  });
}

function fixtureHost(host: number, overrides: Partial<ManagedObservedHostLatest>): ManagedObservedHostLatest {
  return {
    target_id: PORTABLE_TARGET_ID,
    node_id: null,
    ip_address: `10.254.250.${host}`,
    mac_address: deterministicMac(host),
    netbios_name: null,
    observation_source: "ip_net_to_physical",
    enrichment_status: "not_attempted",
    first_seen_at: FIRST_SEEN_AT,
    last_seen_at: POLLED_AT,
    status: "current",
    updated_at: POLLED_AT,
    network_nodes: null,
    ...overrides,
  };
}

function deterministicMac(value: number): string {
  return `02:00:00:00:${Math.floor(value / 256).toString(16).padStart(2, "0")}:${(value % 256).toString(16).padStart(2, "0")}`;
}

function alertRecoveryEvents(): ManagedTelemetryEvent[] {
  return [
    {
      id: "65000000-0000-4000-8000-000000000101",
      created_at: "2026-01-15T08:20:00.000Z",
      severity: "high",
      title: "Portable Fixture Switch: port1 at sustained high utilization",
      description: "Synthetic normalized event: utilization remained above the configured threshold.",
      source_ref: PORTABLE_TARGET_ID,
      resolved_at: "2026-01-15T08:25:00.000Z",
      raw_context: {
        source: "managed_telemetry",
        target_id: PORTABLE_TARGET_ID,
        event_id: "65000000-0000-4000-8000-000000000101",
        kind: "utilization_high",
        if_index: 1,
        utilization_percent: 97,
        threshold_percent: 95,
        sustained_seconds: 300,
      },
    },
    {
      id: "65000000-0000-4000-8000-000000000102",
      created_at: "2026-01-15T08:25:00.000Z",
      severity: "low",
      title: "Portable Fixture Switch: port1 utilization recovered",
      description: "Synthetic normalized recovery event: utilization returned below the warning threshold.",
      source_ref: PORTABLE_TARGET_ID,
      resolved_at: null,
      raw_context: {
        source: "managed_telemetry",
        target_id: PORTABLE_TARGET_ID,
        event_id: "65000000-0000-4000-8000-000000000102",
        kind: "utilization_recovered",
        if_index: 1,
        utilization_percent: 4.2,
        threshold_percent: 80,
      },
    },
  ];
}
