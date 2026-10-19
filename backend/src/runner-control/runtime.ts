export type RuntimeState = "STANDBY" | "ACTIVATING" | "ACTIVE" | "DRAINING" | "DEGRADED";
export type RuntimeSnapshot = Readonly<{
  state: RuntimeState; monitoring: boolean; control: "websocket" | "degraded";
}>;

/** Process-local policy, never a job queue. Restart is fail-closed (no presence).
 * Presence handles are created ONLY by the authenticated streaming route. */
export class MonitoringRuntime {
  private readonly presence = new Set<symbol>();
  private readonly listeners = new Set<() => void>();
  private lastPresenceAt: number;
  private connected = 0;
  private ready = false;
  private acknowledged = false;
  private busy = false;
  private uncertain = true;
  private revision = 0;
  private lastMonitoring = false;
  constructor(private readonly graceMs = 30_000, private readonly now = Date.now) {
    if (!Number.isInteger(graceMs) || graceMs < 0 || graceMs > 300_000) throw new Error("Invalid standby grace");
    this.lastPresenceAt = now() - graceMs;
  }
  enter(): () => void {
    const id = Symbol(); this.presence.add(id); this.changed();
    let closed = false;
    return () => { if (closed) return; closed = true; this.presence.delete(id); this.lastPresenceAt = this.now(); this.changed(); };
  }
  connection(delta: number): void { this.connected = Math.max(0, this.connected + delta); this.changed(); }
  evidence(busy: boolean, ready: boolean, uncertain: boolean, acknowledged = true): void {
    this.refreshPolicy();
    this.busy = busy; this.ready = ready; this.uncertain = uncertain; this.acknowledged = acknowledged; this.changed();
  }
  snapshot(): RuntimeSnapshot {
    this.refreshPolicy();
    const monitoring = this.lastMonitoring;
    const degraded = this.connected === 0 || this.uncertain;
    const state: RuntimeState = degraded ? "DEGRADED" : monitoring ? (this.ready ? "ACTIVE" : "ACTIVATING")
      : this.busy || !this.acknowledged ? "DRAINING" : "STANDBY";
    return { state, monitoring, control: degraded ? "degraded" : "websocket" };
  }
  get policyRevision(): number {
    return this.refreshPolicy();
  }
  private refreshPolicy(): number {
    const monitoring = this.presence.size > 0 || this.now() - this.lastPresenceAt < this.graceMs;
    if (monitoring !== this.lastMonitoring) {
      this.lastMonitoring = monitoring; this.revision++; this.ready = false; this.acknowledged = false;
    }
    return this.revision;
  }
  subscribe(listener: () => void): () => void {
    if (this.listeners.size >= 320) throw new Error("Runtime subscriber limit");
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  private changed(): void { for (const listener of this.listeners) listener(); }
}
