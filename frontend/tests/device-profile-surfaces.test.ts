import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("Discovery, Health, Traffic, and LAN hops launch the one reusable Device Profile", () => {
  const files = [
    source("../components/dashboard/network-discovery-drawer.tsx"),
    source("../components/dashboard/network-health-dashboard.tsx"),
    source("../components/traffic/traffic-live-page.tsx"),
    source("../components/dashboard/hop-latency-table.tsx"),
  ];
  for (const contents of files) {
    assert.match(contents, /useDeviceProfile/);
    assert.match(contents, /openDeviceProfile/);
  }
  assert.equal(source("../components/device-profile/device-profile-provider.tsx").match(/function DeviceProfileDrawer/g)?.length, 1);
});

test("Traffic and MTR launch saved profiles without auto-inspection", () => {
  const traffic = source("../components/traffic/traffic-live-page.tsx");
  const hops = source("../components/dashboard/hop-latency-table.tsx");
  assert.doesNotMatch(traffic, /openDeviceProfile\(\{[^}]*inspect:\s*true/);
  assert.doesNotMatch(hops, /openDeviceProfile\(\{[^}]*inspect:\s*true/);
});

test("Discovery is the only surface with an explicit inspect launch for an unknown authorized host", () => {
  const discovery = source("../components/dashboard/network-discovery-drawer.tsx");
  assert.match(discovery, /openDeviceProfile\(\{[^}]*inspect:\s*true/);
  assert.match(discovery, /!node/);
});
