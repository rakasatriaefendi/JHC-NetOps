"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { isMonitoringLive, parseMonitoringRuntime, type MonitoringRuntimeView } from "@/lib/monitoring-runtime";

/** One visible-tab presence stream per protected layout, not per page/widget.
 * No polling: SSE disconnect/visibility releases the backend presence lease. */
const MonitoringRuntimeContext = createContext<MonitoringRuntimeView | null>(null);

export function useMonitoringRuntime() { return useContext(MonitoringRuntimeContext); }

export function MonitoringPresence({ children }: { children: ReactNode }) {
  const { t } = useTranslation("common");
  const [state, setState] = useState<MonitoringRuntimeView | null>(null);
  useEffect(() => {
    let stream: EventSource | null = null;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let disposed = false;
    const visibility = () => {
      stream?.close(); stream = null;
      clearTimeout(reconnect);
      if (document.visibilityState === "hidden") { setState(null); return; }
      const source = new EventSource("/api/realtime/presence");
      stream = source;
      source.addEventListener("runtime", (event) => {
        if (disposed || stream !== source || document.visibilityState === "hidden") return;
        const next = parseMonitoringRuntime((event as MessageEvent<string>).data);
        if (next) { failures = 0; setState(next); }
      });
      source.onerror = () => {
        if (disposed || stream !== source) return;
        stream?.close(); stream = null; setState(null);
        failures = Math.min(failures + 1, 6);
        if (!disposed && document.visibilityState !== "hidden") {
          reconnect = setTimeout(visibility, Math.min(30_000, 1000 * 2 ** (failures - 1)));
        }
      };
    };
    visibility(); document.addEventListener("visibilitychange", visibility);
    return () => { disposed = true; clearTimeout(reconnect); document.removeEventListener("visibilitychange", visibility); stream?.close(); };
  }, []);
  const active = isMonitoringLive(state);
  return <MonitoringRuntimeContext.Provider value={state}><aside role="status" className="border-b border-border bg-bg-surface px-4 py-2 text-meta text-text-secondary">
    <span className="font-medium text-text-primary">{t(`monitoringRuntime.${state?.state ?? "UNAVAILABLE"}`)}</span>
    {" · "}{t(active ? "monitoringRuntime.live" : "monitoringRuntime.notLive")}
    {" · "}{t(state?.control === "websocket" ? "monitoringRuntime.connected" : "monitoringRuntime.degraded")}
    {!active && <span className="ml-2">{t("monitoringRuntime.lastObservation")}</span>}
  </aside>{children}</MonitoringRuntimeContext.Provider>;
}
