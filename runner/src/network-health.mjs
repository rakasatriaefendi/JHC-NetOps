import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { resolvePlatform } from "./platform.mjs";

const PING_EXE = "C:\\Windows\\System32\\PING.EXE";
const WINDOW_SIZE = 5;
const PUBLISH_INTERVAL_MS = 60_000;
const TARGET_REFRESH_MS = 60_000;
const MAX_BACKOFF_MS = 60_000;
// PING.EXE -w only bounds ICMP reply waiting. Windows neighbor resolution can
// otherwise keep the child alive for seconds, so the runner owns this grace.
export const PING_PROCESS_STARTUP_GRACE_MS = 250;

export class NetworkHealthWatch {
  constructor({ runnerId, backend, cachePath, ping, platform = process.platform, log = () => {}, now = () => Date.now(), concurrency = 4 }) {
    this.runnerId = runnerId;
    this.backend = backend;
    this.cachePath = cachePath;
    this.platform = resolvePlatform(platform);
    this.ping = ping ?? ((ipAddress, timeoutMs, signal) => pingTarget(ipAddress, timeoutMs, signal, spawn, this.platform));
    this.log = log;
    this.now = now;
    this.concurrency = concurrency;
    const cache = loadCache(cachePath);
    const cachedTargets = Array.isArray(cache.cachedTargets) ? cache.cachedTargets.filter(validTarget) : [];
    this.targets = new Map(cachedTargets.map((target) => [target.id, target]));
    this.states = cache.states && typeof cache.states === "object" ? cache.states : {};
    this.pendingTransitions = Array.isArray(cache.pendingTransitions) ? cache.pendingTransitions : [];
    this.inFlight = new Map();
    this.timer = null;
    this.running = false;
    this.refreshDueAt = 0;
    this.publishDueAt = 0;
    this.publishBackoffMs = 5_000;
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
        this.pendingTransitions.length === 0 && this.backend.monitoringIdle?.("health", now) === true;
      if (now >= this.refreshDueAt && !quiet) await this.refreshTargets(now);
      const capacity = Math.max(0, this.concurrency - this.inFlight.size);
      const due = [...this.targets.values()].filter((target) => {
        const state = this.stateFor(target.id);
        return !this.inFlight.has(target.id) && now >= (state.nextProbeAt ?? 0);
      }).slice(0, capacity);
      for (const target of due) void this.probe(target);
      if ((this.pendingTransitions.length || now >= this.publishDueAt) && now >= (this.retryAt ?? 0)) await this.publish(now);
    } finally { this.ticking = false; }
  }

  async refreshTargets(now = this.now()) {
    try {
      const result = await this.backend.healthTargets(this.runnerId);
      const targets = Array.isArray(result?.targets) ? result.targets.filter(validTarget) : [];
      for (const target of targets) {
        const old = this.targets.get(target.id);
        const state = this.states[target.id];
        const lastProbeAt = Date.parse(state?.lastCheckedAt);
        if (old && old.probe_interval_seconds !== target.probe_interval_seconds && Number.isFinite(lastProbeAt)) {
          state.nextProbeAt = lastProbeAt + target.probe_interval_seconds * 1000;
        }
      }
      this.targets = new Map(targets.map((target) => [target.id, target]));
      for (const id of Object.keys(this.states)) if (!this.targets.has(id)) delete this.states[id];
      this.pendingTransitions = this.pendingTransitions.filter((event) => this.targets.has(event.target_id));
      this.refreshDueAt = now + TARGET_REFRESH_MS;
      this.persist();
    } catch {
      this.refreshDueAt = now + 10_000;
      this.log("Network health target refresh failed; cached targets retained");
    }
  }

  async probe(target) {
    const controller = new AbortController();
    this.inFlight.set(target.id, controller);
    try {
      const result = await this.ping(target.ip_address, target.timeout_ms, controller.signal);
      this.applySample(target, result, this.now());
    } catch {
      if (!controller.signal.aborted) this.applySample(target, { success: false, latency_ms: null }, this.now());
    } finally { this.inFlight.delete(target.id); }
  }

  async manualPing(targetId) {
    const result = await this.backend.healthTargets(this.runnerId);
    const target = Array.isArray(result?.targets)
      ? result.targets.filter(validTarget).find((item) => item.id === targetId)
      : null;
    if (!target) {
      const error = new Error("Manual ping target is unavailable");
      error.code = "MANUAL_PING_TARGET_UNAVAILABLE";
      throw error;
    }
    const sample = await this.ping(target.ip_address, target.timeout_ms);
    if (sample.success) {
      if (!Number.isFinite(sample.latency_ms) || sample.latency_ms < 0) {
        const error = new Error("Manual ping result is invalid");
        error.code = "MANUAL_PING_FAILED";
        throw error;
      }
      return { ok: true, latency_ms: sample.latency_ms };
    }
    return { ok: false, category: sample.timed_out ? "timeout" : "unreachable" };
  }

  applySample(target, sample, now = this.now()) {
    const state = this.stateFor(target.id);
    const checkedAt = new Date(now).toISOString();
    state.samples = [...state.samples, Boolean(sample.success)].slice(-WINDOW_SIZE);
    state.latencies = [...state.latencies, sample.success ? sample.latency_ms : null].slice(-WINDOW_SIZE);
    state.consecutiveFailures = sample.success ? 0 : state.consecutiveFailures + 1;
    state.consecutiveSuccesses = sample.success ? state.consecutiveSuccesses + 1 : 0;
    state.lastCheckedAt = checkedAt;
    if (sample.success) state.lastSuccessAt = checkedAt;
    const previous = state.status ?? null;
    if (sample.success && previous === "offline" && state.consecutiveSuccesses >= target.recovery_threshold) {
      state.samples = state.samples.slice(-target.recovery_threshold);
      state.latencies = state.latencies.slice(-target.recovery_threshold);
    }
    const successes = state.samples.filter(Boolean).length;
    const loss = state.samples.length ? (state.samples.length - successes) / state.samples.length * 100 : 100;
    const latencies = state.latencies.filter((value) => typeof value === "number");
    const latency = latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : null;
    const unhealthy = (latency !== null && latency >= target.latency_warning_ms) || loss >= Number(target.loss_warning_percent);
    let next;
    if (!sample.success) next = state.consecutiveFailures >= target.failure_threshold ? "offline" : "degraded";
    else if (previous === "offline" && state.consecutiveSuccesses < target.recovery_threshold) next = "offline";
    else if (unhealthy) next = "degraded";
    else if (previous === "degraded" && state.consecutiveSuccesses < target.recovery_threshold) next = "degraded";
    else next = "online";
    state.status = next;
    state.latencyMs = latency;
    state.packetLossPercent = loss;
    state.dirty = true;
    const scheduledTarget = this.targets.get(target.id) ?? target;
    state.nextProbeAt = now + scheduledTarget.probe_interval_seconds * 1000;
    if (!previous) this.publishDueAt = 0;
    if (previous && previous !== next) {
      this.pendingTransitions.push({ event_id: randomUUID(), target_id: target.id, previous_status: previous,
        new_status: next, occurred_at: checkedAt, latency_ms: latency, packet_loss_percent: loss,
        consecutive_failures: state.consecutiveFailures });
      this.pendingTransitions = this.pendingTransitions.slice(-100);
      this.publishDueAt = 0;
    }
    this.persist();
  }

  async publish(now = this.now()) {
    const states = [...this.targets.keys()].map((id) => this.states[id]).filter((state) => state?.dirty).map(publicState);
    if (!states.length && !this.pendingTransitions.length) { this.publishDueAt = now + PUBLISH_INTERVAL_MS; return; }
    const transitions = this.pendingTransitions.slice(0, 100);
    try {
      await this.backend.publishHealth(this.runnerId, states, transitions);
      for (const state of Object.values(this.states)) if (state) state.dirty = false;
      this.pendingTransitions.splice(0, transitions.length);
      this.publishBackoffMs = 5_000;
      this.retryAt = 0;
      this.publishDueAt = now + PUBLISH_INTERVAL_MS;
      this.persist();
    } catch {
      this.retryAt = now + this.publishBackoffMs;
      this.publishBackoffMs = Math.min(MAX_BACKOFF_MS, this.publishBackoffMs * 2);
      this.log("Network health publish failed; latest state and transitions retained locally");
      this.persist();
    }
  }

  stateFor(id) {
    const state = this.states[id] ??= { samples: [], latencies: [], consecutiveFailures: 0, consecutiveSuccesses: 0, dirty: false, nextProbeAt: 0 };
    state.targetId = id;
    return state;
  }

  persist() { saveCache(this.cachePath, { version: 1, cachedTargets: [...this.targets.values()], states: this.states, pendingTransitions: this.pendingTransitions }); }
}

export function pingTarget(ipAddress, timeoutMs, signal, spawnProcess = spawn, platform = process.platform) {
  let invocation;
  try { invocation = buildPingInvocation(ipAddress, timeoutMs, platform); }
  catch (error) { return Promise.reject(error); }
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const child = spawnProcess(invocation.executable, invocation.args, invocation.options);
    let wallTimer;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(wallTimer);
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => {
      child.kill();
      finish(() => reject(new Error("Ping cancelled")));
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => { if (output.length < 16_384) output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { if (output.length < 16_384) output += chunk.toString(); });
    child.once("error", () => finish(() => reject(new Error("Ping process failed"))));
    child.once("close", (code) => {
      finish(() => resolve(normalizePingResult(output, code)));
    });
    wallTimer = setTimeout(() => {
      child.kill();
      finish(() => resolve({ success: false, latency_ms: null, packet_loss_percent: 100, timed_out: true }));
    }, pingProcessWallTimeout(timeoutMs));
    if (signal?.aborted) abort();
  });
}

export function pingProcessWallTimeout(timeoutMs) {
  return timeoutMs + PING_PROCESS_STARTUP_GRACE_MS;
}

export function buildPingInvocation(ipAddress, timeoutMs, platform = process.platform) {
  if (!isIP(ipAddress) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 5000) throw new Error("Invalid health ping parameters");
  const runtimePlatform = resolvePlatform(platform);
  const family = isIP(ipAddress) === 6 ? "-6" : "-4";
  if (runtimePlatform === "win32") {
    return { executable: PING_EXE, args: [family, "-n", "1", "-w", String(timeoutMs), ipAddress],
      options: { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] } };
  }
  // An IP literal already fixes the family. GNU inetutils ping (an Ubuntu
  // alternative to iputils) is IPv4-only and rejects iputils' -4 flag.
  const linuxFamilyArgs = family === "-6" ? [family] : [];
  return { executable: "ping", args: [...linuxFamilyArgs, "-n", "-c", "1", "-W", String(Math.max(1, Math.ceil(timeoutMs / 1000))), ipAddress],
    options: { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LANG: "C", LC_ALL: "C" } } };
}

export function normalizePingResult(output, exitCode) {
  const text = typeof output === "string" ? output.slice(0, 16_384) : "";
  const lossMatch = text.match(/(\d+(?:[.,]\d+)?)%\s*(?:packet\s+)?loss/i);
  const summaryMatch = text.match(/(?:rtt|round-trip)[^=\r\n]*=\s*\d+(?:[.,]\d+)?\/(\d+(?:[.,]\d+)?)\//i);
  const directMatch = text.match(/(?:time[=<]|Average\s*=\s*)(\d+(?:[.,]\d+)?)\s*ms/i);
  const latency = parsePingNumber(summaryMatch?.[1] ?? directMatch?.[1]);
  const parsedLoss = parsePingNumber(lossMatch?.[1]);
  const observedLoss = parsedLoss ?? (latency !== null ? 0 : 100);
  const success = exitCode === 0 && latency !== null && observedLoss < 100;
  return {
    success,
    latency_ms: success ? latency : null,
    packet_loss_percent: exitCode === 0 ? observedLoss : 100,
  };
}

export function manualPingCompletionLog(jobId, targetId, result) {
  const reachable = result?.ok === true;
  const latency = reachable && Number.isFinite(result.latency_ms)
    ? Number(result.latency_ms).toFixed(3)
    : "null";
  return `Manual ping ${jobId} completed for Health target ${targetId}: reachable=${reachable} loss=${reachable ? 0 : 100} latency_ms=${latency}`;
}

function parsePingNumber(value) {
  if (typeof value !== "string") return null;
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function publicState(state) {
  return { target_id: state.targetId, status: state.status, latency_ms: state.latencyMs,
    packet_loss_percent: state.packetLossPercent, last_checked_at: state.lastCheckedAt,
    last_success_at: state.lastSuccessAt ?? null, consecutive_failures: state.consecutiveFailures,
    sample_count: state.samples.length };
}
function validTarget(target) {
  return target && typeof target.id === "string" && isIP(target.ip_address) && target.probe_method === "icmp"
    // Legacy custom Health intervals stay readable/runnable; new writes use presets.
    && Number.isInteger(target.probe_interval_seconds) && target.probe_interval_seconds >= 15 && target.probe_interval_seconds <= 3600
    && Number.isInteger(target.timeout_ms);
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
