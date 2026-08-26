import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";

import { managedTelemetryPublishDiagnostic } from "./backend.mjs";
import { resolveSnmpProfile, safeError } from "./config.mjs";
import { runTelemetryAgent } from "./wsl.mjs";

const PUBLISH_INTERVAL_MS = 30_000;
const TARGET_REFRESH_MS = 60_000;
const MAX_BACKOFF_MS = 60_000;
const MAX_PENDING_EVENTS = 100;
const MAX_IF_INDEX = 2147483647;
const MAX_POLL_TIMEOUT_MS = 60_000;
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
    this.pendingEvents = Array.isArray(cache.pendingEvents) ? cache.pendingEvents : [];
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
      if (now >= this.refreshDueAt) await this.refreshTargets(now);
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
      const profile = resolveSnmpProfile(this.config, target.credential_profile_ref);
      if (!profile) {
        this.applyFailure(target, "not_configured", "SNMP_PROFILE_MISSING", this.now());
        return;
      }
      const creds = telemetryCredentials(target, profile);
      let result = null;
      await this.runAgent(this.config, target, creds, (event) => {
        if (event.type === "telemetry_result") {
          if (event.payload.target_id !== target.id || event.payload.ip_address !== target.ip_address) throw safeError("AGENT_PROTOCOL_ERROR");
          result = event.payload;
        }
      }, Math.min(MAX_POLL_TIMEOUT_MS, target.poll_interval_seconds * 1000) + 5_000);
      if (!result) throw safeError("AGENT_PROTOCOL_ERROR");
      this.applyResult(target, result, this.now());
    } catch (error) {
      if (!controller.signal.aborted) {
        const code = error?.code === "SNMP_TIMEOUT" ? "timeout" : "poll_failed";
        this.applyFailure(target, code, error?.code ?? "SNMP_POLL_FAILED", this.now());
      }
    } finally { this.inFlight.delete(target.id); }
  }

  applyResult(target, payload, now = this.now()) {
    const state = this.stateFor(target.id);
    const device = payload.device;
    const previous = state.lastPoll;
    const rebooted = Boolean(previous?.uptime_seconds != null && device.uptime_seconds != null && device.uptime_seconds < previous.uptime_seconds);
    const interfaces = [];
    for (const item of payload.interfaces) {
      const row = this.interfaceRow(target, item, state.counters?.[item.if_index] ?? null, now, rebooted);
      interfaces.push(row);
      state.counters[item.if_index] = { in_octets: item.in_octets, out_octets: item.out_octets,
        in_errors: item.in_errors, out_errors: item.out_errors,
        in_discards: item.in_discards, out_discards: item.out_discards,
        speed_bps: item.speed_bps, ts: now };
    }
    for (const id of Object.keys(state.counters)) if (!payload.interfaces.some((item) => item.if_index === Number(id))) delete state.counters[id];
    if (previous?.interfaces) {
      for (const row of interfaces) {
        const prev = previous.interfaces.find((item) => item.if_index === row.if_index);
        if (prev) this.detectTransitions(target, prev, row, now);
      }
    }
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
    };
    state.interfaces = interfaces;
    state.dirty = true;
    state.nextPollAt = now + target.poll_interval_seconds * 1000;
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
    };
    state.interfaces = [];
    state.dirty = true;
    state.nextPollAt = now + target.poll_interval_seconds * 1000;
    if (!state.sawFirst) { state.sawFirst = true; this.publishDueAt = 0; }
    this.persist();
  }

  interfaceRow(target, item, prev, now, rebooted) {
    const elapsed = prev ? (now - prev.ts) / 1000 : null;
    const inDelta = !rebooted && prev ? counterDelta(prev.in_octets, item.in_octets) : null;
    const outDelta = !rebooted && prev ? counterDelta(prev.out_octets, item.out_octets) : null;
    const rxRate = inDelta === null || elapsed == null || elapsed <= 0 ? null : inDelta * 8 / elapsed;
    const txRate = outDelta === null || elapsed == null || elapsed <= 0 ? null : outDelta * 8 / elapsed;
    const speed = item.speed_bps && item.speed_bps > 0 ? item.speed_bps : null;
    const rxUtil = rxRate === null || speed === null ? null : Math.min(100, rxRate / speed * 100);
    const txUtil = txRate === null || speed === null ? null : Math.min(100, txRate / speed * 100);
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
      rx_errors_delta: prev && !rebooted ? simpleDelta(prev.in_errors, item.in_errors) : null,
      tx_errors_delta: prev && !rebooted ? simpleDelta(prev.out_errors, item.out_errors) : null,
      in_discards_delta: prev && !rebooted ? simpleDelta(prev.in_discards, item.in_discards) : null,
      out_discards_delta: prev && !rebooted ? simpleDelta(prev.out_discards, item.out_discards) : null,
      last_polled_at: new Date(now).toISOString(),
    };
  }

  detectTransitions(target, prev, row, now) {
    const occurredAt = new Date(now).toISOString();
    if (prev.oper_status === "up" && row.oper_status === "down") {
      this.pushEvent(target, "interface_down", "high", `Interface ${row.name ?? `#${row.if_index}`} is down`,
        `Operational status changed from up to down on interface ${row.name ?? `ifIndex ${row.if_index}`}.`,
        { target_id: target.id, if_index: row.if_index, name: row.name ?? null }, occurredAt);
    } else if (prev.oper_status === "down" && row.oper_status === "up") {
      this.pushEvent(target, "interface_up", "low", `Interface ${row.name ?? `#${row.if_index}`} recovered`,
        `Operational status changed from down to up on interface ${row.name ?? `ifIndex ${row.if_index}`}.`,
        { target_id: target.id, if_index: row.if_index, name: row.name ?? null }, occurredAt);
    }
    if (prev.speed_bps && row.speed_bps && prev.speed_bps !== row.speed_bps) {
      this.pushEvent(target, "speed_changed", "low", `Interface ${row.name ?? `#${row.if_index}`} speed changed`,
        `Link speed changed from ${prev.speed_bps / 1_000_000} Mbps to ${row.speed_bps / 1_000_000} Mbps on interface ${row.name ?? `ifIndex ${row.if_index}`}.`,
        { target_id: target.id, if_index: row.if_index, name: row.name ?? null, previous_speed_bps: prev.speed_bps, speed_bps: row.speed_bps }, occurredAt);
    }
    const errorDelta = sumDelta(row.rx_errors_delta, row.tx_errors_delta);
    if (errorDelta !== null && errorDelta >= target.oper_error_threshold) {
      this.pushEvent(target, "errors_threshold", "medium", `Interface ${row.name ?? `#${row.if_index}`} error spike`,
        `${errorDelta} new interface errors observed since the previous poll on interface ${row.name ?? `ifIndex ${row.if_index}`}.`,
        { target_id: target.id, if_index: row.if_index, name: row.name ?? null, error_delta: errorDelta }, occurredAt);
    }
    const discardDelta = sumDelta(row.in_discards_delta, row.out_discards_delta);
    if (discardDelta !== null && discardDelta >= target.discard_threshold) {
      this.pushEvent(target, "discards_threshold", "medium", `Interface ${row.name ?? `#${row.if_index}`} discard spike`,
        `${discardDelta} new packet discards observed since the previous poll on interface ${row.name ?? `ifIndex ${row.if_index}`}.`,
        { target_id: target.id, if_index: row.if_index, name: row.name ?? null, discard_delta: discardDelta }, occurredAt);
    }
    const util = Math.max(row.rx_util_percent ?? 0, row.tx_util_percent ?? 0);
    const critical = Number(target.util_critical_percent ?? 0);
    const warning = Number(target.util_warning_percent ?? 0);
    const sustainedMs = (target.util_sustained_seconds ?? 300) * 1000;
    const high = this.stateFor(target.id).highUtil[row.if_index] ??= { highSince: null, flagged: false };
    if (util >= critical && (row.rx_util_percent !== null || row.tx_util_percent !== null)) {
      high.highSince ??= now;
      if (now - high.highSince >= sustainedMs && !high.flagged) {
        high.flagged = true;
        this.pushEvent(target, "utilization_high", "high", `Interface ${row.name ?? `#${row.if_index}`} at sustained high utilization`,
          `Utilization reached ${round(util, 1)}% for over ${target.util_sustained_seconds} seconds on interface ${row.name ?? `ifIndex ${row.if_index}`}.`,
          { target_id: target.id, if_index: row.if_index, name: row.name ?? null, utilization_percent: round(util, 1) }, occurredAt);
      }
    } else {
      if (high.flagged && util < warning) {
        high.flagged = false;
        this.pushEvent(target, "utilization_recovered", "low", `Interface ${row.name ?? `#${row.if_index}`} utilization recovered`,
          `Utilization on interface ${row.name ?? `ifIndex ${row.if_index}`} dropped below ${warning}%.`,
          { target_id: target.id, if_index: row.if_index, name: row.name ?? null }, occurredAt);
      }
      high.highSince = util >= warning ? high.highSince : null;
    }
  }

  pushEvent(target, kind, severity, title, description, context, occurredAt) {
    this.pendingEvents.push({ event_id: randomUUID(), source: "managed_telemetry", source_ref: target.id,
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
        await this.backend.publishManagedTelemetry(this.runnerId, state.device, state.interfaces, eventsForTarget(events, state.device.target_id));
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
    const state = this.states[id] ??= { device: null, interfaces: [], counters: {}, highUtil: {},
      dirty: false, nextPollAt: 0, sawFirst: false, lastPoll: null };
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
  if (![30, 60].includes(target.poll_interval_seconds)) return false;
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

export function counterDelta(prev, cur) {
  if (prev === null || prev === undefined || cur === null || cur === undefined) return null;
  if (!Number.isSafeInteger(prev) || !Number.isSafeInteger(cur) || prev < 0 || cur < 0) return null;
  if (cur >= prev) return cur - prev;
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

function sumDelta(a, b) {
  if (a === null || b === null) return null;
  return a + b;
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

function eventsForTarget(events, targetId) { return events.filter((event) => event.source_ref === targetId); }

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
