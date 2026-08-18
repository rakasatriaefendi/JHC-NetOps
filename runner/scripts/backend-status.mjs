import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadRunnerConfig } from "../src/config.mjs";

const runnerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = loadRunnerConfig(path.join(runnerRoot, "config.local.json"));
const url = process.env.SUPABASE_URL.replace(/\/$/, "");
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const response = await fetch(
  `${url}/rest/v1/diagnostic_runners?select=id,last_seen_at,health_status,health_error_code,capabilities&id=eq.${encodeURIComponent(config.runner_id)}`,
  { headers: { Authorization: `Bearer ${key}`, apikey: key } },
);
if (!response.ok) throw new Error(`Runner status request failed with HTTP ${response.status}`);
const [runner] = await response.json();
if (!runner) throw new Error("Runner heartbeat row was not found");
const heartbeatAgeSeconds = Math.max(0, (Date.now() - Date.parse(runner.last_seen_at)) / 1000);
const online = runner.health_status === "online" && heartbeatAgeSeconds <= 30;
console.log(JSON.stringify({
  id: runner.id,
  online,
  heartbeat_age_seconds: Number(heartbeatAgeSeconds.toFixed(1)),
  health_status: runner.health_status,
  health_error_code: runner.health_error_code,
  last_seen_at: runner.last_seen_at,
  operations: runner.capabilities?.operations ?? [],
  device_inspector: runner.capabilities?.device_inspector ?? null,
}, null, 2));
process.exitCode = online ? 0 : 2;
