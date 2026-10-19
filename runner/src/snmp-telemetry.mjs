import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";

import { managedTelemetryPublishDiagnostic } from "./backend.mjs";
import { resolveSnmpProfile, safeError } from "./config.mjs";
import { runTelemetryAgent } from "./wsl.mjs";
import { isMonitoringInterval } from "./monitoring-intervals.mjs";

const PUBLISH_INTERVAL_MS = 30_000;
const TARGET_REFRESH_MS = 60_000;
const MAX_BACKOFF_MS = 60_000;
const MAX_PENDING_EVENTS = 100;
const MAX_IF_INDEX = 2147483647;
const MAX_INTERFACE_DELTA = 2 ** 31;
const MAX_POLL_TIMEOUT_MS = 60_000;
const MAX_OBSERVED_HOSTS = 256;
const MAX_NETBIOS_ENRICHMENTS = 16;
const COUNTER32_MAX = 0xFFFFFFFF;
const COUNTER32_WRAP_HIGH_WATER = 0xF0000000;
const COUNTER32_WRAP_LOW_WATER = 0x0FFFFFFF;
const MAX_BASELINE_INTERVALS = 3;
const MAX_RATE_TO_SPEED_RATIO = 2;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ManagedTelemetryWatch {
  constructor({ runnerId, backend, config, cachePath, log = () => {}, now = () => Date.now(), concurrency = 2, runAgent = runTelemetryAgent }) {
    this.runnerId = runnerId;
    this.backend = backend;
    this.config = config;
    this.cachePath = cachePath;
    this.log = log;
    this.now = now;
    this.concurrency = Math.max(1, Math.min(5, Number(concurrency) || 2));
    this.runAgent = runAgent;
    const cache = loadCache(cachePath);
    const cachedTargets = Array.isArray(cache.cachedTargets) ? cache.cachedTargets.filter((target) => validTelemetryTarget(target, config)) : [];
    this.targets = new Map(cachedTargets.map((target) => [target.id, target]));
    this.states = cache.states && typeof cache.states === "object" ? cache.states : {};
    this.pendingEvents = Array.isArray(cache.pendingEvents) ? cache.pendingEvents.slice(-MAX_PENDING_EVENTS) : [];
    this.inFlight = new Map();
    this.timer = null;
    this.running = false;
    this.ticking = false;
    this.refreshDueAt = 0;
    this.publishDueAt = 0;
    this.publishBackoffMs = 5_000;
    this.retryAt = 0;
  }

  start() {
    if (this.running) return;
    this.running = true;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 1_000);
    this.timer.unref?.();
  }

  async stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const controller of this.inFlight.values()) controller.abort();
    this.persist();
  }

  async tick() {
    if (!this.running || this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      const quiet = this.targets.size === 0 && Object.keys(this.states).length === 0 &&
        this.pendingEvents.length === 0 && this.backend.monitoringIdle?.("telemetry", now) === true;
      if (now >= this.refreshDueAt && !quiet) await this.refreshTargets(now);
      const capacity = Math.max(0, this.concurrency - this.inFlight.size);
      const due = [...this.targets.values()].filter((target) => {
        const state = this.stateFor(target.id);
        return !this.inFlight.has(target.id) && now >= (state.nextPollAt ?? 0);
      }).slice(0, capacity);
      for (const target of due) void this.poll(target);
      if ((this.pendingEvents.length || now >= this.publishDueAt) && now >= (this.retryAt ?? 0)) await this.publish(now);
    } finally { this.ticking = false; }
  }

  async refreshTargets(now = this.now()) {
    try {
      const result = await this.backend.managedTelemetryTargets(this.runnerId);
      const targets = Array.isArray(result?.targets) ? result.targets.filter((target) => validTelemetryTarget(target, this.config)) : [];
      for (const target of targets) {
        const old = this.targets.get(target.id);
        const state = this.states[target.id];
        const lastPollAt = Date.parse(state?.device?.last_polled_at);
        if (old && old.poll_interval_seconds !== target.poll_interval_seconds && Number.isFinite(lastPollAt)) {
          state.nextPollAt = lastPollAt + target.poll_interval_seconds * 1000;
        }
      }
      this.targets = new Map(targets.map((target) => [target.id, target]));
      for (const id of Object.keys(this.states)) if (!this.targets.has(id)) delete this.states[id];
      this.pendingEvents = this.pendingEvents.filter((event) => this.targets.has(event.target_id));
      this.refreshDueAt = now + TARGET_REFRESH_MS;
      this.persist();
    } catch {
      this.refreshDueAt = now + 10_000;
      this.log("Managed telemetry target refresh failed; cached targets retained");
    }
  }

  async poll(target) {
    const controller = new AbortController();
    this.inFlight.set(target.id, controller);
    try {
      const netbiosOffset = this.stateFor(target.id).netbiosCursor;
      const profile = resolveSnmpProfile(this.config, target.credential_profile_ref);
      if (!profile) {
        this.applyFailure(target, "not_configured", "SNMP_PROFILE_MISSING", this.now());
        return;
      }
      if (profile.version !== target.snmp_version) {
        this.applyFailure(target, "not_configured", "SNMP_VERSION_MISMATCH", this.now());
        return;
      }
      const creds = telemetryCredentials(target, profile);
      let result = null;
      await this.runAgent(this.config, target, creds, (event) => {
        if (event.type === "telemetry_result") {
          if (event.payload.target_id !== target.id || event.payload.ip_address !== target.ip_address) throw safeError("AGENT_PROTOCOL_ERROR");
          result = event.payload;
        }
      }, Math.min(MAX_POLL_TIMEOUT_MS, target.poll_interval_seconds * 1000) + 5_000, netbiosOffset);
      if (!result) throw safeError("AGENT_PROTOCOL_ERROR");
      this.applyResult(target, result, this.now(), netbiosOffset);
    } catch (error) {
      if (!controller.signal.aborted) {
        const code = error?.code === "SNMP_TIMEOUT" ? "timeout" : "poll_failed";
        this.applyFailure(target, code, error?.code ?? "SNMP_POLL_FAILED", this.now());
      }
    } finally { this.inFlight.delete(target.id); }
  }

  applyResult(target, payload, now = this.now(), netbiosOffset = null) {
    const state = this.stateFor(target.id);
    const device = payload.device;
    const previous = state.lastPoll;
    const rebooted = Boolean(previous?.uptime_seconds != null && device.uptime_seconds != null && device.uptime_seconds < previous.uptime_seconds);
    const interfaces = [];
    const evaluations = [];
    for (const item of payload.interfaces) {
      const previousCounter = state.counters?.[item.if_index] ?? null;
      const compatible = !rebooted && compatibleCounterBaseline(previousCounter, item, now, target.poll_interval_seconds);
      if (previousCounter && !compatibleInterfaceIdentity(previousCounter, item)) delete state.alertConditions[item.if_index];
      const row = this.interfaceRow(target, item, compatible ? previousCounter : null, now, rebooted);
      interfaces.push(row);
      evaluations.push({ row, previousCounter, compatible, rebooted });
      state.counters[item.if_index] = { in_octets: item.in_octets, out_octets: item.out_octets,
        in_errors: item.in_errors, out_errors: item.out_errors,
        in_discards: item.in_discards, out_discards: item.out_discards,
        in_octets_bits: item.in_octets_bits, out_octets_bits: item.out_octets_bits,
        in_errors_bits: item.in_errors_bits, out_errors_bits: item.out_errors_bits,
        in_discards_bits: item.in_discards_bits, out_discards_bits: item.out_discards_bits,
        name: item.name ?? null, description: item.description ?? null,
        if_type: item.if_type ?? null, is_physical: item.is_physical === true,
        speed_bps: item.speed_bps, ts: now };
    }
    for (const id of Object.keys(state.counters)) {
      if (!payload.interfaces.some((item) => item.if_index === Number(id))) {
        delete state.counters[id];
        delete state.alertConditions[id];
      }
    }
    for (const evaluation of evaluations) this.detectTransitions(target, evaluation, now);
    const failed = device.status !== "connected" && device.status !== "partial";
    state.lastPoll = { uptime_seconds: device.uptime_seconds, interfaces: interfaces.map((row) => ({
      if_index: row.if_index, admin_status: row.admin_status, oper_status: row.oper_status, speed_bps: row.speed_bps,
    })) };
    state.device = {
      target_id: target.id,
      status: device.status,
      sys_name: device.sys_name ?? null,
      sys_descr: device.sys_descr ?? null,
      sys_object_id: device.sys_object_id ?? null,
      uptime_seconds: device.uptime_seconds ?? null,
      manufacturer: device.manufacturer ?? null,
      model: device.model ?? null,
      serial_number: device.serial_number ?? null,
      last_polled_at: device.last_polled_at ?? new Date(now).toISOString(),
      last_success_at: failed ? null : new Date(now).toISOString(),
      consecutive_poll_failures: failed ? (state.device?.consecutive_poll_failures ?? 0) + 1 : 0,
      error_category: device.error_category ?? null,
      observed_hosts_status: device.observed_hosts_status,
    };
    state.interfaces = interfaces;
    state.observedHosts = payload.observed_hosts.map((host) => ({ ...host, target_id: target.id }));
    state.netbiosCursor = nextNetbiosCursor(
      netbiosOffset ?? state.netbiosCursor,
      payload.observed_hosts,
    );
    state.dirty = true;
    const scheduledTarget = this.targets.get(target.id) ?? target;
    state.nextPollAt = now + scheduledTarget.poll_interval_seconds * 1000;
    if (!state.sawFirst) { state.sawFirst = true; this.publishDueAt = 0; }
    this.persist();
  }

  applyFailure(target, status, code, now = this.now()) {
    const state = this.stateFor(target.id);
    const polledAt = new Date(now).toISOString();
    const previous = state.device;
    state.device = {
      target_id: target.id,
      status,
      sys_name: previous?.sys_name ?? null,
      sys_descr: previous?.sys_descr ?? null,
      sys_object_id: previous?.sys_object_id ?? null,
      uptime_seconds: null,
      manufacturer: previous?.manufacturer ?? null,
      model: previous?.model ?? null,
      serial_number: previous?.serial_number ?? null,
      last_polled_at: polledAt,
      last_success_at: previous?.last_success_at ?? null,
      consecutive_poll_failures: (previous?.consecutive_poll_failures ?? 0) + 1,
      error_category: errorCategory(status),
      error: safeError(code).message,
      observed_hosts_status: previous?.observed_hosts_status ?? "unsupported",
    };
    state.interfaces = [];
    state.observedHosts = [];
    state.dirty = true;
    const scheduledTarget = this.targets.get(target.id) ?? target;
    state.nextPollAt = now + scheduledTarget.poll_interval_seconds * 1000;
    if (!state.sawFirst) { state.sawFirst = true; this.publishDueAt = 0; }
    this.persist();
  }

  interfaceRow(target, item, prev, now, rebooted) {
    const elapsed = prev ? (now - prev.ts) / 1000 : null;
    const inDelta = !rebooted && prev ? counterDelta(prev.in_octets, item.in_octets, item.in_octets_bits) : null;
    const outDelta = !rebooted && prev ? counterDelta(prev.out_octets, item.out_octets, item.out_octets_bits) : null;
    const speed = item.speed_bps && item.speed_bps > 0 ? item.speed_bps : null;
    const rxRate = plausibleRate(inDelta, elapsed, speed);
    const txRate = plausibleRate(outDelta, elapsed, speed);
    const rxUtil = rxRate === null || speed === null || rxRate > speed ? null : rxRate / speed * 100;
    const txUtil = txRate === null || speed === null || txRate > speed ? null : txRate / speed * 100;
    return {
      target_id: target.id,
      if_index: item.if_index,
      name: item.name ?? null,
      description: item.description ?? null,
      if_type: item.if_type ?? null,
      is_physical: item.is_physical === true,
      admin_status: item.admin_status ?? null,
      oper_status: item.oper_status ?? null,
      speed_bps: speed,
      rx_rate_bps: round(rxRate, 2),
      tx_rate_bps: round(txRate, 2),
      rx_util_percent: round(rxUtil, 2),
      tx_util_percent: round(txUtil, 2),
      rx_errors_cumulative: item.in_errors ?? null,
      tx_errors_cumulative: item.out_errors ?? null,
      in_discards_cumulative: item.in_discards ?? null,
      out_discards_cumulative: item.out_discards ?? null,
      rx_errors_delta: prev && !rebooted ? interfaceDelta(prev.in_errors, item.in_errors, item.in_errors_bits) : null,
      tx_errors_delta: prev && !rebooted ? interfaceDelta(prev.out_errors, item.out_errors, item.out_errors_bits) : null,
      in_discards_delta: prev && !rebooted ? interfaceDelta(prev.in_discards, item.in_discards, item.in_discards_bits) : null,
      out_discards_delta: prev && !rebooted ? interfaceDelta(prev.out_discards, item.out_discards, item.out_discards_bits) : null,
      last_polled_at: new Date(now).toISOString(),
    };
  }

  detectTransitions(target, evaluation, now) {
    const { row, previousCounter, compatible, rebooted } = evaluation;
    const state = this.stateFor(target.id);
    const condition = alertConditionFor(state, row.if_index);
    const occurredAt = new Date(now).toISOString();
    if (rebooted) {
      condition.interfaceDown.consecutive = 0;
      if (!condition.utilization.active) condition.utilization.highSince = null;
      return;
    }

    const label = interfaceLabel(row);
    const device = managedDeviceLabel(target);
    const baseContext = { target_id: target.id, if_index: row.if_index, name: label, device_name: device };
    const down = row.admin_status === "up" && row.oper_status === "down";
    const recovered = row.admin_status === "up" && row.oper_status === "up";
    if (down) {
      if (!condition.interfaceDown.active) {
        condition.interfaceDown.consecutive = Math.min(2, condition.interfaceDown.consecutive + 1);
        if (condition.interfaceDown.consecutive >= 2) {
          condition.interfaceDown.active = true;
          this.pushEvent(target, "interface_down", "high", `${device}: ${label} is down`,
            `Managed interface ${label} remained operationally down while administratively enabled for two consecutive polls.`,
            { ...baseContext, admin_status: "up", oper_status: "down", consecutive_polls: 2 }, occurredAt);
        }
      }
    } else {
      condition.interfaceDown.consecutive = 0;
      if (condition.interfaceDown.active && recovered) {
        condition.interfaceDown.active = false;
        this.pushEvent(target, "interface_up", "low", `${device}: ${label} recovered`,
          `Managed interface ${label} is operationally up again after an active down condition.`,
          { ...baseContext, admin_status: "up", oper_status: "up" }, occurredAt);
      }
    }

    if (!compatible) {
      if (!condition.utilization.active) condition.utilization.highSince = null;
      return;
    }

    if (previousCounter?.speed_bps && row.speed_bps && previousCounter.speed_bps !== row.speed_bps) {
      this.pushEvent(target, "speed_changed", "low", `${device}: ${label} speed changed`,
        `Managed interface ${label} link speed changed from ${previousCounter.speed_bps / 1_000_000} Mbps to ${row.speed_bps / 1_000_000} Mbps.`,
        { ...baseContext, previous_speed_bps: previousCounter.speed_bps, speed_bps: row.speed_bps }, occurredAt);
    }

    if (!row.is_physical) return;
    const errorDelta = sumAvailableDelta(row.rx_errors_delta, row.tx_errors_delta);
    this.evaluateThreshold(target, condition.errors, "errors_threshold", errorDelta, target.oper_error_threshold,
      `${device}: ${label} error threshold crossed`, "new interface errors", "error_delta", baseContext, occurredAt);
    const discardDelta = sumAvailableDelta(row.in_discards_delta, row.out_discards_delta);
    this.evaluateThreshold(target, condition.discards, "discards_threshold", discardDelta, target.discard_threshold,
      `${device}: ${label} discard threshold crossed`, "new packet discards", "discard_delta", baseContext, occurredAt);

    const utilValues = [row.rx_util_percent, row.tx_util_percent].filter((value) => Number.isFinite(value));
    const util = utilValues.length ? Math.max(...utilValues) : null;
    const critical = Number(target.util_critical_percent ?? 0);
    const warning = Number(target.util_warning_percent ?? 0);
    const sustainedMs = (target.util_sustained_seconds ?? 300) * 1000;
    const high = condition.utilization;
    if (util === null) {
      if (!high.active) high.highSince = null;
    } else if (util >= critical) {
      high.highSince ??= now;
      if (now - high.highSince >= sustainedMs && !high.active) {
        high.active = true;
        this.pushEvent(target, "utilization_high", "high", `${device}: ${label} at sustained high utilization`,
          `Managed interface ${label} utilization reached ${round(util, 1)}% for at least ${target.util_sustained_seconds} seconds (critical threshold ${critical}%).`,
          { ...baseContext, utilization_percent: round(util, 1), threshold_percent: critical, sustained_seconds: target.util_sustained_seconds }, occurredAt);
      }
    } else if (high.active && util < warning) {
      high.active = false;
      high.highSince = null;
      this.pushEvent(target, "utilization_recovered", "low", `${device}: ${label} utilization recovered`,
        `Managed interface ${label} utilization dropped below the ${warning}% recovery threshold.`,
        { ...baseContext, utilization_percent: round(util, 1), threshold_percent: warning }, occurredAt);
    } else if (!high.active) {
      high.highSince = null;
    }
  }

  evaluateThreshold(target, condition, kind, delta, threshold, title, measurement, contextKey, baseContext, occurredAt) {
    if (delta === null || !Number.isFinite(threshold) || threshold < 1) return;
    if (delta >= threshold) {
      if (!condition.active) {
        condition.active = true;
        this.pushEvent(target, kind, "medium", title,
          `${delta} ${measurement} were observed in the latest valid interval (threshold ${threshold}).`,
          { ...baseContext, [contextKey]: delta, threshold }, occurredAt);
      }
    } else {
      condition.active = false;
    }
  }

  pushEvent(target, kind, severity, title, description, context, occurredAt) {
    this.pendingEvents.push({ event_id: randomUUID(), target_id: target.id,
      kind, severity, title, description, raw_context: context, occurred_at: occurredAt });
    this.pendingEvents = this.pendingEvents.slice(-MAX_PENDING_EVENTS);
    this.publishDueAt = 0;
  }

  async publish(now = this.now()) {
    const dirty = [...this.targets.keys()].map((id) => this.states[id]).filter((state) => state?.dirty);
    if (!dirty.length && !this.pendingEvents.length) { this.publishDueAt = now + PUBLISH_INTERVAL_MS; return; }
    const events = this.pendingEvents.slice(0, MAX_PENDING_EVENTS);
    try {
      for (const state of dirty) {
        await this.backend.publishManagedTelemetry(
          this.runnerId,
          state.device,
          state.interfaces,
          eventsForTarget(events, state.device.target_id),
          state.observedHosts,
        );
        state.dirty = false;
      }
      this.pendingEvents = this.pendingEvents.slice(events.length);
      this.publishBackoffMs = 5_000;
      this.retryAt = 0;
      this.publishDueAt = now + PUBLISH_INTERVAL_MS;
      this.persist();
    } catch (error) {
      this.retryAt = now + this.publishBackoffMs;
      this.publishBackoffMs = Math.min(MAX_BACKOFF_MS, this.publishBackoffMs * 2);
      this.log(`Managed telemetry publish failed ${managedTelemetryPublishDiagnostic(error)}; latest state and events retained locally`);
      this.persist();
    }
  }

  stateFor(id) {
    const state = this.states[id] ??= { device: null, interfaces: [], observedHosts: [], counters: {}, alertConditions: {},
      dirty: false, nextPollAt: 0, sawFirst: false, lastPoll: null, netbiosCursor: 0 };
    if (!Array.isArray(state.observedHosts)) state.observedHosts = [];
    if (!state.counters || typeof state.counters !== "object" || Array.isArray(state.counters)) state.counters = {};
    if (!state.alertConditions || typeof state.alertConditions !== "object" || Array.isArray(state.alertConditions)) state.alertConditions = {};
    state.alertConditions = sanitizeAlertConditionMap(state.alertConditions);
    migrateLegacyHighUtil(state);
    if (!Number.isSafeInteger(state.netbiosCursor) || state.netbiosCursor < 0 || state.netbiosCursor >= MAX_OBSERVED_HOSTS) state.netbiosCursor = 0;
    state.targetId = id;
    return state;
  }

  persist() { saveCache(this.cachePath, { version: 1, cachedTargets: [...this.targets.values()], states: this.states, pendingEvents: this.pendingEvents }); }
}

export function validTelemetryTarget(target, config) {
  if (!target || typeof target !== "object") return false;
  if (!UUID.test(target.id) || target.runner_id !== config.runner_id || target.enabled !== true) return false;
  if (typeof target.ip_address !== "string" || isIP(target.ip_address) !== 4) return false;
  if (!["10.", "172.16.", "172.17.", "172.18.", "172.19.", "172.20.", "172.21.", "172.22.", "172.23.",
    "172.24.", "172.25.", "172.26.", "172.27.", "172.28.", "172.29.", "172.30.", "172.31.", "192.168."].some((prefix) => target.ip_address.startsWith(prefix))) return false;
  if (!UUID.test(target.node_id)) return false;
  if (!["3", "2c"].includes(target.snmp_version)) return false;
  if (target.snmp_port !== undefined && (!Number.isInteger(target.snmp_port) || target.snmp_port < 1 || target.snmp_port > 65535)) return false;
  if (!isMonitoringInterval(target.poll_interval_seconds)) return false;
  if (target.oper_error_threshold !== undefined && (!Number.isInteger(target.oper_error_threshold) || target.oper_error_threshold < 1 || target.oper_error_threshold > 100)) return false;
  if (target.discard_threshold !== undefined && (!Number.isInteger(target.discard_threshold) || target.discard_threshold < 1 || target.discard_threshold > 100)) return false;
  for (const field of ["util_warning_percent", "util_critical_percent"]) {
    if (target[field] !== undefined && (typeof target[field] !== "number" || target[field] < 1 || target[field] > 100)) return false;
  }
  if (target.util_sustained_seconds !== undefined && (!Number.isInteger(target.util_sustained_seconds) || target.util_sustained_seconds < 60 || target.util_sustained_seconds > 3600)) return false;
  return resolveSnmpProfile(config, target.credential_profile_ref) !== null;
}

export function telemetryCredentials(target, profile) {
  return {
    version: profile.version,
    host: target.ip_address,
    port: target.snmp_port ?? 161,
    username: profile.username ?? null,
    auth_protocol: profile.auth_protocol ?? null,
    auth_password: profile.auth_password ?? null,
    priv_protocol: profile.priv_protocol ?? null,
    priv_password: profile.priv_password ?? null,
    community: profile.community ?? null,
  };
}

export function counterDelta(prev, cur, bits) {
  if (prev === null || prev === undefined || cur === null || cur === undefined) return null;
  if (!Number.isSafeInteger(prev) || !Number.isSafeInteger(cur) || prev < 0 || cur < 0) return null;
  if (cur >= prev) return cur - prev;
  if (bits !== 32 || prev > COUNTER32_MAX || cur > COUNTER32_MAX) return null;
  if (prev < COUNTER32_WRAP_HIGH_WATER || cur > COUNTER32_WRAP_LOW_WATER) return null;
  const wrapped = (0x100000000 - prev) + cur;
  if (wrapped >= 0 && wrapped < 0x80000000) return wrapped;
  return null;
}

export function simpleDelta(prev, cur) {
  if (prev === null || prev === undefined || cur === null || cur === undefined) return null;
  if (!Number.isSafeInteger(prev) || !Number.isSafeInteger(cur) || prev < 0 || cur < 0) return null;
  if (cur < prev) return null;
  return cur - prev;
}

export function nextNetbiosCursor(offset, observedHosts) {
  if (!Array.isArray(observedHosts)) return 0;
  const eligibleCount = observedHosts.filter((host) => netbiosCandidate(host?.ip_address)).length;
  if (!eligibleCount) return 0;
  const safeOffset = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  return (safeOffset + Math.min(MAX_NETBIOS_ENRICHMENTS, eligibleCount)) % eligibleCount;
}

function interfaceDelta(prev, cur, bits) {
  const delta = counterDelta(prev, cur, bits);
  return delta !== null && delta <= MAX_INTERFACE_DELTA ? delta : null;
}

function compatibleCounterBaseline(previous, item, now, pollIntervalSeconds) {
  if (!previous || !Number.isFinite(previous.ts) || now <= previous.ts) return false;
  const maxAge = pollIntervalSeconds * 1000 * MAX_BASELINE_INTERVALS;
  if (now - previous.ts > maxAge) return false;
  return compatibleInterfaceIdentity(previous, item);
}

function compatibleInterfaceIdentity(previous, item) {
  if (!previous) return false;
  for (const field of ["name", "description", "if_type", "is_physical"]) {
    if (!Object.prototype.hasOwnProperty.call(previous, field)) return false;
    if (normalizedIdentity(previous[field]) !== normalizedIdentity(item[field] ?? (field === "is_physical" ? false : null))) return false;
  }
  return true;
}

function normalizedIdentity(value) {
  return typeof value === "string" ? value.trim().toLocaleLowerCase() : value;
}

function plausibleRate(delta, elapsedSeconds, speedBps) {
  if (delta === null || elapsedSeconds == null || elapsedSeconds <= 0) return null;
  const rate = delta * 8 / elapsedSeconds;
  if (!Number.isFinite(rate) || rate < 0) return null;
  if (speedBps !== null && rate > speedBps * MAX_RATE_TO_SPEED_RATIO) return null;
  return rate;
}

function sumAvailableDelta(...values) {
  const available = values.filter((value) => Number.isFinite(value) && value >= 0);
  return available.length ? available.reduce((total, value) => total + value, 0) : null;
}

function alertConditionFor(state, ifIndex) {
  const condition = normalizeAlertCondition(state.alertConditions[ifIndex]);
  state.alertConditions[ifIndex] = condition;
  return condition;
}

function normalizeAlertCondition(source) {
  return {
    interfaceDown: {
      consecutive: Number.isSafeInteger(source?.interfaceDown?.consecutive)
        ? Math.max(0, Math.min(2, source.interfaceDown.consecutive)) : 0,
      active: source?.interfaceDown?.active === true,
    },
    errors: { active: source?.errors?.active === true },
    discards: { active: source?.discards?.active === true },
    utilization: {
      highSince: Number.isFinite(source?.utilization?.highSince) && source.utilization.highSince >= 0
        ? source.utilization.highSince : null,
      active: source?.utilization?.active === true,
    },
  };
}

function sanitizeAlertConditionMap(value) {
  const safe = {};
  for (const [ifIndex, source] of Object.entries(value).slice(0, 200)) {
    const parsed = Number(ifIndex);
    if (!/^\d{1,10}$/.test(ifIndex) || !Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_IF_INDEX) continue;
    safe[ifIndex] = normalizeAlertCondition(source);
  }
  return safe;
}

function migrateLegacyHighUtil(state) {
  if (!state.highUtil || typeof state.highUtil !== "object" || Array.isArray(state.highUtil)) return;
  for (const [ifIndex, legacy] of Object.entries(state.highUtil).slice(0, 200)) {
    if (Object.keys(state.alertConditions).length >= 200) break;
    if (!/^\d{1,10}$/.test(ifIndex) || state.alertConditions[ifIndex]) continue;
    const condition = alertConditionFor(state, ifIndex);
    condition.utilization.active = legacy?.flagged === true;
    condition.utilization.highSince = Number.isFinite(legacy?.highSince) && legacy.highSince >= 0 ? legacy.highSince : null;
  }
  delete state.highUtil;
}

function managedDeviceLabel(target) {
  if (typeof target.name === "string") {
    const name = target.name.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 80);
    if (name) return name;
  }
  return typeof target.ip_address === "string" ? target.ip_address.slice(0, 64) : "Managed device";
}

function interfaceLabel(row) {
  if (typeof row.name === "string") {
    const name = row.name.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 80);
    if (name) return name;
  }
  return `ifIndex ${row.if_index}`;
}

function errorCategory(status) {
  switch (status) {
    case "auth_failed": return "auth_failure";
    case "timeout": return "timeout";
    case "unreachable": return "unreachable";
    case "unsupported": return "unsupported";
    default: return "agent_error";
  }
}

function round(value, digits) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function eventsForTarget(events, targetId) { return events.filter((event) => event.target_id === targetId); }

function netbiosCandidate(ipAddress) {
  if (typeof ipAddress !== "string" || isIP(ipAddress) !== 4) return false;
  const finalOctet = Number(ipAddress.slice(ipAddress.lastIndexOf(".") + 1));
  return finalOctet !== 0 && finalOctet !== 255;
}

function loadCache(file) {
  try { const value = JSON.parse(readFileSync(file, "utf8")); return value && typeof value === "object" ? value : {}; }
  catch { return {}; }
}
function saveCache(file, value) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), "utf8");
    renameSync(temporary, file);
  } catch {}
}
