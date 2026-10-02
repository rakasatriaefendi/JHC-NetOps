import type { LocalRealtimeInvalidation } from "./contract.js";

export type RealtimeSubscriber = Readonly<{
  send: (event: LocalRealtimeInvalidation) => boolean;
  close: () => void;
}>;

export class LocalRealtimeBroker {
  private readonly subscribers = new Map<number, RealtimeSubscriber>();
  private nextSubscriberId = 1;
  private closed = false;

  constructor(private readonly maximumSubscribers = 64) {
    if (!Number.isSafeInteger(maximumSubscribers) || maximumSubscribers < 1 || maximumSubscribers > 256) {
      throw new Error("Realtime subscriber bound is invalid");
    }
  }

  subscribe(subscriber: RealtimeSubscriber): (() => void) | null {
    if (this.closed || this.subscribers.size >= this.maximumSubscribers) return null;
    const id = this.nextSubscriberId++;
    this.subscribers.set(id, subscriber);
    return () => { this.subscribers.delete(id); };
  }

  publish(event: LocalRealtimeInvalidation): void {
    for (const [id, subscriber] of this.subscribers) {
      try {
        if (subscriber.send(event)) continue;
      } catch {
        // A failed client must not affect other subscribers or application writes.
      }
      this.subscribers.delete(id);
      try { subscriber.close(); } catch { /* connection is already unusable */ }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const current = [...this.subscribers.values()];
    this.subscribers.clear();
    for (const subscriber of current) {
      try { subscriber.close(); } catch { /* connection is already closed */ }
    }
  }

  get subscriberCount(): number { return this.subscribers.size; }
}
