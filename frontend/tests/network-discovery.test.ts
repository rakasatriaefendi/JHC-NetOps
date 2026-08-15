import assert from "node:assert/strict";
import test from "node:test";

import { observedTrafficIps } from "../lib/network-discovery.ts";

test("discovery correlates Traffic by IP without copying flow payloads", () => {
  const ips = observedTrafficIps([{
    flows: [
      { src_ip: "192.168.188.73", dst_ip: "192.168.188.219" },
      { src_ip: "192.168.188.73", dst_ip: "1.1.1.1" },
    ],
    top_talkers: [{ ip: "192.168.188.91" }],
  }]);
  assert.deepEqual(ips.sort(), ["1.1.1.1", "192.168.188.219", "192.168.188.73", "192.168.188.91"].sort());
});
