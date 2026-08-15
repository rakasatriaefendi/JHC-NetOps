import { createClient } from "@supabase/supabase-js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUS = new Set(["online", "degraded", "offline"]);

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, {status:204, headers:CORS});
  if (request.method !== "POST") return reply({error:"Method not allowed"}, 405);
  const service = serviceClient(request);
  if (!service.ok) return service.response;
  let body: Record<string, unknown>;
  try { body = await request.json(); }
  catch { return reply({error:"Invalid JSON"}, 400); }
  if (!record(body) || !identifier(body.runner_id)) return reply({error:"Structured runner action required"}, 400);
  if (body.action === "list_targets") return listTargets(service.client, body.runner_id);
  if (body.action === "publish") return publish(service.client, body);
  return reply({error:"Unsupported action"}, 400);
});

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
