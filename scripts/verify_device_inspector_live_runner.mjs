import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
loadEnv(path.join(root, "runner", ".env"));
const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("Runner verification credentials are unavailable");

const runnerId = "raka-local-wsl";
const targetIp = process.argv[2] ?? "192.168.188.249";
const expectSelf = process.argv.includes("--expect-self");
const requestedBy = await approvedAdminId();
const inspectionId = randomUUID();
const before = await snapshot();

try {
  const now = new Date();
  await rest("device_inspection_sessions?on_conflict=runner_id", "POST", {
    runner_id: runnerId,
    inspection_id: inspectionId,
    requested_by: requestedBy,
    target_ip: targetIp,
    authorization_source: "inventory",
    status: "queued",
    stage: "validating_target",
    result: null,
    error_code: null,
    created_at: now.toISOString(),
    started_at: null,
    completed_at: null,
    expires_at: new Date(now.getTime() + 10 * 60_000).toISOString(),
    updated_at: now.toISOString(),
  }, { Prefer: "resolution=merge-duplicates,return=representation" });
  const completed = await waitCompleted(60_000);
  if (completed.status !== "completed") throw new Error(`Live inspection failed: ${completed.error_code ?? completed.status}`);
  if (completed.result?.ip !== targetIp || !Array.isArray(completed.result?.observed_services)) throw new Error("Live normalized fingerprint is incomplete");
  if (expectSelf && (completed.result?.network_context?.is_this_device !== true || completed.result?.network_context?.interface_type !== "virtual")) throw new Error("Live self/virtual evidence is incomplete");
  if (containsForbiddenKey(completed.result)) throw new Error("Live fingerprint retained a prohibited raw field");
  const after = await snapshot();
  if (after.events !== before.events || after.traffic !== before.traffic) throw new Error("Inspection changed events or traffic_metrics");
  if (JSON.stringify(after.node) !== JSON.stringify(before.node)) throw new Error("Temporary inspection changed operator inventory");
  console.log(JSON.stringify({ ok: true, inspection_id: inspectionId, runner_id: runnerId,
    target_ip: targetIp, authorization_source: completed.authorization_source,
    stage: completed.stage, partial_fingerprint: true,
    self_device: completed.result?.network_context?.is_this_device === true,
    interface_type: completed.result?.network_context?.interface_type ?? null,
    raw_output_absent: true, operator_identity_unchanged: true,
    events_delta: 0, traffic_metrics_delta: 0 }, null, 2));
} finally {
  await fetch(`${url}/rest/v1/device_inspection_sessions?runner_id=eq.${runnerId}&inspection_id=eq.${inspectionId}`, { method: "DELETE", headers: headers() }).catch(() => {});
}

async function waitCompleted(timeout) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const rows = await rest(`device_inspection_sessions?runner_id=eq.${runnerId}&inspection_id=eq.${inspectionId}&select=*`); if (rows[0] && ["completed", "failed", "expired"].includes(rows[0].status)) return rows[0]; await new Promise((resolve) => setTimeout(resolve, 500)); } throw new Error("Live runner inspection timed out"); }
async function approvedAdminId() { const rows = await rest("profiles?role=eq.admin&status=eq.approved&select=id&limit=1"); if (!rows[0]?.id) throw new Error("Approved admin profile is unavailable"); return rows[0].id; }
async function snapshot() { const [events, traffic, nodes] = await Promise.all([count("events"), count("traffic_metrics"), rest(`network_nodes?ip_address=eq.${targetIp}&select=id,name,ip_address,location,notes,device_type,detected_fingerprint,last_inspected_at`)]); if (!nodes[0]) throw new Error("Known target is missing"); return { events, traffic, node: nodes[0] }; }
async function count(table) { const response = await fetch(`${url}/rest/v1/${table}?select=id`, { method: "HEAD", headers: { ...headers(), Prefer: "count=exact" } }); return Number(response.headers.get("content-range")?.split("/")[1] ?? 0); }
async function rest(resource, method = "GET", body, extraHeaders = {}) { const response = await fetch(`${url}/rest/v1/${resource}`, { method, headers: { ...headers(), ...extraHeaders, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }); const payload = response.status === 204 ? null : await response.json(); if (!response.ok) throw new Error(`Supabase REST failed: ${response.status}`); return payload; }
function containsForbiddenKey(value) { if (!value || typeof value !== "object") return false; return Object.entries(value).some(([name, item]) => /^(raw|stdout|stderr|html|xml|body|payload|cookie|token|authorization|credential|password|secret)$/i.test(name) || containsForbiddenKey(item)); }
function headers() { return { Authorization: `Bearer ${key}`, apikey: key }; }
function loadEnv(filename) { for (const raw of readFileSync(filename, "utf8").split(/\r?\n/)) { const line = raw.trim(); if (!line || line.startsWith("#")) continue; const index = line.indexOf("="); if (index < 1) continue; const name = line.slice(0, index).trim(); let value = line.slice(index + 1).trim(); if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1); if (process.env[name] === undefined) process.env[name] = value; } }
