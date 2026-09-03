export const PORTABLE_DEV_SCENARIOS = [
  "healthy",
  "partial",
  "alert_recovery",
  "large_observed_hosts",
] as const;

export type PortableDevScenario = (typeof PORTABLE_DEV_SCENARIOS)[number];
export type PortableEnvironment = Record<string, string | undefined>;

export type PortableDevConfig =
  | { enabled: false; scenario: null }
  | { enabled: true; scenario: PortableDevScenario };

export function portableDevConfig(
  environment: PortableEnvironment = process.env,
): PortableDevConfig {
  const requested = environment.PORTABLE_DEV_MODE?.trim().toLowerCase() === "true";
  if (environment.NODE_ENV !== "development" || !requested) {
    return { enabled: false, scenario: null };
  }
  const scenario = environment.PORTABLE_DEV_SCENARIO?.trim() || "healthy";
  if (!PORTABLE_DEV_SCENARIOS.includes(scenario as PortableDevScenario)) {
    throw new Error("PORTABLE_DEV_SCENARIO_INVALID");
  }
  return { enabled: true, scenario: scenario as PortableDevScenario };
}

export function portableDevMode(environment: PortableEnvironment = process.env): boolean {
  return portableDevConfig(environment).enabled;
}
