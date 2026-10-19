export type MonitoringRuntimeView = {
  state: "STANDBY" | "ACTIVATING" | "ACTIVE" | "DRAINING" | "DEGRADED";
  monitoring: boolean; control: "websocket" | "degraded";
};
export function isMonitoringLive(runtime: MonitoringRuntimeView | null): boolean {
  return runtime?.state === "ACTIVE" && runtime.monitoring === true && runtime.control === "websocket";
}
export function parseMonitoringRuntime(data: string): MonitoringRuntimeView | null {
  if (data.length > 512) return null;
  try {
    const value: unknown = JSON.parse(data);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (Object.keys(row).length !== 3 || !["STANDBY", "ACTIVATING", "ACTIVE", "DRAINING", "DEGRADED"].includes(String(row.state)) ||
      typeof row.monitoring !== "boolean" || !["websocket", "degraded"].includes(String(row.control))) return null;
    return row as MonitoringRuntimeView;
  } catch { return null; }
}
