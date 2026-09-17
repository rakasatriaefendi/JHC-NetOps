export const P13_CHECKPOINTS = Object.freeze([
  "CHECKPOINT_0_PRE_FREEZE",
  "CHECKPOINT_1_FINAL_SOURCE_CAPTURED",
  "CHECKPOINT_2_LOCAL_IMPORTED_VERIFIED",
  "CHECKPOINT_3_LOCAL_ARMED_NO_WRITES",
] as const);

export type P13Checkpoint = (typeof P13_CHECKPOINTS)[number];
export type P13RollbackDisposition = "SIMPLE_PRE_AUTHORITY_ROLLBACK" | "COORDINATED_REVERSE_SWITCH" | "RECONCILIATION_REQUIRED";

export type P13RollbackAssessment = Readonly<{
  eligible: boolean;
  disposition: P13RollbackDisposition;
  reason: string;
}>;

export class P13CheckpointError extends Error {
  readonly code = "P13_CHECKPOINT_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "P13CheckpointError";
  }
}

export function assertP13CheckpointTransition(current: P13Checkpoint, next: P13Checkpoint): void {
  const currentIndex = P13_CHECKPOINTS.indexOf(current);
  const nextIndex = P13_CHECKPOINTS.indexOf(next);
  if (currentIndex < 0 || nextIndex !== currentIndex + 1) {
    throw new P13CheckpointError("P13 checkpoint transition must advance exactly one reviewed stage");
  }
}

export function assessP13Rollback(options: Readonly<{
  checkpoint: P13Checkpoint;
  local_authoritative_write_count: number;
  local_writers_frozen: boolean;
  all_local_writes_projected: boolean;
  shadow_parity_verified: boolean;
}>): P13RollbackAssessment {
  if (!P13_CHECKPOINTS.includes(options.checkpoint) ||
      !Number.isSafeInteger(options.local_authoritative_write_count) || options.local_authoritative_write_count < 0) {
    throw new P13CheckpointError("P13 rollback evidence is invalid");
  }
  if (options.checkpoint !== "CHECKPOINT_3_LOCAL_ARMED_NO_WRITES" || options.local_authoritative_write_count === 0) {
    return Object.freeze({
      eligible: true,
      disposition: "SIMPLE_PRE_AUTHORITY_ROLLBACK",
      reason: "Supabase remains authoritative or local authority has accepted no writes",
    });
  }
  if (options.local_writers_frozen && options.all_local_writes_projected && options.shadow_parity_verified) {
    return Object.freeze({
      eligible: true,
      disposition: "COORDINATED_REVERSE_SWITCH",
      reason: "Local writers are frozen and every authoritative local change is projected and parity-verified",
    });
  }
  return Object.freeze({
    eligible: false,
    disposition: "RECONCILIATION_REQUIRED",
    reason: "Authoritative local-only writes make an unverified authority reversal lossy",
  });
}
