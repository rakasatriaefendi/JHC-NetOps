import assert from "node:assert/strict";
import test from "node:test";
import {filterFlows,type TrafficFlow} from "../lib/traffic.ts";

const flow:TrafficFlow={flow_key:"a",src_ip:"10.0.0.1",dst_ip:"10.0.0.2",src_port:1200,dst_port:443,protocol:"tcp",service:"HTTPS (inferred)",first_seen:"2026-01-01T00:00:00Z",last_seen:"2026-01-01T00:00:01Z",total_bytes:10,packet_count:1,bytes_delta:10,packets_delta:1,packets_per_second:0.5,rate_mbps:1,peak_rate_mbps:1,rate_trend:"increasing",status:"active"};
test("flow filters combine search, protocol, and status",()=>{assert.equal(filterFlows([flow],"443","tcp","active").length,1);assert.equal(filterFlows([flow],"53","tcp","active").length,0);assert.equal(filterFlows([flow],"","udp","all").length,0)});
