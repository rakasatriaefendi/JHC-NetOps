import path from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BackendClient } from "./backend.mjs";
import { loadRunnerConfig, publicCapabilities, safeError, safeMessage, validateDiscoverySession, validateJob, validatePreflightRequest, validateTrafficSession } from "./config.mjs";
import { collectNetworkContext } from "./network-context.mjs";
import { collectDiscoveryContext, publicDiscoveryContext, runNetworkDiscovery } from "./network-discovery.mjs";
import { startHeartbeatLoop } from "./heartbeat.mjs";
import { runAgent, runPreflight, runTrafficAgent } from "./wsl.mjs";
import { NetworkHealthWatch } from "./network-health.mjs";

const RUNNER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const once = args.has("--once");
const preflightOnly = args.has("--preflight-only");
const configArg = process.argv.indexOf("--config");
const configPath = configArg >= 0 ? process.argv[configArg + 1] : path.join(RUNNER_ROOT, "config.local.json");

let config;
let backend;
try {
  config = loadRunnerConfig(configPath);
  backend = new BackendClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
} catch {
  log("Runner configuration is invalid");
  process.exit(2);
}

let healthStatus = "degraded";
let healthErrorCode = "RUNNER_INTERNAL_ERROR";
for (let attempt = 1; attempt <= 3; attempt += 1) {
  try {
    const versions = runPreflight(config);
    healthStatus = "online";
    healthErrorCode = null;
    log(`Preflight passed (${versions.python}, iperf3 ${versions.iperf3}, mtr available)`);
    break;
  } catch (error) {
    healthErrorCode = error.code ?? "RUNNER_INTERNAL_ERROR";
    const retryable = ["AGENT_VENV_MISSING", "TRAFFIC_CAPTURE_FAILED", "WSL_DISTRO_NOT_FOUND"].includes(healthErrorCode);
    if (attempt < 3 && retryable) {
      log(`Preflight attempt ${attempt} failed: ${healthErrorCode}; retrying`);
      await delay(3000);
      continue;
    }
    log(`Preflight failed: ${healthErrorCode}`);
    break;
  }
}

await sendHeartbeat().catch(() => log("Heartbeat failed"));
if (preflightOnly) process.exit(healthStatus === "online" ? 0 : 2);
if (healthStatus !== "online") process.exit(2);

const stopHeartbeat = startHeartbeatLoop(
  sendHeartbeat,
  config.heartbeat_interval_ms,
  () => log("Heartbeat failed"),
);
const healthWatch = new NetworkHealthWatch({
  runnerId: config.runner_id,
  backend,
  cachePath: path.join(RUNNER_ROOT, "data", "network-health-state.json"),
  log,
});
if (!once) healthWatch.start();
try {
  do {
    const rawPreflight = await backend.claimPreflight(config.runner_id).catch(() => null);
    if (rawPreflight) await executePreflight(rawPreflight);
    else {
      const rawJob = await backend.claim(config.runner_id).catch(() => null);
      if (rawJob) await executeJob(rawJob);
      else {
      const rawSession = await backend.claimTraffic(config.runner_id).catch(() => null);
      if (rawSession) await executeTraffic(rawSession);
      else {
        const rawDiscovery = await backend.claimDiscovery(config.runner_id).catch(() => null);
        if (rawDiscovery) await executeDiscovery(rawDiscovery);
      }
      }
    }
    if (!once) await delay(config.poll_interval_ms);
  } while (!once);
} finally {
  await healthWatch.stop();
  stopHeartbeat();
}

async function executePreflight(rawRequest) {
  let request;
  try {
    request = validatePreflightRequest(rawRequest, config);
    const context = await collectNetworkContext(request.target);
    if (request.target.environment === "localhost_demo") {
      context.preflight.iperf = { ...context.preflight.iperf, ready: true, managed_demo: true };
    }
    await backend.completePreflight(config.runner_id, request.request_id, request.target.id, context);
    log(`Preflight ${request.request_id} completed for ${request.target.id}`);
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : "NETWORK_CONTEXT_UNAVAILABLE";
    if (rawRequest?.request_id) await backend.failPreflight(config.runner_id, rawRequest.request_id, code).catch(() => {});
    log(`Preflight ${rawRequest?.request_id ?? "unknown"} failed: ${code}`);
  }
}

async function executeTraffic(rawSession) {
  let session;
  try { session = validateTrafficSession(rawSession, config); }
  catch (error) { await failTraffic(rawSession?.id, error); return; }
  let completed = false;
  try {
    await backend.trafficProgress(config.runner_id, session.id, "starting_wsl");
    await runTrafficAgent(config, session, async (event) => {
      if (event.type === "stage") await backend.trafficProgress(config.runner_id, session.id, event.stage);
      if (event.type === "complete") completed = event.session_id === session.id;
      if (event.type === "error") throw safeError("TRAFFIC_CAPTURE_FAILED", event.message);
    }, (session.duration_seconds + 60) * 1000);
    if (!completed) throw safeError("AGENT_PROTOCOL_ERROR");
    await backend.completeTraffic(config.runner_id, session.id);
    log(`Traffic session ${session.id} completed`);
  } catch (error) { await failTraffic(session.id, error); }
}

async function executeDiscovery(rawSession) {
  let session;
  try { session = validateDiscoverySession(rawSession, config); }
  catch (error) {
    if (rawSession?.session_id) await backend.failDiscovery(config.runner_id, rawSession.session_id, error.code ?? "INVALID_DISCOVERY_SESSION").catch(() => {});
    return;
  }
  try {
    const context = await collectDiscoveryContext();
    const publicContext = publicDiscoveryContext(context);
    if (session.phase === "prepare") {
      await backend.discoveryContextReady(config.runner_id, session.session_id, publicContext);
      log(`Discovery context ${session.session_id} prepared for ${context.subnet_cidr}`);
      return;
    }
    const result = await runNetworkDiscovery(context, (progress) =>
      backend.discoveryProgress(config.runner_id, session.session_id, publicContext, progress));
    await backend.completeDiscovery(config.runner_id, session.session_id, result.scanned_hosts);
    log(`Discovery ${session.session_id} completed: ${result.results.length} visible hosts on ${context.subnet_cidr}`);
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : "DISCOVERY_FAILED";
    await backend.failDiscovery(config.runner_id, session.session_id, code).catch(() => {});
    log(`Discovery ${session.session_id} failed: ${code}`);
  }
}

async function failTraffic(sessionId, error) {
  if (!sessionId) return;
  const code = typeof error?.code === "string" ? error.code : "TRAFFIC_CAPTURE_FAILED";
  await backend.failTraffic(config.runner_id, sessionId, code, safeMessage(code)).catch(() => {});
  log(`Traffic session ${sessionId} failed: ${code}`);
}

async function executeJob(rawJob) {
  let job;
  try {
    job = validateJob(rawJob, config);
  } catch (error) {
    await fail(rawJob?.id, error);
    return;
  }
  const liveSamples = { upload: [], download: [] };
  const summaries = {};
  let completedEvent = false;
  try {
    await backend.progress(config.runner_id, job.id, "starting_wsl", {});
    const context = await collectNetworkContext(job.target);
    if (context.network_context.connection_type !== "wifi" && context.network_context.connection_type !== "ethernet") {
      throw safeError("INVALID_CONNECTION_TYPE");
    }
    if (job.target.environment === "localhost_demo") {
      context.preflight.iperf = { ...context.preflight.iperf, ready: true, managed_demo: true };
    } else if (!context.preflight.iperf.ready) {
      throw safeError("IPERF3_SERVER_UNAVAILABLE");
    }
    job.connection_type = context.network_context.connection_type;
    await backend.updateJobContext(config.runner_id, job.id, context);
    await backend.progress(config.runner_id, job.id, "checking_target", {});
    const timeoutMs = (job.duration_seconds * 2 + 150) * 1000;
    await runAgent(config, job, async (event) => {
        if (event.type === "stage") {
          await backend.progress(config.runner_id, job.id, event.stage, { summaries });
        } else if (event.type === "interval") {
          const samples = liveSamples[event.direction];
          samples.push({ second: event.second, mbps: event.mbps });
          if (samples.length > 60) samples.shift();
          await backend.progress(config.runner_id, job.id, event.direction, {
            direction: event.direction,
            elapsed_seconds: event.second,
            duration_seconds: job.duration_seconds,
            progress_percent: Math.min(100, event.second / job.duration_seconds * 100),
            current_mbps: event.mbps,
            average_mbps: event.average_mbps,
            peak_mbps: event.peak_mbps,
            minimum_mbps: event.minimum_mbps,
            transferred_mb: event.transferred_mb,
            ...(event.retransmits === null ? {} : { retransmits: event.retransmits }),
            live_samples: samples,
            summaries,
          });
        } else if (event.type === "summary") {
          summaries[event.direction] = event;
          await backend.progress(config.runner_id, job.id, event.direction, { direction: event.direction, ...event, live_samples: liveSamples[event.direction], summaries });
        } else if (event.type === "complete") {
          if (event.job_id !== job.id) throw safeError("AGENT_PROTOCOL_ERROR");
          completedEvent = true;
        } else if (event.type === "error") {
          throw safeError(event.code, event.message);
        }
      }, timeoutMs);
    if (!completedEvent) throw safeError("AGENT_PROTOCOL_ERROR");
    await backend.complete(config.runner_id, job.id);
    log(`Job ${job.id} completed`);
  } catch (error) {
    await fail(job.id, error);
  }
}

async function fail(jobId, error) {
  if (!jobId) return;
  const code = typeof error?.code === "string" ? error.code : "RUNNER_INTERNAL_ERROR";
  const message = safeMessage(code);
  await backend.fail(config.runner_id, jobId, code, message).catch(() => {});
  log(`Job ${jobId} failed: ${code}`);
}

async function sendHeartbeat() {
  await backend.heartbeat({
    id: config.runner_id,
    display_name: config.display_name,
    health_status: healthStatus,
    health_error_code: healthErrorCode,
    capabilities: publicCapabilities(config),
  });
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  try {
    mkdirSync(path.join(RUNNER_ROOT, "logs"), { recursive: true });
    appendFileSync(path.join(RUNNER_ROOT, "logs", "runner.log"), `${line}\n`, "utf8");
  } catch {}
}
