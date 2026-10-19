import WebSocket from "ws";
import { controlDelay } from "./control-plane.mjs";

const KINDS = ["manual_ping", "traffic", "discovery", "device_inspector"];
const STATES = ["STANDBY", "ACTIVATING", "ACTIVE", "DRAINING", "DEGRADED"];

/** One connection, bounded hints only. Atomic claims remain in BackendClient. */
export class RunnerControlSocket {
  constructor({ url, headers, runner, status = () => ({ ready: true, busy: false }), onMode = () => {},
    log = () => {}, WebSocketImpl = WebSocket, sleep = controlDelay, random = Math.random }) {
    const endpoint = new URL(url);
    if (endpoint.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("Invalid control endpoint");
    endpoint.protocol = "ws:"; endpoint.pathname = "/api/runner/control";
    this.url = endpoint.href; this.headers = headers; this.runner = runner; this.status = status;
    this.onMode = onMode; this.log = log; this.WebSocketImpl = WebSocketImpl; this.sleep = sleep; this.random = random;
    this.healthy = false; this.available = []; this.release = null; this.socket = null; this.stopped = false;
    this.shutdown = new AbortController();
    this.policyRevision = 0;
  }
  start() { this.task ??= this.connectLoop(); }
  reconcile() {
    if (this.healthy && this.socket?.readyState === WebSocket.OPEN) {
      if (this.socket.bufferedAmount > 65_536) return this.socket.terminate();
      this.socket.send(JSON.stringify({ type: "reconcile" }));
    }
  }
  async stop() { this.stopped = true; this.shutdown.abort(); this.socket?.terminate(); this.release?.(); await this.task; }
  sendHealth() {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    if (this.socket.bufferedAmount > 65_536) return this.socket.terminate();
    // The legacy independent heartbeat timer may coincide with the socket's
    // health timer. Coalesce them rather than violating the server rate bound.
    if (Date.now() - (this.lastHealthSentAt ?? 0) < 1_000) return;
    this.lastHealthSentAt = Date.now();
    const state = this.status();
    this.socket.send(JSON.stringify({ type: "health", runner: this.runner(), ready: state.ready, busy: state.busy,
      policy_revision: this.policyRevision }));
  }
  async connectLoop() {
    let failures = 0;
    while (!this.stopped) {
      let connectedAt = 0;
      await new Promise((resolve) => {
        const socket = new this.WebSocketImpl(this.url, { headers: this.headers, maxPayload: 4096,
          perMessageDeflate: false, handshakeTimeout: 5_000, followRedirects: false });
        this.socket = socket;
        this.lastHealthSentAt = 0;
        let lastMessageAt = Date.now();
        let timer;
        let legacy = false;
        const finish = () => {
          clearInterval(timer); this.healthy = false; this.available = []; this.release?.();
          // An older local backend has no standby policy. Preserve its existing
          // monitoring behavior, truthfully DEGRADED, until backend-first rollout.
          this.onMode({ state: "DEGRADED", monitoring: legacy, control: "degraded" }); resolve();
        };
        socket.once("open", () => {
          this.sendHealth();
          timer = setInterval(() => {
            if (Date.now() - lastMessageAt > 45_000) return socket.terminate();
            this.sendHealth();
          }, 30_000);
        });
        socket.on("message", (raw, binary) => {
          let event;
          try { event = JSON.parse(raw.toString()); } catch { return socket.terminate(); }
          if (binary || !event || typeof event !== "object") return socket.terminate();
          if (event.type === "work_available") {
            if (Object.keys(event).length !== 2 || !Array.isArray(event.available) || event.available.length > 4 ||
              new Set(event.available).size !== event.available.length || event.available.some((k) => !KINDS.includes(k))) return socket.terminate();
            this.available = event.available; this.release?.();
          } else if (["ready", "runtime"].includes(event.type)) {
            if (Object.keys(event).length !== 5 || !Number.isSafeInteger(event.policy_revision) || event.policy_revision < 0 ||
              !STATES.includes(event.state) || typeof event.monitoring !== "boolean" ||
              !["websocket", "degraded"].includes(event.control)) return socket.terminate();
            if (event.type === "ready") { this.healthy = true; connectedAt ||= Date.now(); this.release?.(); }
            this.policyRevision = event.policy_revision;
            this.onMode(event);
          } else return socket.terminate();
          lastMessageAt = Date.now();
        });
        socket.on("error", () => {});
        socket.on("unexpected-response", (_request, response) => {
          legacy = [404, 405].includes(response.statusCode);
          response.resume(); socket.terminate();
        });
        socket.once("close", finish);
      });
      if (this.stopped) break;
      failures = connectedAt && Date.now() - connectedAt > 60_000 ? 1 : Math.min(6, failures + 1);
      this.log("Runner control DEGRADED; bounded HTTP fallback and WebSocket reconnect active");
      await this.sleep(Math.min(30_000, Math.round(1000 * 2 ** (failures - 1) * (0.8 + this.random() * 0.4))), this.shutdown.signal);
    }
  }
  async wait(signal) {
    while (this.healthy && !signal.aborted) {
      if (this.available.length) { const available = this.available; this.available = []; return { supported: true, available, timed_out: false }; }
      await new Promise((resolve) => {
        const finish = () => { signal.removeEventListener("abort", finish); this.release = null; resolve(); };
        this.release = finish; signal.addEventListener("abort", finish, { once: true });
        if (signal.aborted || !this.healthy || this.available.length) finish();
      });
    }
    return null;
  }
}
