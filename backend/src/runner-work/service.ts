import type { RunnerWorkRepository } from "./repository.js";
import { performance } from "node:perf_hooks";
import { QUIET_WORK_WAIT_MS, WORK_MAINTENANCE_MS, WORK_QUERY_TIMEOUT_MS, WORK_WAIT_MS, type WorkKind } from "./contract.js";

export type WorkClock = {
  now: () => number;
  setTimeout: (callback: () => void, delay: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};
const systemClock: WorkClock = {
  now: () => performance.now(), setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
export class WorkWaitLimit extends Error {}
type Waiter = { wake: () => void };

export async function persistenceCall<T>(parent: AbortSignal, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(WORK_QUERY_TIMEOUT_MS)]);
  signal.throwIfAborted();
  let cancel!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(new Error("Work persistence unavailable"));
    signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    // Bound the HTTP wait even during a broken database connection. The
    // repository still owns transaction rollback/client release; its statement
    // timeout and the existing pool deadlines bound that cleanup separately.
    return await Promise.race([action(signal), cancelled]);
  } finally { signal.removeEventListener("abort", cancel); }
}

export class RunnerWorkService {
  private readonly listeners = new Set<(runnerId?: string) => void>();
  private readonly waiters = new Map<string, Waiter>();
  private readonly shutdown = new AbortController();
  private maintenanceTimer: unknown = null;
  private maintenance: Promise<void> | null = null;
  private started = false;

  constructor(
    private readonly repository: RunnerWorkRepository,
    private readonly clock: WorkClock = systemClock,
    private readonly waitMs = WORK_WAIT_MS,
    private readonly maximumWaiters = 32,
  ) {
    if (waitMs < 1 || waitMs > QUIET_WORK_WAIT_MS || !Number.isInteger(waitMs) ||
      maximumWaiters < 1 || maximumWaiters > 64 || !Number.isInteger(maximumWaiters)) throw new Error("Invalid work wait bounds");
  }

  start(onFailure: () => void): void {
    if (this.started || this.shutdown.signal.aborted) return;
    this.started = true;
    const pass = () => {
      this.maintenance = this.repository.recover(AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(WORK_QUERY_TIMEOUT_MS)]))
        .catch(() => { if (!this.shutdown.signal.aborted) onFailure(); })
        .finally(() => {
          this.maintenance = null;
          if (!this.shutdown.signal.aborted) this.maintenanceTimer = this.clock.setTimeout(pass, WORK_MAINTENANCE_MS);
        });
    };
    pass();
  }

  /** Hints only. Called after successful enqueue responses (repository COMMIT completed). */
  wake(runnerId?: string): void {
    for (const listener of this.listeners) listener(runnerId);
    if (runnerId) this.waiters.get(runnerId)?.wake();
    else for (const waiter of this.waiters.values()) waiter.wake();
  }

  subscribeWake(listener: (runnerId?: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async wait(runnerId: string, requestSignal: AbortSignal, waitMs = this.waitMs): Promise<{ runner_id: string; available: readonly WorkKind[]; timed_out: boolean }> {
    if (!Number.isInteger(waitMs) || waitMs < 1 || waitMs > QUIET_WORK_WAIT_MS) throw new Error("Invalid work wait bound");
    if (this.shutdown.signal.aborted) throw new Error("Work wait stopped");
    if (this.waiters.has(runnerId) || this.waiters.size >= this.maximumWaiters) throw new WorkWaitLimit();
    const signal = AbortSignal.any([requestSignal, this.shutdown.signal]);
    let revision = 0;
    let release: (() => void) | null = null;
    let wakeable = false;
    const waiter = { wake: () => { revision += 1; if (wakeable) release?.(); } };
    // Register BEFORE checking PostgreSQL, closing both pre-subscription and
    // enqueue-during-check races. No event can supply an assignment.
    this.waiters.set(runnerId, waiter);
    const deadline = this.clock.now() + waitMs;
    let timer: unknown = null;
    let nextCheck = 0;
    const aborted = () => release?.();
    signal.addEventListener("abort", aborted, { once: true });
    const pause = (delay: number, allowWake: boolean) => new Promise<void>((resolve) => {
      wakeable = allowWake;
      release = () => {
        if (timer !== null) this.clock.clearTimeout(timer);
        timer = null;
        release = null;
        wakeable = false;
        resolve();
      };
      timer = this.clock.setTimeout(() => release?.(), delay);
      if (signal.aborted) release();
    });
    try {
      for (;;) {
        signal.throwIfAborted();
        if (this.clock.now() < nextCheck) await pause(nextCheck - this.clock.now(), false);
        signal.throwIfAborted();
        const observed = revision;
        nextCheck = this.clock.now() + 100;
        const available = await persistenceCall(signal, (querySignal) => this.repository.available(runnerId, querySignal));
        signal.throwIfAborted();
        if (available.length) return { runner_id: runnerId, available, timed_out: false };
        const remaining = deadline - this.clock.now();
        if (remaining <= 0) return { runner_id: runnerId, available: [], timed_out: true };
        // Coalesce wake bursts and cap hint-driven queue reads at 10/second.
        if (observed !== revision) continue;
        // A lost/cross-process hint must not hide a 30s Ping lease behind a
        // 60s HTTP wait. Recheck durably without generating another HTTP request.
        await pause(Math.min(remaining, WORK_WAIT_MS), true);
      }
    } finally {
      if (timer !== null) this.clock.clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      this.waiters.delete(runnerId);
    }
  }

  async stop(): Promise<void> {
    this.shutdown.abort();
    if (this.maintenanceTimer !== null) this.clock.clearTimeout(this.maintenanceTimer);
    await this.maintenance;
  }

  get waiterCount(): number { return this.waiters.size; }
}
