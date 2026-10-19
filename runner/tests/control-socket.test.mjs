import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter, once } from "node:events";
import { RunnerControlSocket } from "../src/control-socket.mjs";
import { BackendClient } from "../src/backend.mjs";

class Socket extends EventEmitter {
  static instances = [];
  readyState = 1;
  sent = [];
  constructor(url, options) { super(); this.url = url; this.options = options; Socket.instances.push(this); queueMicrotask(() => this.emit("open")); }
  send(value) { this.sent.push(JSON.parse(value)); }
  terminate() { if (this.readyState === 3) return; this.readyState = 3; this.emit("close"); }
}
const ready = { type: "ready", state: "STANDBY", monitoring: false, control: "websocket", policy_revision: 0 };
const emit = (socket, data) => socket.emit("message", Buffer.from(JSON.stringify(data)), false);
const flush = () => new Promise((resolve) => setImmediate(resolve));
function create(options = {}) {
  return new RunnerControlSocket({ url: "http://127.0.0.1:3402", headers: { Authorization: "Bearer fixture-private" },
    runner: () => ({ id: "test" }), WebSocketImpl: Socket, ...options });
}
test("healthy control waits without HTTP and carries credentials only in header; duplicate hints stay bounded", async () => {
  const control = create(); control.start(); await flush(); const socket = control.socket;
  try {
    assert.doesNotMatch(socket.url, /fixture-private|Bearer|\?/);
    assert.equal(socket.options.headers.Authorization, "Bearer fixture-private");
    assert.equal(socket.sent[0].type, "health");
    emit(socket, ready); assert.equal(control.healthy, true);
    const controller = new AbortController(); const pending = control.wait(controller.signal);
    emit(socket, { type: "work_available", available: ["manual_ping", "traffic"] });
    assert.deepEqual((await pending).available, ["manual_ping", "traffic"]);
    for (let index = 0; index < 100; index++) emit(socket, { type: "work_available", available: ["discovery"] });
    assert.equal(control.available.length, 1);
    const backend = new BackendClient({ url: "http://127.0.0.1:3402", token: "fixture" }, "local_postgres");
    backend.control = control;
    await backend.heartbeat({ id: "test" });
    assert.equal(socket.sent.length, 1, "coincident healthy heartbeat coalesces with the socket health frame, never HTTP");
    await backend.waitForWork("test", controller.signal);
    const waiting = control.wait(controller.signal); controller.abort(); assert.equal(await waiting, null);
  } finally { await control.stop(); }
});
test("disconnect labels DEGRADED, aborts pending wait and reconnect uses bounded jittered backoff", async () => {
  const delays = []; const modes = [];
  let control;
  control = create({ onMode: (mode) => modes.push(mode), random: () => 1,
    sleep: async (ms, signal) => { delays.push(ms); await new Promise((resolve) => { signal.addEventListener("abort", resolve, { once: true }); }); } });
  control.start(); await flush(); emit(control.socket, ready);
  const pending = control.wait(new AbortController().signal);
  control.socket.terminate(); assert.equal(await pending, null); await flush();
  assert.equal(control.healthy, false); assert.equal(modes.at(-1).state, "DEGRADED");
  assert.equal(modes.at(-1).monitoring, false); assert.equal(delays[0], 1200);
  await control.stop();
});
test("malformed server metadata is rejected and an old local backend retains bounded legacy compatibility", async () => {
  const modes = []; const control = create({ onMode: (mode) => modes.push(mode) });
  control.start(); await flush();
  emit(control.socket, { type: "work_available", available: ["arbitrary-command"] });
  await control.stop(); assert.equal(control.healthy, false);
  const legacy = create({ onMode: (mode) => modes.push(mode) }); legacy.start(); await flush();
  const closed = once(legacy.socket, "close");
  legacy.socket.emit("unexpected-response", {}, { statusCode: 404, resume: () => {} }); await closed;
  assert.equal(modes.at(-1).monitoring, true); assert.equal(modes.at(-1).state, "DEGRADED");
  await legacy.stop();
});
