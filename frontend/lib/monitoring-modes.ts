export const MONITORING_INTERVALS = [15, 30, 60, 900, 1800] as const;
export const DEFAULT_MONITORING_INTERVAL = 900;
export type MonitoringInterval = typeof MONITORING_INTERVALS[number];
export type MonitoringMode = "aggressive" | "moderate" | "resource_saver";
export function isMonitoringInterval(value: unknown): value is MonitoringInterval {
  return typeof value === "number" && MONITORING_INTERVALS.some((interval) => interval === value);
}
export function monitoringMode(interval: number): MonitoringMode | null {
  if (interval === 15 || interval === 30 || interval === 60) return "aggressive";
  if (interval === 900) return "moderate";
  return interval === 1800 ? "resource_saver" : null;
}
export function intervalForMode(mode: MonitoringMode, previousAggressive = 60): MonitoringInterval {
  if (mode === "moderate") return 900;
  if (mode === "resource_saver") return 1800;
  return previousAggressive === 15 || previousAggressive === 30 ? previousAggressive : 60;
}
