"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import { applicationAuthority, localManagedTarget } from "./application-persistence.ts";
import { relation } from "./server-utils.ts";
import {
  validateManagedTelemetryForm,
  managedSystemIdentityFields,
  observedHostInventoryName,
  observedHostDisplayName,
  observedHostFilterCounts,
  observedHostMacLabel,
  sortObservedHosts,
  filterObservedHosts,
  latestObservedAt,
  interfaceSummary,
  interfaceWarnings,
  credentialProfileStatus,
  formatDateTime,
  formatRate,
  formatUptime,
  formatUtil,
  ifNameLabel,
} from "./managed-telemetry-client.ts";

import type {
  ManagedTelemetryStatus,
  ManagedDeviceLatest,
  ManagedObservedHostLatest,
  ObservedHostFilter,
  ObservedHostSortKey,
  ObservedHostSortDirection,
  ManagedInterfaceLatest,
  ManagedTelemetryEvent,
  ManagedTelemetryTarget,
  ManagedTelemetryThresholds,
  InterfaceSummary,
} from "./managed-telemetry-client.ts";

export type {
  ManagedTelemetryStatus,
  ManagedDeviceLatest,
  ManagedObservedHostLatest,
  ObservedHostFilter,
  ObservedHostSortKey,
  ObservedHostSortDirection,
  ManagedInterfaceLatest,
  ManagedTelemetryEvent,
  ManagedTelemetryTarget,
  ManagedTelemetryThresholds,
  InterfaceSummary,
};
export {
  validateManagedTelemetryForm,
  managedSystemIdentityFields,
  observedHostInventoryName,
  observedHostDisplayName,
  observedHostFilterCounts,
  observedHostMacLabel,
  sortObservedHosts,
  filterObservedHosts,
  latestObservedAt,
  interfaceSummary,
  interfaceWarnings,
  credentialProfileStatus,
  formatDateTime,
  formatRate,
  formatUptime,
  formatUtil,
  ifNameLabel,
};

export async function loadManagedTelemetry(supabase: SupabaseClient) {
  if (applicationAuthority() === "local_postgres") {
    return loadManagedTelemetryLocal();
  }
  const [{ data: targets, error }, { data: interfaces, error: interfaceError }, { data: observedHosts, error: observedHostError }, { data: events, error: eventError }] = await Promise.all([
    supabase.from("managed_telemetry_targets")
      .select("id,node_id,runner_id,enabled,credential_profile_ref,snmp_version,snmp_port,poll_interval_seconds,oper_error_threshold,discard_threshold,util_warning_percent,util_critical_percent,util_sustained_seconds,network_nodes!inner(id,ip_address,name,device_type,location,detected_fingerprint,last_inspected_at),managed_device_latest(status,sys_name,sys_descr,sys_object_id,uptime_seconds,manufacturer,model,serial_number,last_polled_at,last_success_at,consecutive_poll_failures,error_category,observed_hosts_status,updated_at)").eq("enabled", true),
    supabase.from("managed_interface_latest").select("*"),
    supabase.from("managed_observed_hosts_latest").select("*,network_nodes(name)"),
    supabase.from("events").select("id,created_at,severity,title,description,source_ref,resolved_at,raw_context").eq("source", "managed_telemetry").order("created_at", { ascending: false }).limit(30),
  ]);
  if (error || interfaceError || observedHostError || eventError) return { data: [], interfaces: [], observedHosts: [], events: [], error: true };
  const rows = (targets ?? []).map((row): ManagedTelemetryTarget => {
    const node = relation(row.network_nodes);
    const latest = relation(row.managed_device_latest);
    return {
      ...row,
      node: node as ManagedTelemetryTarget["node"],
      latest: latest as ManagedDeviceLatest | null,
    } as ManagedTelemetryTarget;
  });
  return { data: rows, interfaces: (interfaces ?? []) as ManagedInterfaceLatest[], observedHosts: (observedHosts ?? []) as ManagedObservedHostLatest[], events: (events ?? []) as ManagedTelemetryEvent[], error: false };
}

async function loadManagedTelemetryLocal() {
  // Local mode: full telemetry data not yet exposed via API; return empty with error=false for graceful degradation
  return { data: [], interfaces: [], observedHosts: [], events: [], error: false };
}

export async function loadManagedTelemetryWorkspace(supabase: SupabaseClient) {
  if (applicationAuthority() === "local_postgres") {
    return loadManagedTelemetryWorkspaceLocal();
  }
  const [{ data: targets, error }, { data: interfaces, error: interfaceError }, { data: observedHosts, error: observedHostError }] = await Promise.all([
    supabase.from("managed_telemetry_targets")
      .select("id,node_id,runner_id,enabled,credential_profile_ref,snmp_version,snmp_port,poll_interval_seconds,oper_error_threshold,discard_threshold,util_warning_percent,util_critical_percent,util_sustained_seconds,network_nodes!inner(id,ip_address,name,device_type,location,detected_fingerprint,last_inspected_at),managed_device_latest(status,sys_name,sys_descr,sys_object_id,uptime_seconds,manufacturer,model,serial_number,last_polled_at,last_success_at,consecutive_poll_failures,error_category,observed_hosts_status,updated_at)")
      .order("created_at", { ascending: true }),
    supabase.from("managed_interface_latest").select("*"),
    supabase.from("managed_observed_hosts_latest").select("*,network_nodes(name)"),
  ]);
  if (error || interfaceError || observedHostError) return { data: [], interfaces: [], observedHosts: [], error: true };
  const rows = (targets ?? []).map((row): ManagedTelemetryTarget => {
    const node = relation(row.network_nodes);
    const latest = relation(row.managed_device_latest);
    return {
      ...row,
      node: node as ManagedTelemetryTarget["node"],
      latest: latest as ManagedDeviceLatest | null,
    } as ManagedTelemetryTarget;
  });
  return { data: rows, interfaces: (interfaces ?? []) as ManagedInterfaceLatest[], observedHosts: (observedHosts ?? []) as ManagedObservedHostLatest[], error: false };
}

async function loadManagedTelemetryWorkspaceLocal() {
  return { data: [], interfaces: [], observedHosts: [], error: false };
}

export async function loadManagedObservedHostsPage(supabase: SupabaseClient, targetId: string) {
  if (applicationAuthority() === "local_postgres") {
    return loadManagedObservedHostsPageLocal(targetId);
  }
  const [{ data: target, error }, { data: observedHosts, error: observedHostError }] = await Promise.all([
    supabase.from("managed_telemetry_targets")
      .select("id,node_id,runner_id,enabled,credential_profile_ref,snmp_version,snmp_port,poll_interval_seconds,oper_error_threshold,discard_threshold,util_warning_percent,util_critical_percent,util_sustained_seconds,network_nodes!inner(id,ip_address,name,device_type,location,detected_fingerprint,last_inspected_at),managed_device_latest(status,sys_name,sys_descr,sys_object_id,uptime_seconds,manufacturer,model,serial_number,last_polled_at,last_success_at,consecutive_poll_failures,error_category,observed_hosts_status,updated_at)")
      .eq("id", targetId)
      .maybeSingle(),
    supabase.from("managed_observed_hosts_latest")
      .select("*,network_nodes(name)")
      .eq("target_id", targetId),
  ]);
  if (error || observedHostError) return { target: null, observedHosts: [], error: true };
  if (!target) return { target: null, observedHosts: [], error: false };
  const node = relation(target.network_nodes);
  const latest = relation(target.managed_device_latest);
  return {
    target: {
      ...target,
      node: node as ManagedTelemetryTarget["node"],
      latest: latest as ManagedDeviceLatest | null,
    } as ManagedTelemetryTarget,
    observedHosts: (observedHosts ?? []) as ManagedObservedHostLatest[],
    error: false,
  };
}

async function loadManagedObservedHostsPageLocal(targetId: string) {
  const target = await localManagedTarget(targetId);
  if (!target) return { target: null, observedHosts: [], error: false };
  return {
    target: {
      ...target,
      node: { id: "", ip_address: "", name: "", device_type: null, location: null, detected_fingerprint: null, last_inspected_at: null },
      latest: null,
    } as ManagedTelemetryTarget,
    observedHosts: [],
    error: false,
  };
}