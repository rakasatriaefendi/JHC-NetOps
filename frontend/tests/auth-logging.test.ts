import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { safeAuthFailure } from "../lib/auth-logging.ts";

test("auth logging retains only bounded operation, code, and HTTP status", () => {
  assert.deepEqual(safeAuthFailure("register", {
    code: "over_email_send_rate_limit",
    status: 429,
    message: "backend detail",
    password: "must-not-appear",
    access_token: "must-not-appear",
  }), {
    operation: "register",
    code: "over_email_send_rate_limit",
    status: 429,
  });
});

test("auth logging normalizes arbitrary values instead of surfacing payloads or secrets", () => {
  const result = safeAuthFailure("login", {
    code: "bad code containing user@example.test and a token",
    status: 200,
    refresh_token: "must-not-appear",
    formData: { password: "must-not-appear" },
  });
  assert.deepEqual(result, { operation: "login", code: "auth_failed", status: null });
  assert.doesNotMatch(JSON.stringify(result), /password|token|email|formData|example\.test/);
});

test("auth actions keep generic user messages and never pass request payloads to the logger", () => {
  const action = readFileSync(new URL("../app/actions/auth.ts", import.meta.url), "utf8");
  assert.match(action, /logAuthFailure\("login", error\)/);
  assert.match(action, /logAuthFailure\("register", error\)/);
  assert.match(action, /Email atau password tidak valid/);
  assert.match(action, /Registrasi gagal\. Periksa data atau coba beberapa saat lagi/);
  assert.doesNotMatch(action, /logAuthFailure\([^,]+,\s*(?:formData|password|email|data)\)/);
});
