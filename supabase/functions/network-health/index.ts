import { createClient } from "@supabase/supabase-js";
import { legacyApplicationMutationBlocked, legacyApplicationMutationBlockedResponse } from "../_shared/persistence-authority.ts";
import { canOperateNetwork } from "../_shared/authorization.ts";
import {
  MANUAL_PING_RESULT_TTL_MS,
  validManualPingFailureCode,
  validManualPingResult,
} from "./manual-ping.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUS = new Set(["online", "degraded", "offline"]);
const RUNNER_FRESH_MS = 30_000;
const MANUAL_PING_QUEUE_TTL_MS = 30_000;

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, {status:204, headers:CORS});
  if (legacyApplicationMutationBlocked()) return legacyApplicationMutationBlockedResponse(CORS);
  if (request.method !== "POST") return reply({error:"Method not allowed"}, 405);
  let body: Record<string, unknown>;
  try { body = await request.json(); }
  catch { return reply({error:"Invalid JSON"}, 400); }
  if (!record(body) || typeof body.action !== "string") return reply({error:"Structured action required"}, 400);
  if (body.action === "manual_ping") return createManualPing(request, body);
  const service = serviceClient(request);
  if (!service.ok) return service.response;
  if (!identifier(body.runner_id)) return reply({error:"Structured runner action required"}, 400);
  if (body.action === "list_targets") return listTargets(service.client, body.runner_id);
  if (body.action === "publish") return publish(service.client, body);
  if (body.action === "claim_manual_ping") return claimManualPing(service.client, body.runner_id);
  if (body.action === "complete_manual_ping" || body.action === "fail_manual_ping") {
    if (!uuid(body.ping_id)) return reply({error:"Manual ping ID is invalid"}, 400);
    return finishManualPing(service.client, body, body.action === "complete_manual_ping");
  }
  return reply({error:"Unsupported action"}, 400);
});

async function createManualPing(request: Request, body: Record<string, unknown>) {
  const auth = await userAuth(request);
  if (!auth.ok) return auth.response;
  if (!canOperateNetwork(auth.role)) return reply({error:"Operator role required"}, 403);
  if (Object.keys(body).some((key) => key !== "action" && key !== "target_id") || !uuid(body.target_id)) {
    return reply({error:"Only an authorized target_id is accepted"}, 400);
  }
  await cleanupManualPings(auth.service);
  const {data:target,error:targetError} = await auth.service.from("network_targets")
    .select("id,runner_id,enabled,timeout_ms")
    .eq("id", body.target_id).maybeSingle();
  if (targetError) return reply({error:"Manual ping target could not be checked"}, 500);
  if (!target || target.enabled !== true) return reply({error:"Manual ping target is not authorized",code:"TARGET_NOT_AUTHORIZED"}, 403);

  const {data:runner,error:runnerError} = await auth.service.from("diagnostic_runners")
    .select("id,last_seen_at,health_status,capabilities")
    .eq("id", target.runner_id).maybeSingle();
  if (runnerError) return reply({error:"Manual ping runner could not be checked"}, 500);
  if (!runner || runner.health_status !== "online" || Date.now() - Date.parse(runner.last_seen_at) > RUNNER_FRESH_MS) {
    return reply({error:"Local Runner is offline",code:"RUNNER_OFFLINE"}, 409);
  }
  const capabilities = record(runner.capabilities) ? runner.capabilities : {};
  if (!Array.isArray(capabilities.operations) || !capabilities.operations.includes("manual_ping")) {
    return reply({error:"Manual ping is not authorized by this runner",code:"PING_NOT_AUTHORIZED"}, 409);
  }

  const now = new Date();
  const {data,error} = await auth.service.from("network_health_ping_jobs").insert({
    target_id:target.id,
    runner_id:target.runner_id,
    requested_by:auth.userId,
    status:"queued",
    result:null,
    error_code:null,
    expires_at:new Date(now.getTime() + MANUAL_PING_QUEUE_TTL_MS).toISOString(),
    updated_at:now.toISOString(),
  }).select("id,target_id,runner_id,status,result,error_code,created_at,started_at,completed_at,expires_at,updated_at").single();
  if (error?.code === "23505") return reply({error:"A manual ping is already active for this target",code:"PING_ALREADY_RUNNING"}, 409);
  if (error) return reply({error:"Manual ping could not be queued"}, 500);
  return reply({data}, 202);
}

async function claimManualPing(
  db: ReturnType<typeof createClient>,
  runnerId: string,
) {
  await cleanupManualPings(db);

  const { data: queued, error: readError } = await db
    .from("network_health_ping_jobs")
    .select("id,target_id,runner_id,status,created_at")
    .eq("runner_id", runnerId)
    .eq("status", "queued")
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (readError) {
    return reply({ error: "Manual ping queue could not be read" }, 500);
  }

  if (!queued) {
    return reply({ data: null }, 200);
  }

  const now = new Date();
  const nowIso = now.toISOString();

  const { data, error } = await db
    .from("network_health_ping_jobs")
    .update({
      status: "running",
      started_at: nowIso,
      expires_at: new Date(
        now.getTime() + MANUAL_PING_QUEUE_TTL_MS,
      ).toISOString(),
      updated_at: nowIso,
    })
    .eq("id", queued.id)
    .eq("runner_id", runnerId)
    .eq("status", "queued")
    .select("id,target_id,runner_id,status,created_at,started_at")
    .maybeSingle();

  return error
    ? reply({ error: "Manual ping could not be claimed" }, 500)
    : reply({ data }, 200);
}

async function finishManualPing(db: ReturnType<typeof createClient>, body: Record<string, unknown>, completed: boolean) {
  if (completed && !validManualPingResult(body.result)) return reply({error:"Manual ping result is invalid"}, 400);
  if (!completed && !validManualPingFailureCode(body.error_code)) return reply({error:"Manual ping error code is invalid"}, 400);
  const now = new Date();
  const {data,error} = await db.from("network_health_ping_jobs").update({
    status:completed ? "completed" : "failed",
    result:completed ? body.result : null,
    error_code:completed ? null : body.error_code,
    completed_at:now.toISOString(),
    expires_at:new Date(now.getTime() + MANUAL_PING_RESULT_TTL_MS).toISOString(),
    updated_at:now.toISOString(),
  }).eq("id", body.ping_id).eq("runner_id", body.runner_id).eq("status", "running")
    .select("id,target_id,runner_id,status,result,error_code,completed_at,expires_at,updated_at").maybeSingle();
  if (error) return reply({error:"Manual ping result could not be stored"}, 500);
  return data ? reply({data}, 200) : reply({error:"Running manual ping was not found"}, 409);
}

async function cleanupManualPings(db: ReturnType<typeof createClient>) {
  await db.from("network_health_ping_jobs").delete().lt("expires_at", new Date().toISOString());
}

async function listTargets(db: ReturnType<typeof createClient>, runnerId: string) {
  const {data,error} = await db.from("network_targets")
    .select("id,node_id,runner_id,enabled,critical,probe_method,probe_interval_seconds,timeout_ms,failure_threshold,recovery_threshold,latency_warning_ms,loss_warning_percent,updated_at,network_nodes!inner(ip_address,name,device_type,location),network_health_latest(status,latency_ms,packet_loss_percent,last_checked_at,last_success_at,consecutive_failures,sample_count)")
    .eq("runner_id", runnerId).eq("enabled", true).order("created_at");
  if (error) return reply({error:"Health targets could not be loaded"}, 500);
  const targets = (data ?? []).map((row: Record<string, unknown>) => {
    const node = relation(row.network_nodes);
    const latest = relation(row.network_health_latest);
    return {
      id:row.id,node_id:row.node_id,runner_id:row.runner_id,critical:row.critical,
      probe_method:row.probe_method,probe_interval_seconds:row.probe_interval_seconds,
      timeout_ms:row.timeout_ms,failure_threshold:row.failure_threshold,
      recovery_threshold:row.recovery_threshold,latency_warning_ms:row.latency_warning_ms,
      loss_warning_percent:row.loss_warning_percent,config_updated_at:row.updated_at,
      ip_address:node?.ip_address,name:node?.name,device_type:node?.device_type,location:node?.location,
      latest:latest ?? null,
    };
  });
  return reply({data:{targets}}, 200);
}

async function publish(db: ReturnType<typeof createClient>, body: Record<string, unknown>) {
  const states = Array.isArray(body.states) ? body.states : [];
  const transitions = Array.isArray(body.transitions) ? body.transitions : [];
  if (states.length > 50 || transitions.length > 100 || !states.every(validState) || !transitions.every(validTransition)) {
    return reply({error:"Health payload is invalid"}, 400);
  }
  const targetIds = [...new Set([...states, ...transitions].map((item) => (item as Record<string, unknown>).target_id as string))];
  if (!targetIds.length) return reply({data:{states:0,events:0}}, 200);
  const {data:allowed,error:targetError} = await db.from("network_targets")
    .select("id,critical,network_nodes!inner(ip_address,name)")
    .eq("runner_id", body.runner_id).eq("enabled", true).in("id", targetIds);
  if (targetError) return reply({error:"Health target authorization failed"}, 500);
  const allowedMap = new Map((allowed ?? []).map((row: Record<string, unknown>) => [row.id as string, row]));
  if (targetIds.some((id) => !allowedMap.has(id))) return reply({error:"Health target is not authorized"}, 403);

  const now = new Date().toISOString();
  const latestRows = states.map((item) => {
    const state = item as Record<string, unknown>;
    return {
      target_id:state.target_id,status:state.status,latency_ms:state.latency_ms,
      packet_loss_percent:state.packet_loss_percent,last_checked_at:state.last_checked_at,
      last_success_at:state.last_success_at,consecutive_failures:state.consecutive_failures,
      sample_count:state.sample_count,updated_at:now,
    };
  });
  if (latestRows.length) {
    const {error} = await db.from("network_health_latest").upsert(latestRows, {onConflict:"target_id"});
    if (error) return reply({error:"Latest health state could not be stored"}, 500);
  }

  // Write coalesced samples to network_health_samples (one per target per UTC minute)
  if (states.length) {
    // Group states by target_id and minute bucket, keep the latest state per bucket
    const bucketMap = new Map<string, Record<string, unknown>>();
    for (const item of states) {
      const state = item as Record<string, unknown>;
      const targetId = state.target_id as string;
      const checkedAt = new Date(state.last_checked_at as string);
      // Truncate to UTC minute: floor to minute boundary
      const minuteBucket = new Date(Date.UTC(checkedAt.getUTCFullYear(), checkedAt.getUTCMonth(), checkedAt.getUTCDate(), checkedAt.getUTCHours(), checkedAt.getUTCMinutes(), 0, 0)).toISOString();
      const bucketKey = `${targetId}|${minuteBucket}`;
      const existing = bucketMap.get(bucketKey);
      if (!existing || new Date(existing.last_checked_at as string) < checkedAt) {
        bucketMap.set(bucketKey, {
          target_id: targetId,
          sampled_at: minuteBucket,
          status: state.status,
          latency_ms: state.latency_ms,
          packet_loss_percent: state.packet_loss_percent,
          sample_count: state.sample_count,
        });
      }
    }
    const sampleRows = Array.from(bucketMap.values());
    if (sampleRows.length) {
      const {error: sampleError} = await db.from("network_health_samples").upsert(sampleRows, {
        onConflict: "target_id,sampled_at",
        ignoreDuplicates: false,
      });
      if (sampleError) return reply({error:"Health samples could not be stored"}, 500);
    }
  }

  let inserted = 0;
  const transitionIds = transitions.map((item) => (item as Record<string, unknown>).event_id as string);
  const {data:existing,error:existingError} = transitionIds.length
    ? await db.from("events").select("id").in("id", transitionIds)
    : {data:[],error:null};
  if (existingError) return reply({error:"Health event deduplication failed"}, 500);
  const seen = new Set((existing ?? []).map((row: {id:string}) => row.id));
  for (const item of transitions as Record<string, unknown>[]) {
    if (seen.has(item.event_id as string)) continue;
    const target = allowedMap.get(item.target_id as string) as Record<string, unknown>;
    const node = relation(target.network_nodes);
    const occurredAt = item.occurred_at as string;
    const newStatus = item.new_status as string;
    const {error:resolveError} = await db.from("events").update({resolved_at:occurredAt})
      .eq("source", "network_health").eq("source_ref", item.target_id).is("resolved_at", null);
    if (resolveError) return reply({error:"Previous health alert could not be resolved"}, 500);
    const critical = target.critical === true;
    const event = healthEvent(item, node, critical);
    const {error:eventError} = await db.from("events").insert(event);
    if (eventError && eventError.code !== "23505") return reply({error:"Health transition could not be stored"}, 500);
    if (!eventError) inserted += 1;
    if (newStatus === "online") seen.add(item.event_id as string);
  }
  return reply({data:{states:latestRows.length,events:inserted}}, 200);
}

function healthEvent(item: Record<string, unknown>, node: Record<string, unknown> | null, critical: boolean) {
  const name = typeof node?.name === "string" ? node.name : "Known network target";
  const ipAddress = typeof node?.ip_address === "string" ? node.ip_address : null;
  const status = item.new_status as string;
  const title = status === "offline" ? `${name} tidak merespons ICMP`
    : status === "degraded" ? `${name} health degraded` : `${name} recovered`;
  const description = status === "offline"
    ? "Target melewati ambang kegagalan ICMP. Ini tidak membuktikan perangkat mati; ICMP dapat diblokir atau jalur dapat bermasalah."
    : status === "degraded"
      ? "Target masih merespons, tetapi latency atau packet-loss short window melewati threshold yang dikonfigurasi."
      : "Target kembali memenuhi recovery threshold dan merespons secara konsisten.";
  return {
    id:item.event_id,created_at:item.occurred_at,
    severity:status === "offline" ? (critical ? "critical" : "high") : status === "degraded" ? "medium" : "low",
    title,description,source:"network_health",source_ref:item.target_id,
    resolved_at:status === "online" ? item.occurred_at : null,
    raw_context:{
      source:"network_health",target_id:item.target_id,ip_address:ipAddress,
      previous_status:item.previous_status,new_status:status,critical,
      latency_ms:item.latency_ms,packet_loss_percent:item.packet_loss_percent,
      consecutive_failures:item.consecutive_failures,transition_id:item.event_id,
    },
  };
}

function validState(value: unknown): value is Record<string, unknown> {
  if (!record(value) || !uuid(value.target_id) || !STATUS.has(String(value.status)) || !dateString(value.last_checked_at)) return false;
  return nullableNumber(value.latency_ms, 0, 60000) && number(value.packet_loss_percent, 0, 100)
    && nullableDate(value.last_success_at) && integer(value.consecutive_failures, 0, 1000000)
    && integer(value.sample_count, 0, 5);
}
function validTransition(value: unknown): value is Record<string, unknown> {
  if (!record(value) || !uuid(value.event_id) || !uuid(value.target_id) || !STATUS.has(String(value.previous_status)) || !STATUS.has(String(value.new_status))) return false;
  if (value.previous_status === value.new_status || !dateString(value.occurred_at)) return false;
  return nullableNumber(value.latency_ms,0,60000) && number(value.packet_loss_percent,0,100) && integer(value.consecutive_failures,0,1000000);
}
async function userAuth(request: Request): Promise<
  | {ok:true;client:ReturnType<typeof createClient>;service:ReturnType<typeof createClient>;userId:string;role:string}
  | {ok:false;response:Response}
> {
  const url=Deno.env.get("SUPABASE_URL"), anon=Deno.env.get("SUPABASE_ANON_KEY"), key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), token=bearer(request);
  if (!url || !anon || !key || !token) return {ok:false,response:reply({error:"Unauthorized"},401)};
  const client=createClient(url,anon,{auth:{persistSession:false,autoRefreshToken:false},global:{headers:{Authorization:`Bearer ${token}`}}});
  const {data:user}=await client.auth.getUser(token);
  if (!user.user) return {ok:false,response:reply({error:"Unauthorized"},401)};
  const {data:profile}=await client.from("profiles").select("status,role").eq("id",user.user.id).maybeSingle();
  if (profile?.status !== "approved") return {ok:false,response:reply({error:"Forbidden"},403)};
  return {
    ok:true,
    client,
    service:createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}}),
    userId:user.user.id,
    role:typeof profile.role === "string" ? profile.role : "viewer",
  };
}
function serviceClient(request: Request): {ok:true;client:ReturnType<typeof createClient>} | {ok:false;response:Response} {
  const url=Deno.env.get("SUPABASE_URL"), key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), token=bearer(request);
  const apiKey=request.headers.get("apikey");
  const verifiedServiceRole=Boolean(token && apiKey === token && (token === key || jwtRole(token) === "service_role"));
  if (!url || !key || !token || !verifiedServiceRole) return {ok:false,response:reply({error:"Forbidden"},403)};
  return {ok:true,client:createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}})};
}
function relation(value: unknown): Record<string, unknown> | null { if (record(value)) return value; return Array.isArray(value) && record(value[0]) ? value[0] : null; }
function bearer(request:Request){return request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]}
function jwtRole(token:string){try{const payload=token.split(".")[1];if(!payload)return null;const normalized=payload.replace(/-/g,"+").replace(/_/g,"/").padEnd(Math.ceil(payload.length/4)*4,"=");return JSON.parse(atob(normalized)).role??null}catch{return null}}
function reply(body:Record<string,unknown>,status:number){return new Response(JSON.stringify(body),{status,headers:{...CORS,"Content-Type":"application/json","Cache-Control":"no-store"}})}
function record(value:unknown):value is Record<string,unknown>{return typeof value==="object"&&value!==null&&!Array.isArray(value)}
function uuid(value:unknown):value is string{return typeof value==="string"&&UUID.test(value)}
function identifier(value:unknown):value is string{return typeof value==="string"&&/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value)}
function dateString(value:unknown):value is string{return typeof value==="string"&&!Number.isNaN(Date.parse(value))&&Date.parse(value)<=Date.now()+60000}
function nullableDate(value:unknown){return value===null||dateString(value)}
function number(value:unknown,min:number,max:number){return typeof value==="number"&&Number.isFinite(value)&&value>=min&&value<=max}
function nullableNumber(value:unknown,min:number,max:number){return value===null||number(value,min,max)}
function integer(value:unknown,min:number,max:number){return Number.isSafeInteger(value)&&Number(value)>=min&&Number(value)<=max}
