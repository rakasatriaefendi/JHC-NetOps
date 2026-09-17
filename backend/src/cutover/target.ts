import { P13_CHECKPOINTS, type P13Checkpoint } from "./checkpoint.js";

export const P13_ACTIONS = Object.freeze([
  "preflight", "freeze-check", "capture-final", "import-final",
  "verify-final", "pre-cutover-verify", "arm-local-authority", "postflight",
  "post-cutover-verify", "rollback-check",
] as const);

export type P13Action = (typeof P13_ACTIONS)[number];

export type P13Target = Readonly<{
  phase: "P13";
  action: P13Action;
  cluster: "16/jhcnetops";
  port: 5433;
  database: "jhc_netops";
  role: "jhc_netops_owner" | "jhc_netops_app";
  source_checkpoint_identity: string;
  database_url: string;
}>;

export class P13TargetError extends Error {
  readonly code = "P13_TARGET_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "P13TargetError";
  }
}

export function loadP13Target(action: P13Action, environment: Readonly<Record<string, string | undefined>>): P13Target {
  if (!P13_ACTIONS.includes(action)) throw new P13TargetError("P13 action is invalid");
  if (Object.entries(environment).some(([key, value]) => key.startsWith("P12_") && Boolean(value?.trim()))) {
    throw new P13TargetError("P12 rehearsal variables cannot authorize a P13 production action");
  }
  const phase = environment.P13_PHASE?.trim();
  const configuredAction = environment.P13_ACTION?.trim();
  const cluster = environment.P13_EXPECTED_CLUSTER?.trim();
  const port = environment.P13_EXPECTED_PORT?.trim();
  const database = environment.P13_EXPECTED_DATABASE?.trim();
  const role = environment.P13_EXPECTED_ROLE?.trim();
  const sourceCheckpoint = environment.P13_SOURCE_CHECKPOINT_IDENTITY?.trim();
  const acknowledgement = environment.P13_OPERATOR_ACK?.trim();
  if (phase !== "P13" || configuredAction !== action) throw new P13TargetError("P13 phase/action acknowledgement is invalid");
  if (cluster !== "16/jhcnetops" || port !== "5433" || database !== "jhc_netops") {
    throw new P13TargetError("P13 target must be 16/jhcnetops on port 5433 database jhc_netops");
  }
  if (role !== "jhc_netops_owner" && role !== "jhc_netops_app") throw new P13TargetError("P13 expected role is invalid");
  if (action === "import-final" && role !== "jhc_netops_owner") {
    throw new P13TargetError("P13 final import requires the explicit jhc_netops_owner role");
  }
  if (["verify-final", "pre-cutover-verify", "postflight", "post-cutover-verify"].includes(action) && role !== "jhc_netops_app") {
    throw new P13TargetError(`P13 ${action} requires the explicit jhc_netops_app role`);
  }
  if (!/^[0-9a-f]{64}$/.test(sourceCheckpoint ?? "")) throw new P13TargetError("P13 source checkpoint identity is invalid");
  if (acknowledgement !== acknowledgementFor(action, sourceCheckpoint!)) {
    throw new P13TargetError("P13 operator acknowledgement does not match the exact action and checkpoint");
  }
  const databaseUrl = validateProductionUrl(environment.P13_DATABASE_URL, role);
  return Object.freeze({
    phase: "P13",
    action,
    cluster: "16/jhcnetops",
    port: 5433,
    database: "jhc_netops",
    role,
    source_checkpoint_identity: sourceCheckpoint!,
    database_url: databaseUrl,
  });
}

export function acknowledgementFor(action: P13Action, sourceCheckpointIdentity: string): string {
  return `P13:${action}:jhc_netops:${sourceCheckpointIdentity}`;
}

export function publicP13Target(target: P13Target): Readonly<Omit<P13Target, "database_url">> {
  return Object.freeze({
    phase: target.phase,
    action: target.action,
    cluster: target.cluster,
    port: target.port,
    database: target.database,
    role: target.role,
    source_checkpoint_identity: target.source_checkpoint_identity,
  });
}

export function assertCheckpoint(value: string): asserts value is P13Checkpoint {
  if (!P13_CHECKPOINTS.includes(value as P13Checkpoint)) throw new P13TargetError("P13 checkpoint name is invalid");
}

function validateProductionUrl(value: string | undefined, role: P13Target["role"]): string {
  try {
    if (!value || value.length > 4096) throw new Error("invalid");
    const url = new URL(value);
    if (url.protocol !== "postgresql:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
        url.port !== "5433" || url.pathname !== "/jhc_netops" || url.username !== role || !url.password ||
        url.search || url.hash) throw new Error("invalid");
    return value;
  } catch {
    throw new P13TargetError("P13 database URL does not match the explicit dedicated production target");
  }
}
