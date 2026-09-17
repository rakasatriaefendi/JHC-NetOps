import { createClient } from "@supabase/supabase-js";
import { canOperateNetwork } from "../_shared/authorization.ts";
import { legacyApplicationMutationBlocked, legacyApplicationMutationBlockedResponse } from "../_shared/persistence-authority.ts";

const CORS = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"GET, POST, OPTIONS"};
const DURATIONS = new Set([300, 600, 900, 1800]);
const RUNNER_FRESH_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, {status:204, headers:CORS});
  if (request.method === "GET") return readState(request);
  if (request.method !== "POST") return reply({error:"Method not allowed"}, 405);
  if (legacyApplicationMutationBlocked()) return legacyApplicationMutationBlockedResponse(CORS);
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return reply({error:"Invalid JSON"}, 400); }
  if (!record(body) || typeof body.action !== "string") return reply({error:"Structured action required"}, 400);
  if (body.action === "create_session" || body.action === "stop_session") return userAction(request, body);
  return runnerAction(request, body);
});

async function readState(request: Request) {
  const auth = await userAuth(request);
  if (!auth.ok) return auth.response;
  const {error:recoveryError} = await auth.service.rpc("expire_stale_traffic_sessions", {p_runner_id:null});
  if (recoveryError) return reply({error:"Traffic session recovery failed"}, 500);
  const [runners, sessions, snapshots, storage] = await Promise.all([
    auth.client.from("diagnostic_runners").select("id,display_name,last_seen_at,health_status,capabilities").order("display_name").limit(50),
    auth.client.from("traffic_live_sessions").select("*").order("created_at", {ascending:false}).limit(20),
    auth.client.from("traffic_live_snapshots").select("*").order("captured_at", {ascending:false}).limit(50),
    auth.service.rpc("traffic_storage_status"),
  ]);
  if (runners.error || sessions.error || snapshots.error) return reply({error:"Traffic state could not be loaded"}, 500);
  return reply({data:{runners:runners.data,sessions:sessions.data,snapshots:snapshots.data,
    storage_status:storage.data?.[0] ?? {storage_mb:0,status:"healthy"}, role:auth.role, server_time:new Date().toISOString()}}, 200);
}

async function userAction(request: Request, body: Record<string, unknown>) {
  const auth = await userAuth(request);
  if (!auth.ok) return auth.response;
  if (!canOperateNetwork(auth.role)) return reply({error:"Operator role required"}, 403);
  if (body.action === "stop_session") {
    if (!uuid(body.session_id)) return reply({error:"Invalid session"}, 400);
    const now = new Date().toISOString();
    const {data:cancelled,error:cancelError} = await auth.service.from("traffic_live_sessions")
      .update({status:"completed",stage:"complete",completed_at:now,updated_at:now})
      .eq("id", body.session_id).eq("status", "queued").select().maybeSingle();
    if (cancelError) return reply({error:"Stop request could not be stored"}, 500);
    if (cancelled) return reply({data:cancelled}, 200);
    const {data,error} = await auth.service.from("traffic_live_sessions")
      .update({status:"stopping",stage:"stopping",updated_at:now})
      .eq("id", body.session_id).eq("status", "running").select().maybeSingle();
    if (error) return reply({error:"Stop request could not be stored"}, 500);
    return data ? reply({data}, 200) : reply({error:"Active session not found"}, 409);
  }
  if (!identifier(body.runner_id) || !DURATIONS.has(Number(body.duration_seconds))) return reply({error:"Invalid runner or duration"}, 400);
  const {data:runner,error} = await auth.service.from("diagnostic_runners").select("id,last_seen_at,health_status,capabilities").eq("id",body.runner_id).maybeSingle();
  if (error || !runner) return reply({error:"Runner not found"}, 404);
  if (runner.health_status !== "online" || Date.now()-Date.parse(runner.last_seen_at)>RUNNER_FRESH_MS) return reply({error:"Runner offline",code:"RUNNER_OFFLINE"},409);
  const capabilities = record(runner.capabilities) ? runner.capabilities : {};
  if (!Array.isArray(capabilities.operations) || !capabilities.operations.includes("traffic_live") ||
      !Array.isArray(capabilities.traffic_durations_seconds) || !capabilities.traffic_durations_seconds.includes(body.duration_seconds)) return reply({error:"Traffic operation is not authorized by runner"},409);
  const {data:storage}=await auth.service.rpc("traffic_storage_status");
  if(storage?.[0]?.status==="critical") return reply({error:"Traffic storage safety limit reached",code:"STORAGE_CRITICAL"},409);
  const {count:diagCount} = await auth.service.from("diagnostic_jobs").select("id",{count:"exact",head:true}).eq("runner_id",body.runner_id).in("status",["queued","running"]);
  if ((diagCount ?? 0)>0) return reply({error:"Runner is busy with diagnostics",code:"RUNNER_BUSY"},409);
  const [{count:discoveryCount},{count:inspectionCount}] = await Promise.all([
    auth.service.from("network_discovery_sessions").select("session_id",{count:"exact",head:true}).eq("runner_id",body.runner_id).in("status",["queued","running"]),
    auth.service.from("device_inspection_sessions").select("inspection_id",{count:"exact",head:true}).eq("runner_id",body.runner_id).in("status",["queued","running"]),
  ]);
  if ((discoveryCount ?? 0)>0 || (inspectionCount ?? 0)>0) return reply({error:"Runner is busy with another active operation",code:"RUNNER_BUSY"},409);
  const {error:recoveryError} = await auth.service.rpc("expire_stale_traffic_sessions", {p_runner_id:body.runner_id});
  if (recoveryError) return reply({error:"Runner availability could not be checked"},500);
  const {data,error:insertError} = await auth.service.from("traffic_live_sessions").insert({runner_id:body.runner_id,requested_by:auth.userId,duration_seconds:body.duration_seconds}).select().single();
  if (insertError) return reply({error:"Runner already has an active Traffic session",code:"RUNNER_BUSY"},409);
  return reply({data},201);
}

async function runnerAction(request: Request, body: Record<string, unknown>) {
  const service = await serviceAuth(request);
  if (!service.ok) return service.response;
  const db = service.client;
  if (!identifier(body.runner_id)) return reply({error:"Invalid runner"},400);
  if (body.action === "claim_session") {
    const {error:recoveryError} = await db.rpc("expire_stale_traffic_sessions", {p_runner_id:body.runner_id});
    if (recoveryError) return reply({error:"Session recovery failed"},500);
    const {data:queued} = await db.from("traffic_live_sessions").select("*").eq("runner_id",body.runner_id).eq("status","queued").order("created_at").limit(1).maybeSingle();
    if (!queued) return reply({data:null},200);
    const now=new Date(), expires=new Date(now.getTime()+(queued.duration_seconds+60)*1000);
    const {data,error}=await db.from("traffic_live_sessions").update({status:"running",stage:"starting_wsl",started_at:now.toISOString(),expires_at:expires.toISOString(),updated_at:now.toISOString()}).eq("id",queued.id).eq("status","queued").select().maybeSingle();
    return error ? reply({error:"Session could not be claimed"},500) : reply({data},200);
  }
  if (!uuid(body.session_id)) return reply({error:"Invalid session"},400);
  if (body.action === "update_session") {
    if (!["starting_wsl","capturing"].includes(String(body.stage))) return reply({error:"Invalid stage"},400);
    const {data,error}=await db.from("traffic_live_sessions").update({stage:body.stage,updated_at:new Date().toISOString()}).eq("id",body.session_id).eq("runner_id",body.runner_id).eq("status","running").select().maybeSingle();
    return error ? reply({error:"Progress failed"},500) : reply({data},200);
  }
  if (body.action === "update_snapshot") return updateSnapshot(db, body);
  if (body.action === "persist_flow_batch") return persistFlows(db, body);
  if (body.action === "complete_session" || body.action === "fail_session") {
    const failed=body.action === "fail_session", now=new Date().toISOString();
    const {data,error}=await db.from("traffic_live_sessions").update({status:failed?"failed":"completed",stage:failed?"failed":"complete",
      error_code:failed?safeCode(body.error_code):null,error_message:failed?safeMessage(body.error_message):null,completed_at:now,updated_at:now})
      .eq("id",body.session_id).eq("runner_id",body.runner_id).in("status",["running","stopping"]).select().maybeSingle();
    return error ? reply({error:"Completion failed"},500) : reply({data},200);
  }
  return reply({error:"Unsupported action"},400);
}

async function updateSnapshot(db: ReturnType<typeof createClient>, body: Record<string, unknown>) {
  if (!record(body.snapshot)) return reply({error:"Invalid snapshot"},400);
  const snap=body.snapshot, flows=Array.isArray(snap.flows)?snap.flows:[], conversations=Array.isArray(snap.conversations)?snap.conversations:[], talkers=Array.isArray(snap.top_talkers)?snap.top_talkers:[];
  if (flows.length>100 || conversations.length>30 || talkers.length>10 || !record(snap.summary) || !dateString(snap.captured_at)) return reply({error:"Snapshot exceeds bounds"},413);
  if (!flows.every(validFlow)) return reply({error:"Snapshot flow is invalid"},400);
  const payloadBytes=new TextEncoder().encode(JSON.stringify(snap)).length;
  if (payloadBytes>65536) return reply({error:"Snapshot exceeds 64 KiB"},413);
  const {data:session}=await db.from("traffic_live_sessions").update({updated_at:new Date().toISOString()})
    .eq("id",body.session_id).eq("runner_id",body.runner_id).in("status",["running","stopping"]).select("status").maybeSingle();
  if (!session || !["running","stopping"].includes(session.status)) return reply({error:"Session is not active"},409);
  const {error}=await db.from("traffic_live_snapshots").upsert({runner_id:body.runner_id,session_id:body.session_id,captured_at:snap.captured_at,summary:snap.summary,flows,conversations,top_talkers:talkers,payload_bytes:payloadBytes,updated_at:new Date().toISOString()},{onConflict:"runner_id"});
  if (error) return reply({error:"Snapshot could not be stored"},500);
  const {data:storage}=await db.rpc("traffic_storage_status");
  return reply({data:{stop_requested:session.status==="stopping",storage_status:storage?.[0]??null}},200);
}

async function persistFlows(db: ReturnType<typeof createClient>, body: Record<string, unknown>) {
  if (!Array.isArray(body.flows) || body.flows.length<1 || body.flows.length>100 || JSON.stringify(body).length>131072 || !body.flows.every(validFlow)) return reply({error:"Flow batch is invalid"},400);
  const {data:session}=await db.from("traffic_live_sessions").select("id").eq("id",body.session_id).eq("runner_id",body.runner_id).in("status",["running","stopping"]).maybeSingle();
  if (!session) return reply({error:"Session is not active"},409);
  const {data:storage}=await db.rpc("traffic_storage_status");
  if (storage?.[0]?.status==="critical") return reply({data:{persisted:0,storage_status:storage[0]}},200);
  const accepted=storage?.[0]?.status==="warning"?body.flows.slice(0,25):body.flows;
  const rows=accepted.map((flow: Record<string,unknown>)=>({runner_id:body.runner_id,session_id:body.session_id,flow_key:flow.flow_key,
    first_seen:flow.first_seen,last_seen:flow.last_seen,src_ip:flow.src_ip,dst_ip:flow.dst_ip,src_port:flow.src_port,dst_port:flow.dst_port,
    protocol:flow.protocol,total_bytes:flow.total_bytes,packet_count:flow.packet_count,peak_rate_mbps:flow.peak_rate_mbps}));
  const {error}=await db.from("flows").upsert(rows,{onConflict:"session_id,flow_key"});
  return error ? reply({error:"Flow batch could not be stored"},500) : reply({data:{persisted:rows.length,storage_status:storage?.[0]??null}},200);
}

function validFlow(value: unknown): value is Record<string,unknown> {
  if (!record(value) || typeof value.flow_key!=="string" || !/^[0-9a-f]{64}$/.test(value.flow_key) || !ip(value.src_ip) || !ip(value.dst_ip)) return false;
  if (!["tcp","udp","icmp"].includes(String(value.protocol)) || !port(value.src_port) || !port(value.dst_port)) return false;
  if (value.protocol==="icmp" && (value.src_port!==null || value.dst_port!==null)) return false;
  return nonNegative(value.total_bytes) && nonNegative(value.packet_count) && nonNegative(value.peak_rate_mbps) && dateString(value.first_seen) && dateString(value.last_seen);
}

async function userAuth(request: Request): Promise<any> {
  const url=Deno.env.get("SUPABASE_URL"), anon=Deno.env.get("SUPABASE_ANON_KEY"), key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), token=bearer(request);
  if (!url||!anon||!key||!token) return {ok:false,response:reply({error:"Unauthorized"},401)};
  const client=createClient(url,anon,{auth:{persistSession:false,autoRefreshToken:false},global:{headers:{Authorization:`Bearer ${token}`}}});
  const {data:user}=await client.auth.getUser(token); if(!user.user)return {ok:false,response:reply({error:"Unauthorized"},401)};
  const {data:profile}=await client.from("profiles").select("status,role").eq("id",user.user.id).maybeSingle();
  if(profile?.status!=="approved")return {ok:false,response:reply({error:"Forbidden"},403)};
  return {ok:true,client,service:createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}}),userId:user.user.id,role:profile.role};
}
async function serviceAuth(request: Request): Promise<any> {
  const url=Deno.env.get("SUPABASE_URL"), anon=Deno.env.get("SUPABASE_ANON_KEY"), key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), token=bearer(request);
  if(!url||!anon||!key||!token)return {ok:false,response:reply({error:"Forbidden"},403)};
  const verifier=createClient(url,anon,{auth:{persistSession:false,autoRefreshToken:false},global:{headers:{Authorization:`Bearer ${token}`}}});
  const {error}=await verifier.rpc("traffic_storage_status");
  if(error)return {ok:false,response:reply({error:"Forbidden"},403)};
  return {ok:true,client:createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}})};
}
function bearer(r:Request){return r.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]}
function reply(body:Record<string,unknown>,status:number){return new Response(JSON.stringify(body),{status,headers:{...CORS,"Content-Type":"application/json","Cache-Control":"no-store"}})}
function record(v:unknown):v is Record<string,unknown>{return typeof v==="object"&&v!==null&&!Array.isArray(v)}
function uuid(v:unknown):v is string{return typeof v==="string"&&UUID.test(v)}
function identifier(v:unknown):v is string{return typeof v==="string"&&/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(v)}
function dateString(v:unknown):v is string{return typeof v==="string"&&!Number.isNaN(Date.parse(v))}
function nonNegative(v:unknown){return typeof v==="number"&&Number.isFinite(v)&&v>=0}
function port(v:unknown){return v===null||(Number.isInteger(v)&&Number(v)>=1&&Number(v)<=65535)}
function ip(v:unknown){return typeof v==="string"&&v.length<=45&&/^[0-9a-f:.]+$/i.test(v)}
function safeCode(v:unknown){return typeof v==="string"&&/^[A-Z0-9_]{1,64}$/.test(v)?v:"TRAFFIC_CAPTURE_FAILED"}
function safeMessage(v:unknown){return typeof v==="string"&&v.length<=300&&!/[\r\n]/.test(v)?v:"Traffic capture failed"}
