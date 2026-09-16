import type { FastifyInstance } from "fastify";

import { validRunnerBearerToken } from "../runner-heartbeat/auth.js";
import { InventoryPersistenceError, type HealthTargetInput, type InventoryNodeInput,
  type ManagedTargetInput, type PostgresNetworkInventoryRepository } from "./inventory.js";
import { ProfilePersistenceError, type PostgresProfilesRepository } from "./profiles.js";
import { type PostgresDiagnosticJobsRepository } from "./diagnostic-jobs.js";
import { type PostgresNetworkDiscoveryRepository } from "./network-discovery.js";
import { type PostgresDeviceInspectionRepository } from "./device-inspection.js";
import { type PostgresNetworkHealthPingJobsRepository } from "./network-health-ping-jobs.js";
import { type PostgresBandwidthMeasurementsRepository } from "./bandwidth-measurements.js";
import { type PostgresHopMeasurementsRepository } from "./hop-measurements.js";
import { type PostgresTrafficMetricsRepository } from "./traffic-metrics.js";
import { type PostgresEventsRepository } from "./events.js";

export type ApplicationRouteOptions = Readonly<{
  token: string;
  profiles: PostgresProfilesRepository;
  inventory: PostgresNetworkInventoryRepository;
  diagnosticJobs?: PostgresDiagnosticJobsRepository;
  networkDiscovery?: PostgresNetworkDiscoveryRepository;
  deviceInspection?: PostgresDeviceInspectionRepository;
  pingJobs?: PostgresNetworkHealthPingJobsRepository;
  bandwidth?: PostgresBandwidthMeasurementsRepository;
  hopMeasurements?: PostgresHopMeasurementsRepository;
  trafficMetrics?: PostgresTrafficMetricsRepository;
  events?: PostgresEventsRepository;
}>;

export function registerApplicationRoutes(server: FastifyInstance, options: ApplicationRouteOptions): void {
  const authorize = (authorization: unknown) => validRunnerBearerToken(authorization, options.token);
  const unauthorized = { error: { code: "UNAUTHORIZED", message: "Frontend server authentication required" } };
  const invalid = { error: { code: "INVALID_APPLICATION_REQUEST", message: "Application request is invalid" } };

  server.get<{ Params: { id: string } }>("/api/application/profiles/:id", async (request, reply) => {
    if (!authorize(request.headers.authorization)) return reply.code(401).send(unauthorized);
    try {
      const row = await options.profiles.getByAuthUserId(request.params.id, AbortSignal.timeout(7_000));
      return row ? reply.code(200).send({ data: row }) : reply.code(404).send({ error: { code: "PROFILE_NOT_FOUND" } });
    } catch (error) { return persistenceFailure(reply, error); }
  });

  server.get("/api/application/profiles", async (request, reply) => {
    if (!authorize(request.headers.authorization)) return reply.code(401).send(unauthorized);
    try { return reply.code(200).send({ data: await options.profiles.list(AbortSignal.timeout(7_000)) }); }
    catch (error) { return persistenceFailure(reply, error); }
  });

  server.post("/api/application/profiles/bootstrap", async (request, reply) => {
    if (!authorize(request.headers.authorization)) return reply.code(401).send(unauthorized);
    const body = record(request.body);
    if (!body || !onlyKeys(body, ["auth_user_id", "email", "full_name"]) ||
      typeof body.auth_user_id !== "string" || typeof body.email !== "string" ||
      (body.full_name !== null && typeof body.full_name !== "string")) return reply.code(400).send(invalid);
    try {
      const row = await options.profiles.bootstrapPending(body.auth_user_id, body.email, body.full_name,
        AbortSignal.timeout(7_000));
      return reply.code(200).send({ data: row });
    } catch (error) { return persistenceFailure(reply, error); }
  });

  server.patch("/api/application/profiles/access", async (request, reply) => {
    if (!authorize(request.headers.authorization)) return reply.code(401).send(unauthorized);
    const body = record(request.body);
    if (!body || !onlyKeys(body, ["actor_id", "target_id", "role", "access_status"]) ||
      ![body.actor_id, body.target_id, body.role, body.access_status].every((value) => typeof value === "string")) {
      return reply.code(400).send(invalid);
    }
    try {
      const id = await options.profiles.setAccess(body.actor_id as string, body.target_id as string,
        body.role as string, body.access_status as string, AbortSignal.timeout(7_000));
      return reply.code(200).send({ data: { id } });
    } catch (error) { return persistenceFailure(reply, error); }
  });

  server.get("/api/application/network-nodes", async (request, reply) => {
    if (!authorize(request.headers.authorization)) return reply.code(401).send(unauthorized);
    try { return reply.code(200).send({ data: await options.inventory.listNodes(AbortSignal.timeout(7_000)) }); }
    catch (error) { return persistenceFailure(reply, error); }
  });

  server.get<{ Params: { id: string } }>("/api/application/network-nodes/:id", async (request, reply) => {
    if (!authorize(request.headers.authorization)) return reply.code(401).send(unauthorized);
    try {
      const node = await options.inventory.getNode(request.params.id, AbortSignal.timeout(7_000));
      return node ? reply.code(200).send({ data: node }) : reply.code(404).send({ error: { code: "NODE_NOT_FOUND" } });
    } catch (error) { return persistenceFailure(reply, error); }
  });

  server.get<{ Params: { id: string } }>("/api/application/runners/:id", async (request, reply) => {
    if (!authorize(request.headers.authorization)) return reply.code(401).send(unauthorized);
    try {
      const row = await options.inventory.getRunner(request.params.id, AbortSignal.timeout(7_000));
      return row ? reply.code(200).send({ data: row }) : reply.code(404).send({ error: { code: "RUNNER_NOT_FOUND" } });
    } catch (error) { return persistenceFailure(reply, error); }
  });

  server.get<{ Params: { id: string } }>("/api/application/network-targets/:id", async (request, reply) => {
    if (!authorize(request.headers.authorization)) return reply.code(401).send(unauthorized);
    try {
      const row = await options.inventory.getHealthTarget(request.params.id, AbortSignal.timeout(7_000));
      return row ? reply.code(200).send({ data: row }) : reply.code(404).send({ error: { code: "TARGET_NOT_FOUND" } });
    } catch (error) { return persistenceFailure(reply, error); }
  });

  server.get<{ Params: { id: string } }>("/api/application/managed-targets/:id", async (request, reply) => {
    if (!authorize(request.headers.authorization)) return reply.code(401).send(unauthorized);
    try {
      const row = await options.inventory.getManagedTarget(request.params.id, AbortSignal.timeout(7_000));
      return row ? reply.code(200).send({ data: row }) : reply.code(404).send({ error: { code: "TARGET_NOT_FOUND" } });
    } catch (error) { return persistenceFailure(reply, error); }
  });

  server.post("/api/application/network-nodes", async (request, reply) => {
    if (!authorize(request.headers.authorization)) return reply.code(401).send(unauthorized);
    const body = actorInput(request.body);
    const input = body ? nodeInput(body.input) : null;
    if (!body || !input) return reply.code(400).send(invalid);
    try { return reply.code(200).send({ data: await options.inventory.createNode(body.actorId, input, AbortSignal.timeout(7_000)) }); }
    catch (error) { return persistenceFailure(reply, error); }
  });

  server.patch<{ Params: { id: string } }>("/api/application/network-nodes/:id", async (request, reply) => {
    if (!authorize(request.headers.authorization)) return reply.code(401).send(unauthorized);
    const body = actorInput(request.body);
    const input = body ? nodeDetails(body.input) : null;
    if (!body || !input) return reply.code(400).send(invalid);
    try { return reply.code(200).send({ data: await options.inventory.updateNode(body.actorId, request.params.id, input, AbortSignal.timeout(7_000)) }); }
    catch (error) { return persistenceFailure(reply, error); }
  });

  server.patch<{ Params: { id: string } }>("/api/application/network-nodes/:id/fingerprint", async (request, reply) => {
    if (!authorize(request.headers.authorization)) return reply.code(401).send(unauthorized);
    const body = record(request.body);
    const fingerprint = body ? record(body.fingerprint) : null;
    if (!body || !onlyKeys(body, ["actor_id", "fingerprint"]) || typeof body.actor_id !== "string" || !fingerprint) {
      return reply.code(400).send(invalid);
    }
    try {
      const row = await options.inventory.saveFingerprint(body.actor_id, request.params.id, fingerprint, new Date().toISOString(), AbortSignal.timeout(7_000));
      return row ? reply.code(200).send({ data: row }) : reply.code(404).send({ error: { code: "NODE_NOT_FOUND" } });
    } catch (error) { return persistenceFailure(reply, error); }
  });

  server.delete<{ Params: { id: string } }>("/api/application/network-nodes/:id", async (request, reply) => {
    if (!authorize(request.headers.authorization)) return reply.code(401).send(unauthorized);
    const body = confirmationBody(request.body);
    if (!body) return reply.code(400).send(invalid);
    try { return reply.code(200).send({ data: { deleted: await options.inventory.deleteNode(body.actorId, request.params.id, body.confirmation, AbortSignal.timeout(7_000)) } }); }
    catch (error) { return persistenceFailure(reply, error); }
  });

  server.post("/api/application/network-targets", async (request, reply) => {
    if (!authorize(request.headers.authorization)) return reply.code(401).send(unauthorized);
    const body = actorInput(request.body);
    const input = body ? healthInput(body.input) : null;
    if (!body || !input) return reply.code(400).send(invalid);
    try { return reply.code(200).send({ data: await options.inventory.upsertHealthTarget(body.actorId, input, AbortSignal.timeout(7_000)) }); }
    catch (error) { return persistenceFailure(reply, error); }
  });

  server.post("/api/application/network-targets/promote", async (request, reply) => {
    if (!authorize(request.headers.authorization)) return reply.code(401).send(unauthorized);
    const body = record(request.body);
    if (!body || !onlyKeys(body, ["actor_id", "runner_id", "node_ids"]) ||
      typeof body.actor_id !== "string" || typeof body.runner_id !== "string" ||
      !Array.isArray(body.node_ids) || body.node_ids.length < 1 || body.node_ids.length > 254 ||
      !body.node_ids.every((value) => typeof value === "string")) return reply.code(400).send(invalid);
    try {
      const added = await options.inventory.promoteHealthTargets(body.actor_id, body.runner_id, body.node_ids, AbortSignal.timeout(7_000));
      return reply.code(200).send({ data: { node_ids: added } });
    } catch (error) { return persistenceFailure(reply, error); }
  });

  server.delete<{ Params: { id: string } }>("/api/application/network-targets/:id", async (request, reply) => {
    if (!authorize(request.headers.authorization)) return reply.code(401).send(unauthorized);
    const body = confirmationBody(request.body);
    if (!body) return reply.code(400).send(invalid);
    try { return reply.code(200).send({ data: { deleted: await options.inventory.deleteHealthTarget(body.actorId, request.params.id, body.confirmation, AbortSignal.timeout(7_000)) } }); }
    catch (error) { return persistenceFailure(reply, error); }
  });

  server.post("/api/application/managed-targets", async (request, reply) => {
    if (!authorize(request.headers.authorization)) return reply.code(401).send(unauthorized);
    const body = actorInput(request.body);
    const input = body ? managedInput(body.input) : null;
    if (!body || !input) return reply.code(400).send(invalid);
    try { return reply.code(200).send({ data: await options.inventory.upsertManagedTarget(body.actorId, input, AbortSignal.timeout(7_000)) }); }
    catch (error) { return persistenceFailure(reply, error); }
  });

  server.delete<{ Params: { id: string } }>("/api/application/managed-targets/:id", async (request, reply) => {
    if (!authorize(request.headers.authorization)) return reply.code(401).send(unauthorized);
    const body = confirmationBody(request.body);
    if (!body) return reply.code(400).send(invalid);
    try { return reply.code(200).send({ data: { deleted: await options.inventory.deleteManagedTarget(body.actorId, request.params.id, body.confirmation, AbortSignal.timeout(7_000)) } }); }
    catch (error) { return persistenceFailure(reply, error); }
  });

  if (options.diagnosticJobs) {
    server.get<{ Params: { id: string } }>("/api/application/diagnostic-jobs/:id", async (request, reply) => {
      if (!authorize(request.headers.authorization)) return reply.code(401).send(unauthorized);
      try { const row = await options.diagnosticJobs!.get(request.params.id, AbortSignal.timeout(7_000)); return row ? reply.code(200).send({ data: row }) : reply.code(404).send({ error: { code: "JOB_NOT_FOUND" } }); }
      catch (error) { return persistenceFailure(reply, error); }
    });

    server.get<{ Params: { runnerId: string } }>("/api/application/diagnostic-jobs/runner/:runnerId", async (request, reply) => {
      if (!authorize(request.headers.authorization)) return reply.code(401).send(unauthorized);
      try { return reply.code(200).send({ data: await options.diagnosticJobs!.listByRunner(request.params.runnerId, AbortSignal.timeout(7_000)) }); }
      catch (error) { return persistenceFailure(reply, error); }
    });
  }

  if (options.networkDiscovery) {
    server.get<{ Params: { runnerId: string } }>("/api/application/network-discovery/:runnerId", async (request, reply) => {
      if (!authorize(request.headers.authorization)) return reply.code(401).send(unauthorized);
      try { const row = await options.networkDiscovery!.get(request.params.runnerId, AbortSignal.timeout(7_000)); return row ? reply.code(200).send({ data: row }) : reply.code(404).send({ error: { code: "SESSION_NOT_FOUND" } }); }
      catch (error) { return persistenceFailure(reply, error); }
    });
  }

  if (options.deviceInspection) {
    server.get<{ Params: { runnerId: string } }>("/api/application/device-inspection/:runnerId", async (request, reply) => {
      if (!authorize(request.headers.authorization)) return reply.code(401).send(unauthorized);
      try { const row = await options.deviceInspection!.get(request.params.runnerId, AbortSignal.timeout(7_000)); return row ? reply.code(200).send({ data: row }) : reply.code(404).send({ error: { code: "SESSION_NOT_FOUND" } }); }
      catch (error) { return persistenceFailure(reply, error); }
    });
  }

  if (options.pingJobs) {
    server.get<{ Params: { id: string } }>("/api/application/ping-jobs/:id", async (request, reply) => {
      if (!authorize(request.headers.authorization)) return reply.code(401).send(unauthorized);
      try { const row = await options.pingJobs!.get(request.params.id, AbortSignal.timeout(7_000)); return row ? reply.code(200).send({ data: row }) : reply.code(404).send({ error: { code: "JOB_NOT_FOUND" } }); }
      catch (error) { return persistenceFailure(reply, error); }
    });

    server.get<{ Params: { runnerId: string } }>("/api/application/ping-jobs/runner/:runnerId", async (request, reply) => {
      if (!authorize(request.headers.authorization)) return reply.code(401).send(unauthorized);
      try { return reply.code(200).send({ data: await options.pingJobs!.listByRunner(request.params.runnerId, AbortSignal.timeout(7_000)) }); }
      catch (error) { return persistenceFailure(reply, error); }
    });
  }

  if (options.bandwidth) {
    server.get("/api/application/bandwidth-measurements", async (request, reply) => {
      if (!authorize(request.headers.authorization)) return reply.code(401).send(unauthorized);
      const query = request.query as Record<string, string>;
      const limit = query.limit ? Math.max(1, Math.min(1000, parseInt(query.limit, 10))) : 100;
      try { return reply.code(200).send({ data: await options.bandwidth!.listRecent(limit, AbortSignal.timeout(7_000)) }); }
      catch (error) { return persistenceFailure(reply, error); }
    });

    server.get<{ Params: { jobId: string } }>("/api/application/bandwidth-measurements/job/:jobId", async (request, reply) => {
      if (!authorize(request.headers.authorization)) return reply.code(401).send(unauthorized);
      try { return reply.code(200).send({ data: await options.bandwidth!.listByJob(request.params.jobId, AbortSignal.timeout(7_000)) }); }
      catch (error) { return persistenceFailure(reply, error); }
    });
  }

  if (options.hopMeasurements) {
    server.get<{ Params: { sessionId: string } }>("/api/application/hop-measurements/session/:sessionId", async (request, reply) => {
      if (!authorize(request.headers.authorization)) return reply.code(401).send(unauthorized);
      try { return reply.code(200).send({ data: await options.hopMeasurements!.listBySession(request.params.sessionId, AbortSignal.timeout(7_000)) }); }
      catch (error) { return persistenceFailure(reply, error); }
    });

    server.get<{ Params: { jobId: string } }>("/api/application/hop-measurements/job/:jobId", async (request, reply) => {
      if (!authorize(request.headers.authorization)) return reply.code(401).send(unauthorized);
      try { return reply.code(200).send({ data: await options.hopMeasurements!.listByJob(request.params.jobId, AbortSignal.timeout(7_000)) }); }
      catch (error) { return persistenceFailure(reply, error); }
    });
  }

  if (options.trafficMetrics) {
    server.get("/api/application/traffic-metrics", async (request, reply) => {
      if (!authorize(request.headers.authorization)) return reply.code(401).send(unauthorized);
      const query = request.query as Record<string, string>;
      const limit = query.limit ? Math.max(1, Math.min(1000, parseInt(query.limit, 10))) : 100;
      try { return reply.code(200).send({ data: await options.trafficMetrics!.listRecent(limit, AbortSignal.timeout(7_000)) }); }
      catch (error) { return persistenceFailure(reply, error); }
    });

    server.get<{ Params: { status: string } }>("/api/application/traffic-metrics/status/:status", async (request, reply) => {
      if (!authorize(request.headers.authorization)) return reply.code(401).send(unauthorized);
      try { return reply.code(200).send({ data: await options.trafficMetrics!.listByStatus(request.params.status, AbortSignal.timeout(7_000)) }); }
      catch (error) { return persistenceFailure(reply, error); }
    });
  }

  if (options.events) {
    server.get("/api/application/events", async (request, reply) => {
      if (!authorize(request.headers.authorization)) return reply.code(401).send(unauthorized);
      const query = request.query as Record<string, string>;
      const limit = query.limit ? Math.max(1, Math.min(500, parseInt(query.limit, 10))) : 50;
      const source = query.source;
      const sourceRef = query.source_ref;
      try {
        if (source) return reply.code(200).send({ data: await options.events!.listBySource(source, sourceRef ?? null, limit, AbortSignal.timeout(7_000)) });
        return reply.code(200).send({ data: await options.events!.listRecent(limit, AbortSignal.timeout(7_000)) });
      } catch (error) { return persistenceFailure(reply, error); }
    });

    server.get<{ Params: { source: string; ref: string } }>("/api/application/events/source/:source/ref/:ref", async (request, reply) => {
      if (!authorize(request.headers.authorization)) return reply.code(401).send(unauthorized);
      const query = request.query as Record<string, string>;
      const limit = query.limit ? Math.max(1, Math.min(500, parseInt(query.limit, 10))) : 50;
      try { return reply.code(200).send({ data: await options.events!.listBySource(request.params.source, request.params.ref, limit, AbortSignal.timeout(7_000)) }); }
      catch (error) { return persistenceFailure(reply, error); }
    });
  }
}

function actorInput(value: unknown): { actorId: string; input: Record<string, unknown> } | null {
  const body = record(value);
  if (!body || !onlyKeys(body, ["actor_id", "input"]) || typeof body.actor_id !== "string") return null;
  const input = record(body.input);
  return input ? { actorId: body.actor_id, input } : null;
}

function nodeDetails(value: Record<string, unknown>): Omit<InventoryNodeInput, "ip_address"> | null {
  const withFingerprint = "detected_fingerprint" in value || "last_inspected_at" in value;
  const expected = withFingerprint
    ? ["name", "device_type", "location", "notes", "detected_fingerprint", "last_inspected_at"]
    : ["name", "device_type", "location", "notes"];
  if (!onlyKeys(value, expected) ||
    typeof value.name !== "string" || !nullableString(value.device_type) ||
    !nullableString(value.location) || !nullableString(value.notes)) return null;
  const base = { name: value.name, device_type: value.device_type, location: value.location, notes: value.notes };
  if (!withFingerprint) return base;
  const fingerprint = record(value.detected_fingerprint);
  if (!fingerprint || typeof value.last_inspected_at !== "string") return null;
  return { ...base, detected_fingerprint: fingerprint, last_inspected_at: value.last_inspected_at };
}

function nodeInput(value: Record<string, unknown>): InventoryNodeInput | null {
  const withFingerprint = "detected_fingerprint" in value || "last_inspected_at" in value;
  if (!onlyKeys(value, withFingerprint
    ? ["ip_address", "name", "device_type", "location", "notes", "detected_fingerprint", "last_inspected_at"]
    : ["ip_address", "name", "device_type", "location", "notes"]) ||
    typeof value.ip_address !== "string") return null;
  const details = nodeDetails({ name: value.name, device_type: value.device_type,
    location: value.location, notes: value.notes,
    ...(withFingerprint ? { detected_fingerprint: value.detected_fingerprint, last_inspected_at: value.last_inspected_at } : {}),
  });
  return details ? { ip_address: value.ip_address, ...details } : null;
}

function healthInput(value: Record<string, unknown>): HealthTargetInput | null {
  if (!onlyKeys(value, ["node_id", "runner_id", "enabled", "critical", "probe_interval_seconds",
    "timeout_ms", "failure_threshold", "recovery_threshold", "latency_warning_ms", "loss_warning_percent"]) ||
    typeof value.node_id !== "string" || typeof value.runner_id !== "string" ||
    typeof value.enabled !== "boolean" || typeof value.critical !== "boolean" ||
    ![value.probe_interval_seconds,value.timeout_ms,value.failure_threshold,value.recovery_threshold,
      value.latency_warning_ms,value.loss_warning_percent].every((item) => typeof item === "number")) return null;
  return {
    node_id: value.node_id, runner_id: value.runner_id, enabled: value.enabled, critical: value.critical,
    probe_interval_seconds: Number(value.probe_interval_seconds), timeout_ms: Number(value.timeout_ms),
    failure_threshold: Number(value.failure_threshold), recovery_threshold: Number(value.recovery_threshold),
    latency_warning_ms: Number(value.latency_warning_ms), loss_warning_percent: Number(value.loss_warning_percent),
  };
}

function managedInput(value: Record<string, unknown>): ManagedTargetInput | null {
  if (!onlyKeys(value, ["node_id", "runner_id", "enabled", "credential_profile_ref", "snmp_version",
    "snmp_port", "poll_interval_seconds", "oper_error_threshold", "discard_threshold",
    "util_warning_percent", "util_critical_percent", "util_sustained_seconds"]) ||
    typeof value.node_id !== "string" || typeof value.runner_id !== "string" ||
    typeof value.enabled !== "boolean" || typeof value.credential_profile_ref !== "string" ||
    (value.snmp_version !== "3" && value.snmp_version !== "2c") ||
    (value.poll_interval_seconds !== 30 && value.poll_interval_seconds !== 60) ||
    ![value.snmp_port,value.oper_error_threshold,value.discard_threshold,value.util_warning_percent,
      value.util_critical_percent,value.util_sustained_seconds].every((item) => typeof item === "number")) return null;
  return {
    node_id: value.node_id, runner_id: value.runner_id, enabled: value.enabled,
    credential_profile_ref: value.credential_profile_ref, snmp_version: value.snmp_version,
    snmp_port: Number(value.snmp_port), poll_interval_seconds: value.poll_interval_seconds,
    oper_error_threshold: Number(value.oper_error_threshold), discard_threshold: Number(value.discard_threshold),
    util_warning_percent: Number(value.util_warning_percent), util_critical_percent: Number(value.util_critical_percent),
    util_sustained_seconds: Number(value.util_sustained_seconds),
  };
}

function nullableString(value: unknown): value is string | null { return value === null || typeof value === "string"; }

function confirmationBody(value: unknown): { actorId: string; confirmation: string } | null {
  const body = record(value);
  return body && onlyKeys(body, ["actor_id", "confirmation"]) &&
    typeof body.actor_id === "string" && typeof body.confirmation === "string"
    ? { actorId: body.actor_id, confirmation: body.confirmation } : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function onlyKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => key in value);
}

function persistenceFailure(reply: import("fastify").FastifyReply, error: unknown) {
  const failure = record(error);
  if (failure?.code === "23505") {
    return reply.code(409).send({ error: { code: "INVENTORY_DUPLICATE", message: "Inventory entry already exists" } });
  }
  if (error instanceof InventoryPersistenceError || error instanceof ProfilePersistenceError) {
    const forbidden = ["OPERATOR_ACCESS_REQUIRED", "ADMIN_ACCESS_REQUIRED", "SELF_DEMOTION_BLOCKED", "LAST_ADMIN_BLOCKED"].includes(error.code);
    return reply.code(forbidden ? 403 : 400).send({ error: { code: error.code, message: "Application persistence request rejected" } });
  }
  return reply.code(503).send({ error: { code: "APPLICATION_PERSISTENCE_FAILED", message: "Application data unavailable" } });
}