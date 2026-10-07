import { isIP } from "node:net";
import type { PostgresQuery, PostgresTransactionalQuery } from "./postgres-query.js";
import { isMonitoringInterval, type MonitoringInterval } from "../monitoring-intervals.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUNNER = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const PROFILE_REF = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const NODE_TYPES = new Set(["gateway", "router", "layer3_switch", "managed_switch", "server", "firewall",
  "access_point", "workstation", "printer", "camera", "iot", "phone", "unknown", "other"]);

export type InventoryNodeInput = Readonly<{
  ip_address: string;
  name: string;
  device_type: string | null;
  location: string | null;
  notes: string | null;
  detected_fingerprint?: Record<string, unknown>;
  last_inspected_at?: string;
}>;

export type HealthTargetInput = Readonly<{
  node_id: string;
  runner_id: string;
  enabled: boolean;
  critical: boolean;
  probe_interval_seconds: number;
  timeout_ms: number;
  failure_threshold: number;
  recovery_threshold: number;
  latency_warning_ms: number;
  loss_warning_percent: number;
}>;

export type ManagedTargetInput = Readonly<{
  node_id: string;
  runner_id: string;
  enabled: boolean;
  credential_profile_ref: string;
  snmp_version: "3" | "2c";
  snmp_port: number;
  poll_interval_seconds: MonitoringInterval;
  oper_error_threshold: number;
  discard_threshold: number;
  util_warning_percent: number;
  util_critical_percent: number;
  util_sustained_seconds: number;
}>;

export class InventoryPersistenceError extends Error {
  constructor(readonly code: "INVALID_INVENTORY_INPUT" | "OPERATOR_ACCESS_REQUIRED" | "ADMIN_ACCESS_REQUIRED" |
    "DEPENDENT_TARGETS_PRESENT" | "RUNNER_PROFILE_UNAVAILABLE" | "CONFIRMATION_MISMATCH") {
    super("Network inventory persistence request failed");
    this.name = "InventoryPersistenceError";
  }
}

export class PostgresNetworkInventoryRepository {
  constructor(private readonly database: PostgresTransactionalQuery) {}

  async listNodes(signal: AbortSignal): Promise<readonly Record<string, unknown>[]> {
    const rows = await this.database.rows(`
      SELECT id,host(ip_address) AS ip_address,name,device_type,location,notes,
        detected_fingerprint,last_inspected_at,created_by,created_at,updated_at
      FROM public.network_nodes ORDER BY ip_address ASC LIMIT 10000
    `, [], signal);
    return rows;
  }

  async listRunners(signal: AbortSignal): Promise<readonly Record<string, unknown>[]> {
    return this.database.rows(`
      SELECT id,display_name,last_seen_at,health_status,health_error_code,capabilities
      FROM public.diagnostic_runners ORDER BY display_name ASC LIMIT 1000
    `, [], signal);
  }

  async listHealthTargets(signal: AbortSignal): Promise<readonly Record<string, unknown>[]> {
    return this.database.rows(`
      SELECT t.id,t.node_id,t.runner_id,t.enabled,t.critical,t.probe_interval_seconds,
        t.timeout_ms,t.failure_threshold,t.recovery_threshold,t.latency_warning_ms,
        t.loss_warning_percent,
        jsonb_build_object(
          'id',n.id,'ip_address',host(n.ip_address),'name',n.name,'device_type',n.device_type,
          'location',n.location,'detected_fingerprint',n.detected_fingerprint,
          'last_inspected_at',n.last_inspected_at
        ) AS node,
        CASE WHEN l.target_id IS NULL THEN NULL ELSE jsonb_build_object(
          'status',l.status,'latency_ms',l.latency_ms,
          'packet_loss_percent',l.packet_loss_percent,'last_checked_at',l.last_checked_at,
          'last_success_at',l.last_success_at,'consecutive_failures',l.consecutive_failures,
          'sample_count',l.sample_count
        ) END AS latest
      FROM public.network_targets t
      JOIN public.network_nodes n ON n.id=t.node_id
      LEFT JOIN public.network_health_latest l ON l.target_id=t.id
      ORDER BY t.created_at ASC LIMIT 10000
    `, [], signal);
  }

  async listManagedTargets(signal: AbortSignal): Promise<readonly Record<string, unknown>[]> {
    const rows = await this.database.rows(`
      SELECT t.id,t.node_id,t.runner_id,t.enabled,t.credential_profile_ref,t.snmp_version,
        t.snmp_port,t.poll_interval_seconds,t.oper_error_threshold,t.discard_threshold,
        t.util_warning_percent,t.util_critical_percent,t.util_sustained_seconds,
        jsonb_build_object(
          'id',n.id,'ip_address',host(n.ip_address),'name',n.name,'device_type',n.device_type,
          'location',n.location,'detected_fingerprint',n.detected_fingerprint,
          'last_inspected_at',n.last_inspected_at
        ) AS node,
        CASE WHEN d.target_id IS NULL THEN NULL ELSE jsonb_build_object(
          'target_id',d.target_id,'status',d.status,'sys_name',d.sys_name,'sys_descr',d.sys_descr,
          'sys_object_id',d.sys_object_id,'uptime_seconds',d.uptime_seconds,
          'manufacturer',d.manufacturer,'model',d.model,'serial_number',d.serial_number,
          'last_polled_at',d.last_polled_at,'last_success_at',d.last_success_at,
          'consecutive_poll_failures',d.consecutive_poll_failures,'error_category',d.error_category,
          'observed_hosts_status',d.observed_hosts_status,'updated_at',d.updated_at
        ) END AS latest
      FROM public.managed_telemetry_targets t
      JOIN public.network_nodes n ON n.id=t.node_id
      LEFT JOIN public.managed_device_latest d ON d.target_id=t.id
      ORDER BY t.created_at ASC LIMIT 1000
    `, [], signal);
    return rows.map((row) => ({ ...row,
      util_warning_percent: Number(row.util_warning_percent),
      util_critical_percent: Number(row.util_critical_percent),
    }));
  }

  async listManagedInterfaces(targetId: string | undefined,
    signal: AbortSignal): Promise<readonly Record<string, unknown>[]> {
    if (targetId !== undefined && !UUID.test(targetId)) {
      throw new InventoryPersistenceError("INVALID_INVENTORY_INPUT");
    }
    const rows = await this.database.rows(`
      SELECT target_id,if_index,name,description,if_type,is_physical,admin_status,oper_status,
        speed_bps::double precision AS speed_bps,rx_rate_bps::double precision AS rx_rate_bps,
        tx_rate_bps::double precision AS tx_rate_bps,rx_util_percent::double precision AS rx_util_percent,
        tx_util_percent::double precision AS tx_util_percent,
        rx_errors_cumulative::double precision AS rx_errors_cumulative,
        tx_errors_cumulative::double precision AS tx_errors_cumulative,
        in_discards_cumulative::double precision AS in_discards_cumulative,
        out_discards_cumulative::double precision AS out_discards_cumulative,
        rx_errors_delta,tx_errors_delta,in_discards_delta,out_discards_delta,last_polled_at,updated_at
      FROM public.managed_interface_latest
      WHERE ($1::uuid IS NULL OR target_id=$1::uuid)
      ORDER BY target_id ASC,if_index ASC LIMIT 10000
    `, [targetId ?? null], signal);
    return rows;
  }

  async listManagedObservedHosts(targetId: string | undefined,
    signal: AbortSignal): Promise<readonly Record<string, unknown>[]> {
    if (targetId !== undefined && !UUID.test(targetId)) {
      throw new InventoryPersistenceError("INVALID_INVENTORY_INPUT");
    }
    return this.database.rows(`
      SELECT h.target_id,h.node_id,host(h.ip_address) AS ip_address,
        h.mac_address::text AS mac_address,h.netbios_name,h.observation_source,
        h.enrichment_status,h.first_seen_at,h.last_seen_at,h.status,h.updated_at,
        CASE WHEN n.id IS NULL THEN NULL ELSE jsonb_build_object('name',n.name) END AS network_nodes
      FROM public.managed_observed_hosts_latest h
      LEFT JOIN public.network_nodes n ON n.id=h.node_id
      WHERE ($1::uuid IS NULL OR h.target_id=$1::uuid)
      ORDER BY h.target_id ASC,h.ip_address ASC LIMIT 10000
    `, [targetId ?? null], signal);
  }

  async getNode(nodeId: string, signal: AbortSignal): Promise<Record<string, unknown> | null> {
    if (!UUID.test(nodeId)) throw new InventoryPersistenceError("INVALID_INVENTORY_INPUT");
    const rows = await this.database.rows(`
      SELECT id,host(ip_address) AS ip_address,name,device_type,location,notes,
        detected_fingerprint,last_inspected_at,created_by,created_at,updated_at
      FROM public.network_nodes WHERE id=$1::uuid
    `, [nodeId], signal);
    return rows[0] ?? null;
  }

  async getRunner(runnerId: string, signal: AbortSignal): Promise<Record<string, unknown> | null> {
    if (!RUNNER.test(runnerId)) throw new InventoryPersistenceError("INVALID_INVENTORY_INPUT");
    const rows = await this.database.rows(`
      SELECT id,display_name,last_seen_at,health_status,health_error_code,capabilities
      FROM public.diagnostic_runners WHERE id=$1
    `, [runnerId], signal);
    return rows[0] ?? null;
  }

  async getHealthTarget(targetId: string, signal: AbortSignal): Promise<Record<string, unknown> | null> {
    if (!UUID.test(targetId)) throw new InventoryPersistenceError("INVALID_INVENTORY_INPUT");
    const rows = await this.database.rows(`
      SELECT t.id,t.node_id,t.runner_id,t.enabled,t.critical,n.name AS node_name,
        host(n.ip_address) AS ip_address
      FROM public.network_targets t JOIN public.network_nodes n ON n.id=t.node_id
      WHERE t.id=$1::uuid
    `, [targetId], signal);
    return rows[0] ?? null;
  }

  async getManagedTarget(targetId: string, signal: AbortSignal): Promise<Record<string, unknown> | null> {
    if (!UUID.test(targetId)) throw new InventoryPersistenceError("INVALID_INVENTORY_INPUT");
    const rows = await this.database.rows(`
      SELECT t.id,t.node_id,t.runner_id,t.enabled,t.poll_interval_seconds,n.name AS node_name,
        host(n.ip_address) AS ip_address
      FROM public.managed_telemetry_targets t JOIN public.network_nodes n ON n.id=t.node_id
      WHERE t.id=$1::uuid
    `, [targetId], signal);
    return rows[0] ?? null;
  }

  async createNode(actorId: string, input: InventoryNodeInput, signal: AbortSignal): Promise<Record<string, unknown>> {
    validateNode(actorId, input);
    return this.database.transaction(signal, async (query) => {
      await requireOperator(query, actorId, signal);
      const rows = await query.rows(`
        INSERT INTO public.network_nodes
          (ip_address,name,device_type,location,notes,created_by,detected_fingerprint,last_inspected_at)
        VALUES ($1::inet,$2,$3,$4,$5,$6::uuid,$7::jsonb,$8::timestamptz)
        RETURNING id,host(ip_address) AS ip_address,name,device_type,location,notes,
          detected_fingerprint,last_inspected_at,created_by,created_at,updated_at
      `, [input.ip_address, input.name.trim(), input.device_type,input.location,input.notes,actorId,
        input.detected_fingerprint ? JSON.stringify(input.detected_fingerprint) : null,
        input.last_inspected_at ?? null], signal);
      if (!rows[0]) throw new InventoryPersistenceError("INVALID_INVENTORY_INPUT");
      return rows[0];
    });
  }

  async updateNode(actorId: string, nodeId: string, input: Omit<InventoryNodeInput, "ip_address">,
    signal: AbortSignal): Promise<Record<string, unknown> | null> {
    if (!UUID.test(nodeId) || !validNodeDetails(input)) throw new InventoryPersistenceError("INVALID_INVENTORY_INPUT");
    return this.database.transaction(signal, async (query) => {
      await requireOperator(query, actorId, signal);
      if (input.detected_fingerprint) {
        const node = await query.rows("SELECT host(ip_address) AS ip_address FROM public.network_nodes WHERE id=$1::uuid FOR UPDATE", [nodeId], signal);
        if (!node[0] || !validFingerprint(input.detected_fingerprint, String(node[0].ip_address), input.last_inspected_at)) {
          throw new InventoryPersistenceError("INVALID_INVENTORY_INPUT");
        }
      }
      const rows = await query.rows(`
        UPDATE public.network_nodes SET name=$2,device_type=$3,location=$4,notes=$5,
          detected_fingerprint=CASE WHEN $6::jsonb IS NULL THEN detected_fingerprint ELSE $6::jsonb END,
          last_inspected_at=CASE WHEN $6::jsonb IS NULL THEN last_inspected_at ELSE $7::timestamptz END
        WHERE id=$1::uuid RETURNING id,host(ip_address) AS ip_address,name,device_type,
          location,notes,detected_fingerprint,last_inspected_at,created_by,created_at,updated_at
      `, [nodeId,input.name.trim(),input.device_type,input.location,input.notes,
        input.detected_fingerprint ? JSON.stringify(input.detected_fingerprint) : null,
        input.last_inspected_at ?? null], signal);
      return rows[0] ?? null;
    });
  }

  async saveFingerprint(actorId: string, nodeId: string, fingerprint: Record<string, unknown>,
    inspectedAt: string, signal: AbortSignal): Promise<Record<string, unknown> | null> {
    if (!UUID.test(nodeId)) throw new InventoryPersistenceError("INVALID_INVENTORY_INPUT");
    return this.database.transaction(signal, async (query) => {
      await requireOperator(query, actorId, signal);
      const node = await query.rows("SELECT host(ip_address) AS ip_address FROM public.network_nodes WHERE id=$1::uuid FOR UPDATE", [nodeId], signal);
      if (!node[0] || !validFingerprint(fingerprint, String(node[0].ip_address), inspectedAt)) {
        throw new InventoryPersistenceError("INVALID_INVENTORY_INPUT");
      }
      const rows = await query.rows(`
        UPDATE public.network_nodes SET detected_fingerprint=$2::jsonb,last_inspected_at=$3::timestamptz
        WHERE id=$1::uuid RETURNING id,host(ip_address) AS ip_address,name,device_type,
          location,notes,detected_fingerprint,last_inspected_at,created_by,created_at,updated_at
      `, [nodeId,JSON.stringify(fingerprint),inspectedAt], signal);
      return rows[0] ?? null;
    });
  }

  async deleteNode(actorId: string, nodeId: string, confirmation: string, signal: AbortSignal): Promise<boolean> {
    if (!UUID.test(nodeId) || !validConfirmation(confirmation)) throw new InventoryPersistenceError("INVALID_INVENTORY_INPUT");
    return this.database.transaction(signal, async (query) => {
      await requireOperator(query, actorId, signal);
      const node = await query.rows("SELECT name,host(ip_address) AS ip_address FROM public.network_nodes WHERE id=$1::uuid FOR UPDATE", [nodeId], signal);
      if (!node[0] || confirmation !== `${String(node[0].name)} (${String(node[0].ip_address)})`) {
        throw new InventoryPersistenceError("CONFIRMATION_MISMATCH");
      }
      const dependencies = await query.rows(`
        SELECT EXISTS(SELECT 1 FROM public.network_targets WHERE node_id=$1::uuid) AS health,
          EXISTS(SELECT 1 FROM public.managed_telemetry_targets WHERE node_id=$1::uuid) AS telemetry
      `, [nodeId], signal);
      if (!dependencies[0] || dependencies[0].health === true || dependencies[0].telemetry === true) {
        throw new InventoryPersistenceError("DEPENDENT_TARGETS_PRESENT");
      }
      const deleted = await query.rows("DELETE FROM public.network_nodes WHERE id=$1::uuid RETURNING id", [nodeId], signal);
      return deleted.length === 1;
    });
  }

  async upsertHealthTarget(actorId: string, input: HealthTargetInput, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (!validHealthTarget(input)) throw new InventoryPersistenceError("INVALID_INVENTORY_INPUT");
    return this.database.transaction(signal, async (query) => {
      await requireOperator(query, actorId, signal);
      const existing = await query.rows(`SELECT id,node_id,runner_id,enabled,critical,probe_interval_seconds,
        timeout_ms,failure_threshold,recovery_threshold,latency_warning_ms,loss_warning_percent
        FROM public.network_targets WHERE node_id=$1::uuid AND runner_id=$2 FOR UPDATE`,
      [input.node_id, input.runner_id], signal);
      if (existing[0] && Object.entries(input).every(([key, value]) =>
        typeof value === "number" ? Number(existing[0]![key]) === value : existing[0]![key] === value)) {
        return { ...existing[0], changed: false };
      }
      const rows = await query.rows(`
        INSERT INTO public.network_targets
          (node_id,runner_id,enabled,critical,probe_method,probe_interval_seconds,timeout_ms,
           failure_threshold,recovery_threshold,latency_warning_ms,loss_warning_percent,created_by)
        VALUES ($1::uuid,$2,$3,$4,'icmp',$5,$6,$7,$8,$9,$10,$11::uuid)
        ON CONFLICT (runner_id,node_id) DO UPDATE SET
          enabled=EXCLUDED.enabled,critical=EXCLUDED.critical,
          probe_interval_seconds=EXCLUDED.probe_interval_seconds,timeout_ms=EXCLUDED.timeout_ms,
          failure_threshold=EXCLUDED.failure_threshold,recovery_threshold=EXCLUDED.recovery_threshold,
          latency_warning_ms=EXCLUDED.latency_warning_ms,loss_warning_percent=EXCLUDED.loss_warning_percent
        RETURNING id,node_id,runner_id,enabled,critical,probe_method,probe_interval_seconds,
          timeout_ms,failure_threshold,recovery_threshold,latency_warning_ms,loss_warning_percent
      `, [input.node_id,input.runner_id,input.enabled,input.critical,input.probe_interval_seconds,
        input.timeout_ms,input.failure_threshold,input.recovery_threshold,input.latency_warning_ms,
        input.loss_warning_percent,actorId], signal);
      if (!rows[0]) throw new InventoryPersistenceError("INVALID_INVENTORY_INPUT");
      return { ...rows[0], changed: true };
    });
  }

  async promoteHealthTargets(actorId: string, runnerId: string, nodeIds: readonly string[],
    signal: AbortSignal): Promise<readonly string[]> {
    if (!RUNNER.test(runnerId) || nodeIds.length < 1 || nodeIds.length > 254 ||
      new Set(nodeIds).size !== nodeIds.length || nodeIds.some((id) => !UUID.test(id))) {
      throw new InventoryPersistenceError("INVALID_INVENTORY_INPUT");
    }
    return this.database.transaction(signal, async (query) => {
      await requireOperator(query, actorId, signal);
      const rows = await query.rows(`
        INSERT INTO public.network_targets(runner_id,node_id,enabled,created_by,probe_interval_seconds)
        SELECT $1, id, true, $3::uuid, 900 FROM unnest($2::uuid[]) AS nodes(id)
        ON CONFLICT (runner_id,node_id) DO UPDATE SET enabled=true
        RETURNING node_id
      `, [runnerId,nodeIds,actorId], signal);
      if (rows.length !== nodeIds.length) throw new InventoryPersistenceError("INVALID_INVENTORY_INPUT");
      return rows.map((row) => String(row.node_id));
    });
  }

  async deleteHealthTarget(actorId: string, targetId: string, confirmation: string, signal: AbortSignal): Promise<boolean> {
    if (!UUID.test(targetId) || !validConfirmation(confirmation)) throw new InventoryPersistenceError("INVALID_INVENTORY_INPUT");
    return this.database.transaction(signal, async (query) => {
      await requireOperator(query, actorId, signal);
      const target = await query.rows(`
        SELECT n.name,host(n.ip_address) AS ip_address FROM public.network_targets t
        JOIN public.network_nodes n ON n.id=t.node_id WHERE t.id=$1::uuid FOR UPDATE OF t
      `, [targetId], signal);
      if (!target[0] || confirmation !== `${String(target[0].name)} (${String(target[0].ip_address)})`) {
        throw new InventoryPersistenceError("CONFIRMATION_MISMATCH");
      }
      const rows = await query.rows("DELETE FROM public.network_targets WHERE id=$1::uuid RETURNING id", [targetId], signal);
      return rows.length === 1;
    });
  }

  async upsertManagedTarget(actorId: string, input: ManagedTargetInput, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (!validManagedTarget(input)) throw new InventoryPersistenceError("INVALID_INVENTORY_INPUT");
    return this.database.transaction(signal, async (query) => {
      await requireAdmin(query, actorId, signal);
      if (input.enabled) {
        const capability = await query.rows(`
          SELECT id FROM public.diagnostic_runners
          WHERE id=$1 AND capabilities->'snmp_telemetry'->'credential_profiles' ? $2
        `, [input.runner_id,input.credential_profile_ref], signal);
        if (!capability.length) throw new InventoryPersistenceError("RUNNER_PROFILE_UNAVAILABLE");
      }
      const existing = await query.rows(`SELECT id,node_id,runner_id,enabled,credential_profile_ref,snmp_version,
        snmp_port,poll_interval_seconds,oper_error_threshold,discard_threshold,util_warning_percent,
        util_critical_percent,util_sustained_seconds FROM public.managed_telemetry_targets
        WHERE node_id=$1::uuid AND runner_id=$2 FOR UPDATE`, [input.node_id, input.runner_id], signal);
      if (existing[0] && Object.entries(input).every(([key, value]) =>
        typeof value === "number" ? Number(existing[0]![key]) === value : existing[0]![key] === value)) {
        return { ...existing[0], changed: false };
      }
      const rows = await query.rows(`
        INSERT INTO public.managed_telemetry_targets
          (node_id,runner_id,enabled,credential_profile_ref,snmp_version,snmp_port,
           poll_interval_seconds,oper_error_threshold,discard_threshold,util_warning_percent,
           util_critical_percent,util_sustained_seconds,created_by)
        VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::uuid)
        ON CONFLICT (runner_id,node_id) DO UPDATE SET
          enabled=EXCLUDED.enabled,credential_profile_ref=EXCLUDED.credential_profile_ref,
          snmp_version=EXCLUDED.snmp_version,snmp_port=EXCLUDED.snmp_port,
          poll_interval_seconds=EXCLUDED.poll_interval_seconds,
          oper_error_threshold=EXCLUDED.oper_error_threshold,discard_threshold=EXCLUDED.discard_threshold,
          util_warning_percent=EXCLUDED.util_warning_percent,
          util_critical_percent=EXCLUDED.util_critical_percent,
          util_sustained_seconds=EXCLUDED.util_sustained_seconds
        RETURNING id,node_id,runner_id,enabled,credential_profile_ref,snmp_version,
          snmp_port,poll_interval_seconds,oper_error_threshold,discard_threshold,
          util_warning_percent,util_critical_percent,util_sustained_seconds
      `, [input.node_id,input.runner_id,input.enabled,input.credential_profile_ref,input.snmp_version,
        input.snmp_port,input.poll_interval_seconds,input.oper_error_threshold,input.discard_threshold,
        input.util_warning_percent,input.util_critical_percent,input.util_sustained_seconds,actorId], signal);
      if (!rows[0]) throw new InventoryPersistenceError("INVALID_INVENTORY_INPUT");
      return { ...rows[0], changed: true };
    });
  }

  async deleteManagedTarget(actorId: string, targetId: string, confirmation: string, signal: AbortSignal): Promise<boolean> {
    if (!UUID.test(targetId) || !validConfirmation(confirmation)) throw new InventoryPersistenceError("INVALID_INVENTORY_INPUT");
    return this.database.transaction(signal, async (query) => {
      await requireAdmin(query, actorId, signal);
      const target = await query.rows(`
        SELECT n.name,host(n.ip_address) AS ip_address FROM public.managed_telemetry_targets t
        JOIN public.network_nodes n ON n.id=t.node_id WHERE t.id=$1::uuid FOR UPDATE OF t
      `, [targetId], signal);
      if (!target[0] || confirmation !== `${String(target[0].name)} (${String(target[0].ip_address)})`) {
        throw new InventoryPersistenceError("CONFIRMATION_MISMATCH");
      }
      const rows = await query.rows("DELETE FROM public.managed_telemetry_targets WHERE id=$1::uuid RETURNING id", [targetId], signal);
      return rows.length === 1;
    });
  }

  async setManagedPollingInterval(actorId: string, targetId: string, interval: MonitoringInterval,
    signal: AbortSignal): Promise<{ id: string; poll_interval_seconds: MonitoringInterval; changed: boolean }> {
    if (!UUID.test(targetId) || !isMonitoringInterval(interval)) throw new InventoryPersistenceError("INVALID_INVENTORY_INPUT");
    return this.database.transaction(signal, async (query) => {
      await requireOperator(query, actorId, signal);
      const rows = await query.rows(`SELECT id,poll_interval_seconds FROM public.managed_telemetry_targets
        WHERE id=$1::uuid FOR UPDATE`, [targetId], signal);
      if (!rows[0]) throw new InventoryPersistenceError("INVALID_INVENTORY_INPUT");
      if (Number(rows[0].poll_interval_seconds) === interval) return { id: targetId, poll_interval_seconds: interval, changed: false };
      const updated = await query.rows(`UPDATE public.managed_telemetry_targets SET poll_interval_seconds=$2
        WHERE id=$1::uuid RETURNING id,poll_interval_seconds`, [targetId, interval], signal);
      if (!updated[0] || Number(updated[0].poll_interval_seconds) !== interval) throw new InventoryPersistenceError("INVALID_INVENTORY_INPUT");
      return { id: targetId, poll_interval_seconds: interval, changed: true };
    });
  }
}

async function requireOperator(query: PostgresQuery, actorId: string, signal: AbortSignal): Promise<void> {
  if (!UUID.test(actorId)) throw new InventoryPersistenceError("OPERATOR_ACCESS_REQUIRED");
  const rows = await query.rows(`
    SELECT role,status FROM public.profiles WHERE id=$1::uuid FOR SHARE
  `, [actorId], signal);
  if (rows[0]?.status !== "approved" || !["admin", "operator"].includes(String(rows[0].role))) {
    throw new InventoryPersistenceError("OPERATOR_ACCESS_REQUIRED");
  }
}

async function requireAdmin(query: PostgresQuery, actorId: string, signal: AbortSignal): Promise<void> {
  if (!UUID.test(actorId)) throw new InventoryPersistenceError("ADMIN_ACCESS_REQUIRED");
  const rows = await query.rows("SELECT role,status FROM public.profiles WHERE id=$1::uuid FOR SHARE", [actorId], signal);
  if (rows[0]?.status !== "approved" || rows[0].role !== "admin") throw new InventoryPersistenceError("ADMIN_ACCESS_REQUIRED");
}

function validateNode(actorId: string, input: InventoryNodeInput): void {
  if (!UUID.test(actorId) || isIP(input.ip_address) === 0 ||
    input.ip_address.includes("/") || input.ip_address.includes("%") ||
    !validNodeDetails(input) ||
    (input.detected_fingerprint !== undefined &&
      !validFingerprint(input.detected_fingerprint, input.ip_address, input.last_inspected_at))) {
    throw new InventoryPersistenceError("INVALID_INVENTORY_INPUT");
  }
}

function validNodeDetails(input: Omit<InventoryNodeInput, "ip_address">): boolean {
  return input.name.trim().length > 0 && input.name.trim().length <= 200 &&
    (input.device_type === null || NODE_TYPES.has(input.device_type)) &&
    (input.location === null || input.location.length <= 200) &&
    (input.notes === null || input.notes.length <= 2000) &&
    ((input.detected_fingerprint === undefined) === (input.last_inspected_at === undefined));
}

function validFingerprint(value: Record<string, unknown>, ipAddress: string, inspectedAt: string | undefined): boolean {
  const encoded = JSON.stringify(value);
  return value.ip === ipAddress && ["high","medium","low","unknown"].includes(String(value.confidence)) &&
    Buffer.byteLength(encoded, "utf8") <= 32768 && !/"(?:password|passwd|secret|community|auth_password|priv_password)"\s*:/i.test(encoded) &&
    typeof inspectedAt === "string" && !Number.isNaN(Date.parse(inspectedAt));
}

function validHealthTarget(input: HealthTargetInput): boolean {
  return UUID.test(input.node_id) && RUNNER.test(input.runner_id) &&
    typeof input.enabled === "boolean" && typeof input.critical === "boolean" &&
    isMonitoringInterval(input.probe_interval_seconds) && boundedInt(input.timeout_ms,250,5000) &&
    boundedInt(input.failure_threshold,2,10) && boundedInt(input.recovery_threshold,1,5) &&
    boundedNumber(input.latency_warning_ms,1,60000) && boundedNumber(input.loss_warning_percent,0,100);
}

function validManagedTarget(input: ManagedTargetInput): boolean {
  return UUID.test(input.node_id) && RUNNER.test(input.runner_id) && typeof input.enabled === "boolean" &&
    PROFILE_REF.test(input.credential_profile_ref) && ["3","2c"].includes(input.snmp_version) &&
    boundedInt(input.snmp_port,1,65535) && isMonitoringInterval(input.poll_interval_seconds) &&
    boundedInt(input.oper_error_threshold,1,100) && boundedInt(input.discard_threshold,1,100) &&
    boundedNumber(input.util_warning_percent,1,100) && boundedNumber(input.util_critical_percent,1,100) &&
    boundedInt(input.util_sustained_seconds,60,3600);
}

function boundedInt(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
function boundedNumber(value: number, minimum: number, maximum: number): boolean {
  return Number.isFinite(value) && value >= minimum && value <= maximum;
}
function validConfirmation(value: string): boolean { return value.length > 0 && value.length <= 500; }
