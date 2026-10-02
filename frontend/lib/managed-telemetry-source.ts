import { localRunners } from "./application-persistence.ts";

import type { RunnerCapabilities } from "./diagnostic-jobs.ts";
import { managedTelemetryFixture } from "./managed-telemetry-fixtures.ts";
import {
  loadManagedObservedHostsPage,
  loadManagedTelemetryWorkspace,
} from "./managed-telemetry.ts";
import { loadAuthoritativeNetworkNodes } from "./network-nodes-source.ts";
import {
  portableDevConfig,
  type PortableEnvironment,
} from "./portable-dev-mode.ts";

type ProductionLoaders = {
  loadNodes: typeof loadAuthoritativeNetworkNodes;
  loadTelemetry: typeof loadManagedTelemetryWorkspace;
  loadObservedHosts: typeof loadManagedObservedHostsPage;
  loadRunners: () => Promise<{
    data: { id: string; display_name: string; capabilities: RunnerCapabilities }[] | null;
    error: unknown;
  }>;
};

type RunnerRow = NonNullable<Awaited<ReturnType<ProductionLoaders["loadRunners"]>>["data"]>[number];

async function loadRunnersLocal(): Promise<{ data: RunnerRow[] | null; error: unknown }> {
  const rows = await localRunners();
  return { data: rows as RunnerRow[] | null, error: rows ? null : new Error("LOCAL_APPLICATION_UNAVAILABLE") };
}

const PRODUCTION_LOADERS: ProductionLoaders = {
  loadNodes: loadAuthoritativeNetworkNodes,
  loadTelemetry: loadManagedTelemetryWorkspace,
  loadObservedHosts: loadManagedObservedHostsPage,
  loadRunners: loadRunnersLocal,
};

export async function loadSnmpWorkspaceData(
  environment: PortableEnvironment = process.env,
  loaders: ProductionLoaders = PRODUCTION_LOADERS,
) {
  const portable = portableDevConfig(environment);
  if (portable.enabled) {
    const fixture = managedTelemetryFixture(portable.scenario);
    return {
      inventory: { data: fixture.nodes, error: false },
      runnersResult: { data: fixture.runners, error: null },
      telemetry: {
        data: fixture.targets,
        interfaces: fixture.interfaces,
        observedHosts: fixture.observedHosts,
        events: fixture.events,
        error: false,
      },
      portable,
    };
  }

  const [inventory, runnersResult, telemetry] = await Promise.all([
    loaders.loadNodes(),
    loaders.loadRunners(),
    loaders.loadTelemetry(),
  ]);
  return {
    inventory,
    runnersResult,
    telemetry: { ...telemetry, events: [] },
    portable,
  };
}

export async function loadObservedHostsData(
  targetId: string,
  environment: PortableEnvironment = process.env,
  loader: ProductionLoaders["loadObservedHosts"] = PRODUCTION_LOADERS.loadObservedHosts,
) {
  const portable = portableDevConfig(environment);
  if (portable.enabled) {
    const fixture = managedTelemetryFixture(portable.scenario);
    const target = fixture.targets.find((item) => item.id === targetId) ?? null;
    return {
      target,
      observedHosts: target ? fixture.observedHosts : [],
      error: false,
      portable,
    };
  }
  return { ...await loader(targetId), portable };
}
