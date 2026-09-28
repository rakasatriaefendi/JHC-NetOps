import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Alerts uses approved auth and an authority-isolated local PostgreSQL read", () => {
  const page = source("../app/(protected)/alerts/page.tsx");
  const alerts = source("../lib/alerts.ts");
  const persistence = source("../lib/application-persistence.ts");
  const localBranch = alerts.slice(alerts.indexOf('if (applicationAuthority() === "local_postgres")'),
    alerts.indexOf("const { data, error } = await supabase"));

  assert.match(page, /requireApprovedProfile\(\)/);
  assert.match(page, /loadNetworkHealthAlerts\(supabase\)/);
  assert.doesNotMatch(page, /\.from\("events"\)/);
  assert.match(localBranch, /localOpenEvents\(500, "network_health"\)/);
  assert.doesNotMatch(localBranch, /supabase|\.from\(/);
  assert.match(persistence, /unresolved: "true"/);
  assert.match(alerts, /\.eq\("source", "network_health"\)/);
  assert.match(alerts, /\.is\("resolved_at", null\)/);
  assert.match(alerts, /\.order\("created_at", \{ ascending: false \}\)/);
});

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}
