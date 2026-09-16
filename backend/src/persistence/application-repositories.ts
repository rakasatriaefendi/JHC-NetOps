import type { RunnerHeartbeatRepository } from "../runner-heartbeat/repository.js";
import type { NetworkHealthRepository } from "../network-health/repository.js";
import type { TrafficRepository } from "../traffic/repository.js";
import type { ManagedTelemetryRepository } from "../managed-telemetry/repository.js";
import type { PostgresProfilesRepository } from "./profiles.js";
import type { PostgresNetworkInventoryRepository } from "./inventory.js";
import type { PostgresDiagnosticJobsRepository } from "./diagnostic-jobs.js";
import type { PostgresNetworkDiscoveryRepository } from "./network-discovery.js";
import type { PostgresDeviceInspectionRepository } from "./device-inspection.js";
import type { PostgresNetworkHealthPingJobsRepository } from "./network-health-ping-jobs.js";
import type { PostgresBandwidthMeasurementsRepository } from "./bandwidth-measurements.js";
import type { PostgresHopMeasurementsRepository } from "./hop-measurements.js";
import type { PostgresTrafficMetricsRepository } from "./traffic-metrics.js";
import type { PostgresEventsRepository } from "./events.js";

export interface ApplicationRepositories {
  heartbeat: RunnerHeartbeatRepository;
  health: NetworkHealthRepository;
  traffic: TrafficRepository;
  telemetry: ManagedTelemetryRepository;
  diagnosticJobs: PostgresDiagnosticJobsRepository;
  networkDiscovery: PostgresNetworkDiscoveryRepository;
  deviceInspection: PostgresDeviceInspectionRepository;
  pingJobs: PostgresNetworkHealthPingJobsRepository;
  bandwidth: PostgresBandwidthMeasurementsRepository;
  hopMeasurements: PostgresHopMeasurementsRepository;
  trafficMetrics: PostgresTrafficMetricsRepository;
  events: PostgresEventsRepository;
  profiles: PostgresProfilesRepository;
  inventory: PostgresNetworkInventoryRepository;
}

export interface SupabaseApplicationRepositories {
  heartbeat: RunnerHeartbeatRepository;
  health: NetworkHealthRepository;
  traffic: TrafficRepository;
  telemetry: ManagedTelemetryRepository;
}