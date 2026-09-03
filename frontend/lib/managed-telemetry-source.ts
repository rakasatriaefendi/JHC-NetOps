import type { SupabaseClient } from "@supabase/supabase-js";

import type { RunnerCapabilities } from "./diagnostic-jobs.ts";
import { managedTelemetryFixture } from "./managed-telemetry-fixtures.ts";
import {
  loadManagedObservedHostsPage,
  loadManagedTelemetryWorkspace,
} from "./managed-telemetry.ts";
import { loadNetworkNodes } from "./network-nodes.ts";
import {
  portableDevConfig,
  type PortableEnvironment,
} from "./portable-dev-mode.ts";

type ProductionLoaders = {
  loadNodes: typeof loadNetworkNodes;
  loadTelemetry: typeof loadManagedTelemetryWorkspace;
  loadObservedHosts: typeof loadManagedObservedHostsPage;
  loadRunners: (supabase: SupabaseClient) => Promise<{
    data: { id: string; display_name: string; capabilities: RunnerCapabilities }[] | null;
    error: unknown;
  }>;
};

type RunnerRow = NonNullable<Awaited<ReturnType<ProductionLoaders["loadRunners"]>>["data"]>[number];

const PRODUCTION_LOADERS: ProductionLoaders = {
  loadNodes: loadNetworkNodes,
  loadTelemetry: loadManagedTelemetryWorkspace,
  loadObservedHosts: loadManagedObservedHostsPage,
  loadRunners: async (supabase) => {
    const { data, error } = await supabase.from("diagnostic_runners")
      .select("id,display_name,capabilities")
      .order("display_name");
    return { data: data as RunnerRow[] | null, error };
  },
};

export async function loadSnmpWorkspaceData(
  supabase: SupabaseClient,
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
    loaders.loadNodes(supabase),
    loaders.loadRunners(supabase),
    loaders.loadTelemetry(supabase),
  ]);
  return {
    inventory,
    runnersResult,
    telemetry: { ...telemetry, events: [] },
    portable,
  };
}

export async function loadObservedHostsData(
  supabase: SupabaseClient,
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
  return { ...await loader(supabase, targetId), portable };
}
