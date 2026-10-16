import { Client } from "pg";

import { LOCAL_REALTIME_CHANNEL, createSyncInvalidation, parseLocalRealtimeNotification } from "./contract.js";
import type { LocalRealtimeBroker } from "./broker.js";

export type RealtimeListenConnection = Readonly<{
  listen: (channel: string) => Promise<void>;
  onNotification: (handler: (channel: string, payload: string | undefined) => void) => void;
  onError: (handler: () => void) => void;
  onEnd: (handler: () => void) => void;
  close: () => Promise<void>;
}>;

export type RealtimeListenConnectionFactory = () => Promise<RealtimeListenConnection>;

export function postgresRealtimeConnectionFactory(databaseUrl: string): RealtimeListenConnectionFactory {
  return async () => {
    const client = new Client({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 3_000,
      application_name: "jhc-netops-backend-realtime",
    });
    await client.connect();
    return {
      listen: async (channel) => {
        if (channel !== LOCAL_REALTIME_CHANNEL) throw new Error("Realtime channel is not approved");
        await client.query(`LISTEN ${LOCAL_REALTIME_CHANNEL}`);
      },
      onNotification: (handler) => { client.on("notification", (message) => handler(message.channel, message.payload)); },
      onError: (handler) => { client.on("error", handler); },
      onEnd: (handler) => { client.on("end", handler); },
      close: async () => { await client.end().catch(() => undefined); },
    };
  };
}

export class PostgresRealtimeListener {
  private running: Promise<void> | null = null;
  private stopController: AbortController | null = null;
  private activeConnection: RealtimeListenConnection | null = null;
  private listening = false;

  constructor(
    private readonly connect: RealtimeListenConnectionFactory,
    private readonly broker: LocalRealtimeBroker,
    private readonly reconnectMinimumMs = 250,
    private readonly reconnectMaximumMs = 5_000,
  ) {}

  start(): void {
    if (this.running) return;
    this.stopController = new AbortController();
    this.running = this.run(this.stopController.signal).finally(() => {
      this.running = null;
      this.stopController = null;
      this.listening = false;
    });
  }

  async stop(): Promise<void> {
    this.stopController?.abort();
    await this.activeConnection?.close().catch(() => undefined);
    await this.running?.catch(() => undefined);
    this.activeConnection = null;
    this.listening = false;
  }

  isListening(): boolean { return this.listening; }

  private async run(signal: AbortSignal): Promise<void> {
    let reconnectDelay = this.reconnectMinimumMs;
    let hasListened = false;
    while (!signal.aborted) {
      let connection: RealtimeListenConnection | null = null;
      try {
        connection = await this.connect();
        if (signal.aborted) { await connection.close().catch(() => undefined); break; }
        this.activeConnection = connection;
        let disconnected!: () => void;
        const disconnection = new Promise<void>((resolve) => { disconnected = resolve; });
        connection.onNotification((channel, payload) => {
          if (channel !== LOCAL_REALTIME_CHANNEL) return;
          const event = parseLocalRealtimeNotification(payload);
          if (event) this.broker.publish(event);
        });
        connection.onError(disconnected);
        connection.onEnd(disconnected);
        await connection.listen(LOCAL_REALTIME_CHANNEL);
        if (signal.aborted) break;
        this.listening = true;
        // NOTIFY is not durable: connected browsers must refetch after a LISTEN gap.
        if (hasListened) this.broker.publish(createSyncInvalidation());
        hasListened = true;
        reconnectDelay = this.reconnectMinimumMs;
        await Promise.race([disconnection, aborted(signal)]);
      } catch {
        // The backend remains available while the bounded listener reconnects.
      } finally {
        this.listening = false;
        if (this.activeConnection === connection) this.activeConnection = null;
        await connection?.close().catch(() => undefined);
      }
      if (!signal.aborted) {
        await abortableDelay(reconnectDelay, signal);
        reconnectDelay = Math.min(this.reconnectMaximumMs, reconnectDelay * 2);
      }
    }
  }
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
