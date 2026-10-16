export const FEEDBACK_SUCCESS_MS = 3_500;
export const FEEDBACK_MAX_VISIBLE = 4;
const MAX_RECENT_ATTEMPTS = 128;

export function appendFeedback<T>(current: readonly T[], item: T): T[] {
  return [...current.slice(-(FEEDBACK_MAX_VISIBLE - 1)), item];
}

/** Only an explicit opaque attempt/event ID is evidence of a duplicate. Memory is bounded. */
export class FeedbackAttempts {
  private seen = new Set<string>();
  accept(attemptId?: string): boolean {
    if (!attemptId || !/^[a-zA-Z0-9:_.-]{1,128}$/.test(attemptId)) return true;
    if (this.seen.has(attemptId)) return false;
    this.seen.add(attemptId);
    if (this.seen.size > MAX_RECENT_ATTEMPTS) this.seen.delete(this.seen.values().next().value!);
    return true;
  }
}

export type FeedbackClock = {
  now: () => number;
  schedule: (callback: () => void, delayMs: number) => () => void;
};
const browserClock: FeedbackClock = {
  now: () => performance.now(),
  schedule: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs);
    return () => clearTimeout(handle);
  },
};
type PauseReason = "hover" | "focus" | "swipe";

/** One toast's remaining visible time, preserved across rerenders and effect replay. */
export class FeedbackTimer {
  private remaining: number | null;
  private enabled = false;
  private finished = false;
  private reasons = new Set<PauseReason>();
  private startedAt: number | null = null;
  private cancelScheduled: (() => void) | null = null;
  private generation = 0;
  private expire: () => void;
  private clock: FeedbackClock;

  constructor(durationMs: number | null, expire: () => void, clock: FeedbackClock = browserClock) {
    this.remaining = durationMs;
    this.expire = expire;
    this.clock = clock;
  }
  start() { this.enabled = true; this.schedule(); }
  stop() { this.enabled = false; this.halt(); }
  pause(reason: PauseReason) { this.reasons.add(reason); this.halt(); }
  resume(reason: PauseReason) { this.reasons.delete(reason); this.schedule(); }
  private halt() {
    this.generation++;
    this.cancelScheduled?.();
    this.cancelScheduled = null;
    if (this.startedAt !== null && this.remaining !== null) {
      this.remaining = Math.max(0, this.remaining - (this.clock.now() - this.startedAt));
    }
    this.startedAt = null;
  }
  private schedule() {
    if (!this.enabled || this.finished || this.reasons.size || this.remaining === null || this.cancelScheduled) return;
    this.startedAt = this.clock.now();
    const generation = ++this.generation;
    this.cancelScheduled = this.clock.schedule(() => {
      if (generation !== this.generation || !this.enabled || this.reasons.size) return;
      this.cancelScheduled = null;
      this.startedAt = null;
      this.remaining = 0;
      this.finished = true;
      this.expire();
    }, this.remaining);
  }
}

/** Horizontal touch/pen gesture only. Vertical intent permanently cancels that gesture. */
export class FeedbackSwipe {
  private gesture: { id: number; x: number; y: number; vertical: boolean } | null = null;
  begin(id: number, x: number, y: number): boolean {
    if (this.gesture) { this.cancel(); return false; }
    this.gesture = { id, x, y, vertical: false };
    return true;
  }
  owns(id: number) { return this.gesture?.id === id; }
  move(id: number, x: number, y: number) {
    if (!this.gesture || !this.owns(id)) return;
    const dx = Math.abs(x - this.gesture.x), dy = Math.abs(y - this.gesture.y);
    if (dy > 8 && dy >= dx) this.gesture.vertical = true;
  }
  end(id: number, x: number, y: number): boolean {
    if (!this.gesture || !this.owns(id)) return false;
    this.move(id, x, y);
    const dx = Math.abs(x - this.gesture.x), dy = Math.abs(y - this.gesture.y);
    const dismiss = !this.gesture.vertical && dx >= 64 && dx > dy * 1.5;
    this.cancel();
    return dismiss;
  }
  cancel() { this.gesture = null; }
}
