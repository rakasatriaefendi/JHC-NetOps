import { createHash } from "node:crypto";

export const P13_WORKFLOW_POLICIES = Object.freeze({
  diagnostic_jobs: Object.freeze({
    queued: "queued", running: "active", completed: "safe_terminal", failed: "safe_terminal",
  }),
  traffic_live_sessions: Object.freeze({
    queued: "queued", running: "active", stopping: "transitional",
    completed: "safe_terminal", failed: "safe_terminal", expired: "expired",
  }),
  network_health_ping_jobs: Object.freeze({
    queued: "queued", running: "active", completed: "safe_terminal", failed: "safe_terminal",
  }),
  network_discovery_sessions: Object.freeze({
    idle: "safe_terminal", queued: "queued", running: "active",
    completed: "safe_terminal", failed: "safe_terminal", expired: "expired",
  }),
  device_inspection_sessions: Object.freeze({
    queued: "queued", running: "active", completed: "safe_terminal",
    failed: "safe_terminal", expired: "expired",
  }),
} as const);

export type P13WorkflowTable = keyof typeof P13_WORKFLOW_POLICIES;
export type P13WorkflowCategory = "safe_terminal" | "active" | "queued" | "transitional" | "expired";

export const P13_FREEZE_BUFFERS = Object.freeze([
  "network-health-state",
  "snmp-telemetry-state",
  "metrics-sqlite",
  "traffic-sqlite",
] as const);

export const P13_REQUIRED_BUFFERS = Object.freeze([
  ...P13_FREEZE_BUFFERS,
  "projection-outbox",
] as const);

export type P13BufferName = (typeof P13_REQUIRED_BUFFERS)[number];
export type P13ReadinessGate = "pre_migration_freeze" | "post_import_authority";

export type P13BufferEvidence = P13ReadinessEvidence["buffers"][number];

export type P13ReadinessEvidence = Readonly<{
  version: 1;
  source_checkpoint_identity: string;
  captured_at: string;
  source_writers_frozen: boolean;
  registration_frozen: boolean;
  cleanup_schedules_paused: boolean;
  asset_evidence_sync_enabled: boolean;
  application_local_adapter_ready?: boolean;
  local_control_plane_ready?: boolean;
  legacy_mutation_guards_ready?: boolean;
  realtime_projection_ready?: boolean;
  outbox_schema_ready?: boolean;
  outbox_pending_count?: number;
  outbox_failed_count?: number;
  outbox_oldest_pending_age_ms?: number | null;
  projector_allowlist_valid?: boolean;
  projector_configured?: boolean;
  unresolved_identity_blockers: number;
  runner: Readonly<{
    process_paused: boolean;
    heartbeat_writer_paused: boolean;
    active_probe_count: number;
  }>;
  workflows: Readonly<Record<P13WorkflowTable, readonly Readonly<{ id: string; status: string }>[]>>;
  buffers: readonly Readonly<{
    name: P13BufferName;
    state: "drained" | "checkpointed" | "dirty" | "missing";
    pending_count: number;
    producer_paused: boolean;
    sha256: string;
    replay_authority?: "local_postgres";
  }>[];
}>;

export type P13ReadinessReport = Readonly<{
  version: 1;
  gate: P13ReadinessGate;
  status: "PASS" | "BLOCKED";
  source_checkpoint_identity: string;
  evidence_sha256: string;
  active_work: readonly Readonly<{
    table: P13WorkflowTable;
    id: string;
    status: string;
    category: P13WorkflowCategory | "unknown";
  }>[];
  blockers: readonly string[];
}>;

export class P13ReadinessError extends Error {
  readonly code = "P13_READINESS_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "P13ReadinessError";
  }
}

export function evaluateP13Readiness(
  evidence: P13ReadinessEvidence,
  gate: P13ReadinessGate,
): P13ReadinessReport {
  validateEvidence(evidence, gate);
  const blockers: string[] = [];
  const activeWork: Array<P13ReadinessReport["active_work"][number]> = [];

  for (const table of Object.keys(P13_WORKFLOW_POLICIES) as P13WorkflowTable[]) {
    const policy = P13_WORKFLOW_POLICIES[table] as Readonly<Record<string, P13WorkflowCategory>>;
    for (const row of evidence.workflows[table]) {
      const category = policy[row.status] ?? "unknown";
      if (!["safe_terminal", "expired"].includes(category)) {
        activeWork.push(Object.freeze({ table, id: row.id, status: row.status, category }));
      }
    }
  }
  if (activeWork.length) blockers.push("unsafe_workflow_rows_present");
  if (!evidence.source_writers_frozen) blockers.push("source_writers_not_frozen");
  if (!evidence.registration_frozen) blockers.push("registration_not_frozen");
  if (!evidence.cleanup_schedules_paused) blockers.push("cleanup_schedules_not_paused");
  if (evidence.asset_evidence_sync_enabled) blockers.push("asset_evidence_sync_not_disabled");
  if (gate === "post_import_authority") {
    if (!evidence.application_local_adapter_ready) blockers.push("local_application_adapter_not_ready");
    if (!evidence.local_control_plane_ready) blockers.push("local_control_plane_not_ready");
    if (!evidence.legacy_mutation_guards_ready) blockers.push("legacy_mutation_guards_not_ready");
    if (!evidence.realtime_projection_ready) blockers.push("realtime_projection_not_ready");
    if (!evidence.outbox_schema_ready) blockers.push("outbox_schema_not_ready");
    if (!evidence.projector_allowlist_valid) blockers.push("projector_allowlist_invalid");
    if (!evidence.projector_configured) blockers.push("projector_not_configured");
    if (evidence.outbox_failed_count! > 0) blockers.push("outbox_failed_events_present");
    if (evidence.outbox_oldest_pending_age_ms !== null && evidence.outbox_oldest_pending_age_ms! > 300_000) {
      blockers.push("outbox_oldest_pending_exceeds_threshold");
    }
  }
  if (evidence.unresolved_identity_blockers > 0) blockers.push("identity_disposition_incomplete");
  if (!evidence.runner.process_paused || !evidence.runner.heartbeat_writer_paused) {
    blockers.push("runner_writer_not_paused");
  }
  if (evidence.runner.active_probe_count > 0) blockers.push("runner_probe_in_flight");

  const buffers = new Map(evidence.buffers.map((buffer) => [buffer.name, buffer]));
  const requiredBuffers = gate === "pre_migration_freeze" ? P13_FREEZE_BUFFERS : P13_REQUIRED_BUFFERS;
  for (const name of requiredBuffers) {
    const buffer = buffers.get(name);
    if (!buffer) {
      blockers.push(`buffer_evidence_missing:${name}`);
      continue;
    }
    // Network Health has no publish-ack/dirty watermark in its JSON state. A
    // zero transition count alone cannot prove its latest sample is in source,
    // so it must be sealed for local replay instead of asserted drained.
    const drained = name !== "network-health-state" && buffer.state === "drained"
      && buffer.pending_count === 0 && buffer.producer_paused;
    const checkpointed = buffer.state === "checkpointed" && buffer.producer_paused
      && buffer.replay_authority === "local_postgres";
    if (!drained && !checkpointed) blockers.push(`buffer_not_safe:${name}`);
  }

  const uniqueBlockers = Object.freeze([...new Set(blockers)].sort());
  return Object.freeze({
    version: 1,
    gate,
    status: uniqueBlockers.length ? "BLOCKED" : "PASS",
    source_checkpoint_identity: evidence.source_checkpoint_identity,
    evidence_sha256: sha256(canonicalJson(evidence)),
    active_work: Object.freeze(activeWork.sort((left, right) =>
      `${left.table}\u0000${left.id}`.localeCompare(`${right.table}\u0000${right.id}`))),
    blockers: uniqueBlockers,
  });
}

export function inspectP13RunnerStateBuffer(options: Readonly<{
  name: "network-health-state" | "snmp-telemetry-state";
  value: unknown;
  sha256: string;
  producer_paused: boolean;
}>): P13BufferEvidence {
  const root = objectValue(options.value);
  if (!/^[0-9a-f]{64}$/.test(options.sha256)) throw new P13ReadinessError("P13 runner buffer hash is invalid");
  if (options.name === "network-health-state") {
    const transitions = boundedArray(root.pendingTransitions, "Network Health pending transitions");
    const states = boundedObjectCount(root.states, "Network Health states");
    return Object.freeze({
      name: options.name,
      state: options.producer_paused ? "checkpointed" : "dirty",
      pending_count: transitions.length + states,
      producer_paused: options.producer_paused,
      sha256: options.sha256,
      ...(options.producer_paused ? { replay_authority: "local_postgres" as const } : {}),
    });
  }
  const events = boundedArray(root.pendingEvents, "Managed Telemetry pending events");
  const states = objectValue(root.states);
  const dirtyTargets = Object.values(states).filter((state) => objectValue(state).dirty === true).length;
  if (Object.keys(states).length > 10_000) throw new P13ReadinessError("Managed Telemetry state count exceeds the evidence bound");
  const pending = events.length + dirtyTargets;
  return Object.freeze({
    name: options.name,
    state: options.producer_paused && pending === 0 ? "drained" : "dirty",
    pending_count: pending,
    producer_paused: options.producer_paused,
    sha256: options.sha256,
  });
}

export function buildP13SqliteBufferEvidence(options: Readonly<{
  name: "metrics-sqlite" | "traffic-sqlite";
  pending_count: number;
  sha256: string;
  producer_paused: boolean;
  checkpoint_for_local_replay?: boolean;
}>): P13BufferEvidence {
  if (!Number.isSafeInteger(options.pending_count) || options.pending_count < 0 ||
      !/^[0-9a-f]{64}$/.test(options.sha256)) throw new P13ReadinessError("P13 SQLite buffer evidence is invalid");
  const checkpointed = options.producer_paused && options.pending_count > 0 && options.checkpoint_for_local_replay === true;
  return Object.freeze({
    name: options.name,
    state: options.producer_paused && options.pending_count === 0 ? "drained" : checkpointed ? "checkpointed" : "dirty",
    pending_count: options.pending_count,
    producer_paused: options.producer_paused,
    sha256: options.sha256,
    ...(checkpointed ? { replay_authority: "local_postgres" as const } : {}),
  });
}

function validateEvidence(evidence: P13ReadinessEvidence, gate: P13ReadinessGate): void {
  if (!evidence || evidence.version !== 1 || !/^[0-9a-f]{64}$/.test(evidence.source_checkpoint_identity) ||
      !validTimestamp(evidence.captured_at)) {
    throw new P13ReadinessError("P13 readiness evidence header is invalid");
  }
  if (!Number.isSafeInteger(evidence.unresolved_identity_blockers) || evidence.unresolved_identity_blockers < 0 ||
      !Number.isSafeInteger(evidence.runner?.active_probe_count) || evidence.runner.active_probe_count < 0) {
    throw new P13ReadinessError("P13 readiness counts are invalid");
  }
  if (gate === "post_import_authority") {
    if (typeof evidence.application_local_adapter_ready !== "boolean" ||
        typeof evidence.local_control_plane_ready !== "boolean" ||
        typeof evidence.legacy_mutation_guards_ready !== "boolean" ||
        typeof evidence.realtime_projection_ready !== "boolean" ||
        typeof evidence.outbox_schema_ready !== "boolean" ||
        typeof evidence.outbox_pending_count !== "number" ||
        typeof evidence.outbox_failed_count !== "number" ||
        (evidence.outbox_oldest_pending_age_ms !== null && typeof evidence.outbox_oldest_pending_age_ms !== "number") ||
        typeof evidence.projector_allowlist_valid !== "boolean" ||
        typeof evidence.projector_configured !== "boolean") {
      throw new P13ReadinessError("P13 post-import readiness fields are missing or invalid");
    }
    if (evidence.outbox_pending_count < 0 || evidence.outbox_failed_count < 0 ||
        (evidence.outbox_oldest_pending_age_ms !== null && evidence.outbox_oldest_pending_age_ms < 0)) {
      throw new P13ReadinessError("P13 readiness outbox counts are invalid");
    }
  }
  for (const table of Object.keys(P13_WORKFLOW_POLICIES) as P13WorkflowTable[]) {
    const rows = evidence.workflows?.[table];
    if (!Array.isArray(rows) || rows.length > 10_000) throw new P13ReadinessError(`P13 workflow evidence is invalid for ${table}`);
    for (const row of rows) {
      if (!boundedIdentifier(row?.id, 200) || !boundedIdentifier(row?.status, 32)) {
        throw new P13ReadinessError(`P13 workflow row is invalid for ${table}`);
      }
    }
  }
  if (!Array.isArray(evidence.buffers) || evidence.buffers.length > P13_REQUIRED_BUFFERS.length) {
    throw new P13ReadinessError("P13 buffer evidence is invalid");
  }
  const names = new Set<string>();
  for (const buffer of evidence.buffers) {
    if (!P13_REQUIRED_BUFFERS.includes(buffer?.name) || names.has(buffer.name) ||
        !["drained", "checkpointed", "dirty", "missing"].includes(buffer.state) ||
        !Number.isSafeInteger(buffer.pending_count) || buffer.pending_count < 0 ||
        !/^[0-9a-f]{64}$/.test(buffer.sha256)) {
      throw new P13ReadinessError("P13 buffer evidence entry is invalid");
    }
    names.add(buffer.name);
  }
}

function boundedIdentifier(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
}

function objectValue(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new P13ReadinessError("P13 buffer state is invalid");
  return value as Readonly<Record<string, unknown>>;
}

function boundedArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new P13ReadinessError(`${label} is invalid`);
  return value;
}

function boundedObjectCount(value: unknown, label: string): number {
  const object = objectValue(value);
  const count = Object.keys(object).length;
  if (count > 10_000) throw new P13ReadinessError(`${label} exceeds the evidence bound`);
  return count;
}

function validTimestamp(value: string): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Readonly<Record<string, unknown>>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
