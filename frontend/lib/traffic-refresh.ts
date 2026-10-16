import { browserEventStream, type NetworkHealthEventStream, type NetworkHealthRealtimeStatus } from "./network-health-realtime.ts";

type Deferred = { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void };
function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** One physical read and at most one shared trailing read, including waiting callers. */
export class TrafficRefreshCoordinator<T> {
  private generation = 0;
  private disposed = false;
  private active: Deferred | null = null;
  private pending: Deferred | null = null;
  private readonly read: () => Promise<T>;
  private readonly apply: (value: T) => void;

  constructor(read: () => Promise<T>, apply: (value: T) => void) {
    this.read = read;
    this.apply = apply;
  }

  request(afterMutation = false): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Traffic refresh stopped"));
    if (afterMutation) this.generation += 1;
    this.pending ??= deferred();
    const promise = this.pending.promise;
    if (!this.active) void this.drain();
    return promise;
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    const error = new Error("Traffic refresh stopped");
    this.active?.reject(error);
    this.pending?.reject(error);
    this.pending = null;
  }

  private successor(): Deferred | null { return this.pending; }

  private async drain(): Promise<void> {
    while (!this.disposed && this.pending) {
      const current = this.pending;
      this.pending = null;
      this.active = current;
      const generation = this.generation;
      try {
        const value = await this.read();
        if (this.disposed) break;
        const successor = this.successor();
        if (generation === this.generation) {
          this.apply(value);
          current.resolve();
        } else if (successor) {
          // A mutation completed during this read: confirmation must await its successor.
          void successor.promise.then(current.resolve, current.reject);
        } else current.reject(new Error("Traffic refresh superseded"));
      } catch {
        current.reject(new Error("Traffic refresh failed"));
      } finally {
        this.active = null;
      }
    }
  }
}

export type TrafficRefreshTimers = {
  now: () => number;
  setTimeout: (callback: () => void, delay: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};
const timers: TrafficRefreshTimers = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Page-owned SSE + one mutually exclusive debounce/fallback/reconciliation timeout. */
export function startTrafficRefresh<T>(options: {
  read: () => Promise<T>;
  apply: (value: T) => void;
  isActive: () => boolean;
  diagnosticsRelevant: (key: string) => boolean;
  onStatus: (status: NetworkHealthRealtimeStatus) => void;
  visible: boolean;
  createEventStream?: (url: string) => NetworkHealthEventStream;
  timers?: TrafficRefreshTimers;
}) {
  const clock = options.timers ?? timers;
  const coordinator = new TrafficRefreshCoordinator(options.read, options.apply);
  let visible = options.visible;
  let disposed = false;
  let stream: NetworkHealthEventStream | null = null;
  let timer: unknown | null = null;
  let timerAt = Infinity;
  let connected = false;
  let failed = false;
  let dirty = false;
  let reads = 0;
  let lastStarted = -Infinity;
  // SSR is the initial seed. Connection sync reconciles after subscription is live,
  // including visibility resume (a read before connecting could miss a write).
  const fallbackDelay = () => options.isActive() ? 5_000 : 30_000;
  const clearTimer = () => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
    timerAt = Infinity;
  };
  const arm = (delay: number, keepEarlier = false) => {
    if (keepEarlier && timer !== null && timerAt <= clock.now() + delay) return;
    clearTimer();
    if (!visible || disposed || reads) return;
    timerAt = clock.now() + delay;
    timer = clock.setTimeout(() => { timer = null; timerAt = Infinity; void refresh(false).catch(() => {}); }, delay);
  };
  const settle = (keepEarlier = false) => {
    if (!visible || disposed || reads) return;
    if (dirty) arm(failed ? fallbackDelay() : 250, keepEarlier);
    else arm(connected && !failed ? 60_000 : fallbackDelay(), keepEarlier);
  };
  async function refresh(afterMutation: boolean): Promise<void> {
    if (disposed) throw new Error("Traffic refresh stopped");
    clearTimer();
    dirty = false;
    lastStarted = clock.now();
    reads += 1;
    try {
      await coordinator.request(afterMutation);
      failed = false;
    } catch {
      // Retain the last authoritative snapshot/heartbeat on transient failure.
      failed = true;
      throw new Error("Traffic refresh failed");
    } finally {
      reads -= 1;
      settle();
    }
  }
  const invalidate = () => {
    if (!visible || disposed) return;
    const alreadyDirty = dirty;
    dirty = true;
    if (!reads && !alreadyDirty) arm(Math.max(250, (failed ? fallbackDelay() : 250) - (clock.now() - lastStarted)));
  };
  const onOpen = () => {
    if (connected) return;
    connected = true;
    options.onStatus("connected");
    if (!dirty) settle(failed);
  };
  const onError = () => {
    const wasConnected = connected;
    connected = false;
    options.onStatus("fallback");
    if (wasConnected || timer === null) settle(true);
  };
  const onInvalidation = (event: Event) => {
    if (!("data" in event) || typeof event.data !== "string" || event.data.length > 1_024) return;
    try {
      const value: unknown = JSON.parse(event.data);
      if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 || !("topic" in value)) return;
      if (value.topic === "sync") {
        invalidate();
      } else if (value.topic === "traffic") invalidate();
      else if (value.topic === "diagnostics" && "aggregate_key" in value &&
          typeof value.aggregate_key === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value.aggregate_key) &&
          options.diagnosticsRelevant(value.aggregate_key)) invalidate();
    } catch { /* Malformed invalidations never become state or requests. */ }
  };
  const disconnect = () => {
    clearTimer();
    dirty = false;
    stream?.removeEventListener("open", onOpen);
    stream?.removeEventListener("error", onError);
    stream?.removeEventListener("invalidation", onInvalidation);
    stream?.close();
    stream = null;
    connected = false;
  };
  const connect = () => {
    options.onStatus("connecting");
    try {
      stream = (options.createEventStream ?? browserEventStream)("/api/realtime/events");
      stream.addEventListener("open", onOpen);
      stream.addEventListener("error", onError);
      stream.addEventListener("invalidation", onInvalidation);
    } catch { options.onStatus("fallback"); }
    settle();
  };
  if (visible) connect();
  return {
    confirmMutation: () => refresh(true),
    setVisible(next: boolean) {
      if (disposed || visible === next) return;
      visible = next;
      if (!visible) {
        disconnect();
        options.onStatus("fallback");
      } else {
        connect();
      }
    },
    dispose() {
      disposed = true;
      disconnect();
      coordinator.dispose();
    },
  };
}
