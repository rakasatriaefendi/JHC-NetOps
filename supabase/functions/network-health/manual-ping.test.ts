import {
  validManualPingFailureCode,
  validManualPingResult,
} from "./manual-ping.ts";

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

Deno.test("manual ping accepts only bounded normalized success", () => {
  assert(validManualPingResult({ ok: true, latency_ms: 2.1 }), "valid success rejected");
  assert(!validManualPingResult({ ok: true, latency_ms: -1 }), "negative latency accepted");
  assert(!validManualPingResult({ ok: true, latency_ms: 2.1, stderr: "raw" }), "raw field accepted");
});

Deno.test("manual ping accepts only normalized timeout or unreachable", () => {
  assert(validManualPingResult({ ok: false, category: "timeout" }), "timeout rejected");
  assert(validManualPingResult({ ok: false, category: "unreachable" }), "unreachable rejected");
  assert(!validManualPingResult({ ok: false, category: "offline" }), "unsupported category accepted");
});

Deno.test("manual ping failure codes stay allow-listed", () => {
  assert(validManualPingFailureCode("MANUAL_PING_FAILED"), "safe failure rejected");
  assert(validManualPingFailureCode("MANUAL_PING_TARGET_UNAVAILABLE"), "safe target failure rejected");
  assert(!validManualPingFailureCode("RAW_STDERR"), "arbitrary failure accepted");
});
