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

export type NetworkHealthRealtimeOptions = Readonly<{
  refresh: () => void;
  onStatus: (status: NetworkHealthRealtimeStatus) => void;
  createEventStream?: (url: string) => NetworkHealthEventStream;
  timers?: NetworkHealthRealtimeTimers;
}>;

const SYSTEM_TIMERS: NetworkHealthRealtimeTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export function startNetworkHealthRealtime(options: NetworkHealthRealtimeOptions): () => void {
  const timers = options.timers ?? SYSTEM_TIMERS;
  let disposed = false;
  let refreshTimer: unknown | null = null;
  let fallbackTimer: unknown | null = null;
  let stream: NetworkHealthEventStream | null = null;

  const scheduleRefresh = () => {
    if (disposed || refreshTimer !== null) return;
    refreshTimer = timers.setTimeout(() => {
      refreshTimer = null;
      if (!disposed) options.refresh();
    }, NETWORK_HEALTH_REALTIME_DEBOUNCE_MS);
  };
  const stopFallback = () => {
    if (fallbackTimer === null) return;
    timers.clearInterval(fallbackTimer);
    fallbackTimer = null;
  };
  const startFallback = () => {
    if (disposed) return;
    options.onStatus("fallback");
    if (fallbackTimer !== null) return;
    fallbackTimer = timers.setInterval(scheduleRefresh, NETWORK_HEALTH_FALLBACK_INTERVAL_MS);
  };
  const onOpen = () => {
    if (disposed) return;
    stopFallback();
    options.onStatus("connected");
  };
  const onError = () => startFallback();
  const onInvalidation = (event: Event) => {
    const topic = invalidationTopic(event);
    if (topic === "sync" || topic === "network_health") scheduleRefresh();
  };

  options.onStatus("connecting");
  try {
    stream = (options.createEventStream ?? browserEventStream)("/api/realtime/events");
    stream.addEventListener("open", onOpen);
    stream.addEventListener("error", onError);
    stream.addEventListener("invalidation", onInvalidation);
  } catch {
    startFallback();
  }

  return () => {
    if (disposed) return;
    disposed = true;
    if (refreshTimer !== null) timers.clearTimeout(refreshTimer);
    refreshTimer = null;
    stopFallback();
    stream?.removeEventListener("open", onOpen);
    stream?.removeEventListener("error", onError);
    stream?.removeEventListener("invalidation", onInvalidation);
    stream?.close();
    stream = null;
  };
}

function invalidationTopic(event: Event): "sync" | "network_health" | null {
  if (!("data" in event) || typeof event.data !== "string" || event.data.length > 1_024) return null;
  try {
    const value: unknown = JSON.parse(event.data);
    if (!record(value) || value.version !== 1) return null;
    return value.topic === "sync" || value.topic === "network_health" ? value.topic : null;
  } catch {
    return null;
  }
}

function browserEventStream(url: string): NetworkHealthEventStream {
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
