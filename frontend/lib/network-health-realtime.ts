export const NETWORK_HEALTH_REALTIME_DEBOUNCE_MS = 250;
export const NETWORK_HEALTH_FALLBACK_INTERVAL_MS = 60_000;

export type NetworkHealthRealtimeStatus = "connecting" | "connected" | "fallback";

export type NetworkHealthEventStream = Readonly<{
  addEventListener: (type: "open" | "error" | "invalidation", listener: (event: Event) => void) => void;
  removeEventListener: (type: "open" | "error" | "invalidation", listener: (event: Event) => void) => void;
  close: () => void;
}>;

export type NetworkHealthRealtimeTimers = Readonly<{
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  setInterval: (callback: () => void, delayMs: number) => unknown;
  clearInterval: (handle: unknown) => void;
}>;

export type RealtimeVisibility = Readonly<{
  visible: () => boolean;
  subscribe: (listener: () => void) => () => void;
}>;

export type NetworkHealthRealtimeOptions = Readonly<{
  refresh: () => void | Promise<void>;
  onStatus: (status: NetworkHealthRealtimeStatus) => void;
  createEventStream?: (url: string) => NetworkHealthEventStream;
  timers?: NetworkHealthRealtimeTimers;
  visibility?: RealtimeVisibility;
}>;

export type LocalRealtimeTopic = "network_health" | "diagnostics" | "device_inspector" | "traffic" | "managed_telemetry";

export type LocalRealtimeInvalidationOptions = Readonly<{
  topics: readonly LocalRealtimeTopic[];
  refresh: () => void | Promise<void>;
  onStatus: (status: NetworkHealthRealtimeStatus) => void;
  debounceMs: number;
  fallbackIntervalMs: number;
  createEventStream?: (url: string) => NetworkHealthEventStream;
  timers?: NetworkHealthRealtimeTimers;
  visibility?: RealtimeVisibility;
}>;

const SYSTEM_TIMERS: NetworkHealthRealtimeTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export function startNetworkHealthRealtime(options: NetworkHealthRealtimeOptions): () => void {
  return startLocalRealtimeInvalidation({
    ...options,
    topics: ["network_health"],
    debounceMs: NETWORK_HEALTH_REALTIME_DEBOUNCE_MS,
    fallbackIntervalMs: NETWORK_HEALTH_FALLBACK_INTERVAL_MS,
  });
}

export function startLocalRealtimeInvalidation(options: LocalRealtimeInvalidationOptions): () => void {
  const timers = options.timers ?? SYSTEM_TIMERS;
  const visibility = options.visibility ?? browserVisibility();
  let visible = visibility.visible();
  const topics = new Set(options.topics);
  let disposed = false;
  let refreshTimer: unknown | null = null;
  let fallbackTimer: unknown | null = null;
  let stream: NetworkHealthEventStream | null = null;
  let refreshing = false;
  let refreshAgain = false;

  const scheduleRefresh = () => {
    if (disposed || !visible) return;
    if (refreshing) { refreshAgain = true; return; }
    if (refreshTimer !== null) return;
    refreshTimer = timers.setTimeout(() => {
      refreshTimer = null;
      if (disposed || !visible) return;
      refreshing = true;
      const finish = () => {
        refreshing = false;
        if (refreshAgain) { refreshAgain = false; scheduleRefresh(); }
      };
      try {
        const pending = options.refresh();
        if (pending) void pending.catch(() => {}).finally(finish);
        else finish();
      } catch {
        finish();
      }
    }, options.debounceMs);
  };
  const stopFallback = () => {
    if (fallbackTimer === null) return;
    timers.clearInterval(fallbackTimer);
    fallbackTimer = null;
  };
  const startFallback = () => {
    if (disposed || !visible) return;
    options.onStatus("fallback");
    if (fallbackTimer !== null) return;
    fallbackTimer = timers.setInterval(scheduleRefresh, options.fallbackIntervalMs);
  };
  const onOpen = () => {
    if (disposed || !visible) return;
    stopFallback();
    options.onStatus("connected");
  };
  const onError = () => startFallback();
  const onInvalidation = (event: Event) => {
    const topic = invalidationTopic(event);
    if (topic === "sync" || (topic !== null && topics.has(topic))) scheduleRefresh();
  };

  const closeStream = () => {
    stream?.removeEventListener("open", onOpen);
    stream?.removeEventListener("error", onError);
    stream?.removeEventListener("invalidation", onInvalidation);
    stream?.close();
    stream = null;
  };
  const openStream = () => {
    options.onStatus("connecting");
    try {
      stream = (options.createEventStream ?? browserEventStream)("/api/realtime/events");
      stream.addEventListener("open", onOpen);
      stream.addEventListener("error", onError);
      stream.addEventListener("invalidation", onInvalidation);
    } catch { startFallback(); }
  };
  const onVisibility = () => {
    const next = visibility.visible();
    if (disposed || next === visible) return;
    visible = next;
    if (!visible) {
      if (refreshTimer !== null) timers.clearTimeout(refreshTimer);
      refreshTimer = null;
      refreshAgain = false;
      stopFallback();
      closeStream();
      options.onStatus("connecting");
    } else {
      openStream();
      scheduleRefresh(); // Reconcile changes missed while hidden, even if SSE is unavailable.
    }
  };
  if (visible) openStream();
  else options.onStatus("connecting");
  const stopVisibility = visibility.subscribe(onVisibility);

  return () => {
    if (disposed) return;
    disposed = true;
    stopVisibility();
    if (refreshTimer !== null) timers.clearTimeout(refreshTimer);
    refreshTimer = null;
    stopFallback();
    closeStream();
  };
}

function browserVisibility(): RealtimeVisibility {
  if (typeof document === "undefined") return { visible: () => true, subscribe: () => () => {} };
  return {
    visible: () => document.visibilityState !== "hidden",
    subscribe: (listener) => {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
  };
}

function invalidationTopic(event: Event): "sync" | LocalRealtimeTopic | null {
  if (!("data" in event) || typeof event.data !== "string" || event.data.length > 1_024) return null;
  try {
    const value: unknown = JSON.parse(event.data);
    if (!record(value) || value.version !== 1) return null;
    return value.topic === "sync" || value.topic === "network_health" || value.topic === "diagnostics" ||
      value.topic === "device_inspector" || value.topic === "traffic" || value.topic === "managed_telemetry"
      ? value.topic : null;
  } catch {
    return null;
  }
}

export function browserEventStream(url: string): NetworkHealthEventStream {
  const source = new EventSource(url);
  return {
    addEventListener: (type, listener) => source.addEventListener(type, listener),
    removeEventListener: (type, listener) => source.removeEventListener(type, listener),
    close: () => source.close(),
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
