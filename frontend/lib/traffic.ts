import type { SupabaseClient } from "@supabase/supabase-js";
import type { DiagnosticRunner } from "@/lib/diagnostic-jobs";

export type TrafficFlow = { flow_key:string; src_ip:string; dst_ip:string; src_port:number|null; dst_port:number|null; protocol:"tcp"|"udp"|"icmp"; service:string|null; first_seen:string; last_seen:string; total_bytes:number; packet_count:number; bytes_delta:number; packets_delta:number; packets_per_second:number; rate_mbps:number; peak_rate_mbps:number; rate_trend:"increasing"|"decreasing"|"stable"; status:"active"|"idle" };
export type Conversation = { endpoint_a:string; endpoint_b:string; a_to_b_bytes:number; b_to_a_bytes:number; total_bytes:number; rate_mbps:number; active_flows:number; first_seen:string; last_seen:string; protocol:string; service:string|null };
export type TopTalker = { ip:string; rate_mbps:number; total_bytes:number; active_flows:number };
export type TrafficSummary = { observed_tx_mbps:number; observed_rx_mbps:number; packets_observed:number; packets_per_second:number; active_flows:number; dominant_protocol:string|null };
export type TrafficSnapshot = { runner_id:string; session_id:string; captured_at:string; summary:TrafficSummary; flows:TrafficFlow[]; conversations:Conversation[]; top_talkers:TopTalker[]; payload_bytes:number; updated_at:string };
export type TrafficSession = { id:string; runner_id:string; requested_by:string; status:"queued"|"running"|"stopping"|"completed"|"failed"|"expired"; duration_seconds:number; capture_scope:"this_device"; stage:string; error_code:string|null; error_message:string|null; created_at:string; started_at:string|null; expires_at:string|null; completed_at:string|null; updated_at:string };
export type StorageStatus = { storage_mb:number|string; status:"healthy"|"warning"|"critical" };
export type TrafficState = { runners:DiagnosticRunner[]; sessions:TrafficSession[]; snapshots:TrafficSnapshot[]; storage_status:StorageStatus; role:"admin"|"viewer"; server_time:string };

export const emptyTrafficState = (role:"admin"|"viewer"="viewer"):TrafficState => ({runners:[],sessions:[],snapshots:[],storage_status:{storage_mb:0,status:"healthy"},role,server_time:new Date().toISOString()});

export async function loadTrafficState(supabase:SupabaseClient, role:"admin"|"viewer") {
  const {data,error}=await supabase.functions.invoke<{data:TrafficState}>("traffic-live",{method:"GET"});
  return error||!data?.data ? {data:emptyTrafficState(role),error:true} : {data:data.data,error:false};
}

export function filterFlows(flows:TrafficFlow[], search:string, protocol:string, status:string) {
  const needle=search.trim().toLowerCase();
  return flows.filter((flow)=>(protocol==="all"||flow.protocol===protocol)&&(status==="all"||flow.status===status)&&(!needle||[flow.src_ip,flow.dst_ip,String(flow.src_port??""),String(flow.dst_port??""),flow.service??""].some((v)=>v.toLowerCase().includes(needle))));
}
