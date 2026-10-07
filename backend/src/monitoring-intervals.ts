export const MONITORING_INTERVALS = [15, 30, 60, 900, 1800] as const;
export type MonitoringInterval = typeof MONITORING_INTERVALS[number];
export function isMonitoringInterval(value: unknown): value is MonitoringInterval {
  return typeof value === "number" && MONITORING_INTERVALS.some((interval) => interval === value);
}
