export const MONITORING_INTERVALS = Object.freeze([15, 30, 60, 900, 1800]);
export function isMonitoringInterval(value) {
  return Number.isSafeInteger(value) && MONITORING_INTERVALS.includes(value);
}
