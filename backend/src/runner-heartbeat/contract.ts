import { isMonitoringInterval } from "../monitoring-intervals.js";

const SAFE_ERROR_CODES = new Set([
  "AGENT_PROTOCOL_ERROR",
  "AGENT_PYTHON_UNSUPPORTED",
  "AGENT_VENV_MISSING",
  "BACKEND_UPLOAD_FAILED",
  "DOWNLOAD_FAILED",
  "INVALID_CONNECTION_TYPE",
  "INVALID_JOB",
  "INVALID_TARGET",
  "IPERF3_MISSING",
  "IPERF3_SERVER_UNAVAILABLE",
  "JOB_TIMEOUT",
  "MTR_FAILED",
  "MTR_MISSING",
  "RUNNER_INTERNAL_ERROR",
  "TARGET_UNREACHABLE",
  "UPLOAD_FAILED",
  "WSL_DISTRO_NOT_FOUND",
  "WSL_INVOCATION_TIMEOUT",
  "WSL_RUNTIME_FAILED",
  "WSL_START_FAILED",
  "NETWORK_CONTEXT_UNAVAILABLE",
  "NETWORK_CONTEXT_INVALID",
  "NETWORK_INTERFACE_DOWN",
  "NO_ROUTE_TO_TARGET",
]);

const CAPABILITY_KEYS = new Set([
  "source_locations",
  "targets",
  "durations",
  "traffic_durations_seconds",
  "operations",
  "device_inspector",
  "snmp_telemetry",
]);
const TARGET_KEYS = new Set(["id", "label", "host", "iperf_port", "environment"]);
const DEVICE_INSPECTOR_KEYS = new Set([
  "schema_version",
  "available",
  "probe_engine",
  "python_version",
  "required",
  "collectors",
  "optional",
  "available_but_unused",
  "optional_not_required",
]);
const SNMP_KEYS = new Set([
  "enabled",
  "max_concurrent",
  "poll_intervals_seconds",
  "versions",
  "credential_profiles",
]);
const REQUIRED_OPERATIONS = ["bandwidth_and_path", "traffic_live", "network_discovery", "device_inspect"] as const;
const ALLOWED_OPERATIONS = new Set([...REQUIRED_OPERATIONS, "manual_ping"]);
const PROFILE_REFERENCE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export type RunnerTarget = Readonly<{
  id: string;
  label: string;
  host: string;
  iperf_port: number;
  environment: "lan" | "localhost_demo";
}>;

export type SnmpTelemetryCapability =
  | Readonly<{ enabled: false }>
  | Readonly<{
    enabled: true;
    max_concurrent: number;
    poll_intervals_seconds: number[];
    versions: string[];
    credential_profiles: string[];
  }>;

export type DeviceInspectorCapability = Readonly<{
  schema_version: 1;
  available: true;
  probe_engine: "python_socket";
  python_version: string;
  required: Record<string, boolean>;
  collectors: Record<string, boolean>;
  optional: Record<string, boolean>;
  available_but_unused: Record<string, boolean>;
  optional_not_required: Record<string, boolean>;
}>;

export type RunnerCapabilities = Readonly<{
  source_locations: string[];
  targets: RunnerTarget[];
  durations: number[];
  traffic_durations_seconds: number[];
  operations: string[];
  device_inspector?: DeviceInspectorCapability;
  snmp_telemetry?: SnmpTelemetryCapability;
}>;

export type NormalizedRunnerHeartbeat = Readonly<{
  id: string;
  display_name: string;
  health_status: "online" | "degraded";
  health_error_code: string | null;
  capabilities: RunnerCapabilities;
}>;

export type ValidationResult =
  | Readonly<{ ok: true; value: NormalizedRunnerHeartbeat }>
  | Readonly<{ ok: false; message: string }>;

export function validateRunnerHeartbeatRequest(value: unknown): ValidationResult {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(["runner"])) || !isRecord(value.runner)) {
    return invalid("Runner heartbeat payload is invalid");
  }
  const runner = value.runner;
  if (!hasOnlyKeys(runner, new Set(["id", "display_name", "health_status", "health_error_code", "capabilities"]))) {
    return invalid("Runner heartbeat contains unexpected fields");
  }
  if (!isIdentifier(runner.id) || !isLabel(runner.display_name)) {
    return invalid("Runner identity is invalid");
  }
  if (runner.health_status !== "online" && runner.health_status !== "degraded") {
    return invalid("Runner health status is invalid");
  }
  if (runner.health_error_code !== null &&
      (typeof runner.health_error_code !== "string" || !SAFE_ERROR_CODES.has(runner.health_error_code))) {
    return invalid("Runner health error code is invalid");
  }
  const capabilities = validateCapabilities(runner.capabilities);
  if (!capabilities.ok) return capabilities;
  return {
    ok: true,
    value: {
      id: runner.id,
      display_name: runner.display_name,
      health_status: runner.health_status,
      health_error_code: runner.health_error_code,
      capabilities: capabilities.value,
    },
  };
}

function validateCapabilities(value: unknown):
  | Readonly<{ ok: true; value: RunnerCapabilities }>
  | Readonly<{ ok: false; message: string }> {
  if (!isRecord(value) || !hasOnlyKeys(value, CAPABILITY_KEYS)) {
    return invalid("Runner capabilities are invalid");
  }
  if (!Array.isArray(value.source_locations) || value.source_locations.length > 50 ||
      !value.source_locations.every(isLabel) || new Set(value.source_locations).size !== value.source_locations.length) {
    return invalid("Runner source_locations must be unique labels");
  }
  if (!boundedUniqueArray<number>(value.durations, 1, 10, (item) =>
    Number.isSafeInteger(item) && (item === 5 || item === 10))) {
    return invalid("Runner durations must be unique values");
  }
  if (!boundedUniqueArray<number>(value.traffic_durations_seconds, 1, 4, (item) =>
    Number.isSafeInteger(item) && [300, 600, 900, 1800].includes(Number(item)))) {
    return invalid("Runner Traffic durations must be unique allow-listed values");
  }
  const rawOperations = value.operations;
  if (!Array.isArray(rawOperations) || (rawOperations.length !== 4 && rawOperations.length !== 5) ||
      !rawOperations.every((item) => typeof item === "string" && ALLOWED_OPERATIONS.has(item)) ||
      new Set(rawOperations).size !== rawOperations.length ||
      !REQUIRED_OPERATIONS.every((item) => rawOperations.includes(item))) {
    return invalid("Runner operations are invalid");
  }
  const operations = rawOperations as string[];
  if (!Array.isArray(value.targets) || value.targets.length > 50) {
    return invalid("Runner targets are invalid");
  }
  const targets: RunnerTarget[] = [];
  for (const target of value.targets) {
    if (!isRecord(target) || !hasOnlyKeys(target, TARGET_KEYS) || !isIdentifier(target.id) ||
        !isLabel(target.label) || !isTargetHost(target.host) || !isPort(target.iperf_port) ||
        (target.environment !== "lan" && target.environment !== "localhost_demo")) {
      return invalid("Runner target is invalid");
    }
    targets.push({
      id: target.id,
      label: target.label,
      host: target.host,
      iperf_port: target.iperf_port,
      environment: target.environment,
    });
  }
  if (new Set(targets.map(({ id }) => id)).size !== targets.length) {
    return invalid("Runner target IDs must be unique");
  }
  const deviceInspector = validateDeviceInspector(value.device_inspector);
  if (!deviceInspector.ok) return deviceInspector;
  const snmpTelemetry = validateSnmpTelemetry(value.snmp_telemetry);
  if (!snmpTelemetry.ok) return snmpTelemetry;
  return {
    ok: true,
    value: {
      source_locations: [...value.source_locations],
      targets,
      durations: [...value.durations],
      traffic_durations_seconds: [...value.traffic_durations_seconds],
      operations: operations.includes("manual_ping")
        ? [...REQUIRED_OPERATIONS, "manual_ping"]
        : [...REQUIRED_OPERATIONS],
      ...(deviceInspector.value ? { device_inspector: deviceInspector.value } : {}),
      ...(snmpTelemetry.value ? { snmp_telemetry: snmpTelemetry.value } : {}),
    },
  };
}

function validateDeviceInspector(value: unknown):
  | Readonly<{ ok: true; value: DeviceInspectorCapability | undefined }>
  | Readonly<{ ok: false; message: string }> {
  if (value === undefined) return { ok: true, value: undefined };
  if (!isRecord(value) || !hasOnlyKeys(value, DEVICE_INSPECTOR_KEYS) || value.schema_version !== 1 ||
      value.available !== true || value.probe_engine !== "python_socket" ||
      typeof value.python_version !== "string" || value.python_version.length > 32) {
    return invalid("Device Inspector capability is invalid");
  }
  if (!booleanMap(value.required) || value.required.python_socket !== true ||
      (value.collectors !== undefined && !booleanMap(value.collectors)) || !booleanMap(value.optional) ||
      !booleanMap(value.available_but_unused) || !booleanMap(value.optional_not_required)) {
    return invalid("Device Inspector capability tool matrix is invalid");
  }
  return {
    ok: true,
    value: {
      schema_version: 1,
      available: true,
      probe_engine: "python_socket",
      python_version: value.python_version,
      required: { ...value.required },
      collectors: value.collectors ? { ...value.collectors } : {
        tcp_connect: true,
        http_metadata: true,
        tls_metadata: Boolean(value.optional.openssl),
        upnp_unicast: true,
        netbios_node_status: true,
      },
      optional: { ...value.optional },
      available_but_unused: { ...value.available_but_unused },
      optional_not_required: { ...value.optional_not_required },
    },
  };
}

function validateSnmpTelemetry(value: unknown):
  | Readonly<{ ok: true; value: SnmpTelemetryCapability | undefined }>
  | Readonly<{ ok: false; message: string }> {
  if (value === undefined) return { ok: true, value: undefined };
  if (!isRecord(value) || !hasOnlyKeys(value, SNMP_KEYS) || typeof value.enabled !== "boolean") {
    return invalid("Runner SNMP telemetry capability is invalid");
  }
  if (!value.enabled) {
    return Object.keys(value).length === 1
      ? { ok: true, value: { enabled: false } }
      : invalid("Runner SNMP telemetry capability is invalid");
  }
  if (!isIntegerBetween(value.max_concurrent, 1, 5) ||
      !boundedUniqueArray<number>(value.poll_intervals_seconds, 1, 5, isMonitoringInterval) ||
      !boundedUniqueArray<string>(value.versions, 1, 2, (item) => item === "3" || item === "2c") ||
      !boundedUniqueArray<string>(value.credential_profiles, 0, 50, (item) =>
        typeof item === "string" && PROFILE_REFERENCE.test(item))) {
    return invalid("Runner SNMP telemetry capability is invalid");
  }
  return {
    ok: true,
    value: {
      enabled: true,
      max_concurrent: value.max_concurrent,
      poll_intervals_seconds: [...value.poll_intervals_seconds],
      versions: [...value.versions],
      credential_profiles: [...value.credential_profiles],
    },
  };
}

function boundedUniqueArray<T>(
  value: unknown,
  minimum: number,
  maximum: number,
  predicate: (item: unknown) => boolean,
): value is T[] {
  return Array.isArray(value) && value.length >= minimum && value.length <= maximum &&
    value.every(predicate) && new Set(value).size === value.length;
}

function booleanMap(value: unknown): value is Record<string, boolean> {
  return isRecord(value) && Object.keys(value).length <= 16 &&
    Object.values(value).every((entry) => typeof entry === "boolean");
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value);
}

function isLabel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200 && !/[\r\n]/.test(value);
}

function isTargetHost(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 253 && !/[\r\n]/.test(value);
}

function isPort(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 65_535;
}

function isIntegerBetween(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function invalid(message: string): Readonly<{ ok: false; message: string }> {
  return { ok: false, message };
}
