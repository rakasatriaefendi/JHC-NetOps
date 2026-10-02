"use server";

import { localEvents, localManagedInterfaces, localManagedObservedHosts,
  localManagedTargets } from "./application-persistence.ts";
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

export async function loadManagedTelemetry() {
  return loadManagedTelemetryLocal();
}

async function loadManagedTelemetryLocal() {
  const [targets, interfaces, observedHosts, events] = await Promise.all([
    localManagedTargets(), localManagedInterfaces(), localManagedObservedHosts(),
    localEvents(30, "managed_telemetry"),
  ]);
  if (!targets || !interfaces || !observedHosts || !events) {
    return { data: [], interfaces: [], observedHosts: [], events: [], error: true };
  }
  return {
    data: targets.filter((target) => target.enabled === true) as ManagedTelemetryTarget[],
    interfaces: interfaces as ManagedInterfaceLatest[],
    observedHosts: observedHosts as ManagedObservedHostLatest[],
    events: events as ManagedTelemetryEvent[],
    error: false,
  };
}

export async function loadManagedTelemetryWorkspace() {
  return loadManagedTelemetryWorkspaceLocal();
}

async function loadManagedTelemetryWorkspaceLocal() {
  const [targets, interfaces, observedHosts] = await Promise.all([
    localManagedTargets(), localManagedInterfaces(), localManagedObservedHosts(),
  ]);
  if (!targets || !interfaces || !observedHosts) {
    return { data: [], interfaces: [], observedHosts: [], error: true };
  }
  return {
    data: targets as ManagedTelemetryTarget[],
    interfaces: interfaces as ManagedInterfaceLatest[],
    observedHosts: observedHosts as ManagedObservedHostLatest[],
    error: false,
  };
}

export async function loadManagedObservedHostsPage(targetId: string) {
  return loadManagedObservedHostsPageLocal(targetId);
}

async function loadManagedObservedHostsPageLocal(targetId: string) {
  const [targets, observedHosts] = await Promise.all([
    localManagedTargets(), localManagedObservedHosts(targetId),
  ]);
  if (!targets || !observedHosts) return { target: null, observedHosts: [], error: true };
  const target = targets.find((row) => row.id === targetId);
  if (!target) return { target: null, observedHosts: [], error: false };
  return {
    target: target as ManagedTelemetryTarget,
    observedHosts: observedHosts as ManagedObservedHostLatest[],
    error: false,
  };
}
