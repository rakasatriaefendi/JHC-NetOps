export type MutationKind = "save" | "create" | "update" | "disable" | "reenable" | "delete" | "upload" | "remove" | "start" | "stop" | "ping";
export type FormMutationResult = Readonly<{ ok: boolean; changed?: boolean; code?: string }>;

/** Synchronous guard: unlike React state, it closes the same-tick double-click window. */
export class MutationGate {
  private pending = false;
  async run(operation: () => Promise<FormMutationResult>, feedback: (success: boolean, code?: string) => void): Promise<boolean> {
    if (this.pending) return false;
    this.pending = true;
    try {
      const result = await operation().catch((): FormMutationResult => ({ ok: false })); // Includes the required authoritative read.
      if (!result.ok) feedback(false, result.code);
      else if (result.changed !== false) feedback(true);
      return result.ok;
    } finally { this.pending = false; }
  }
}
