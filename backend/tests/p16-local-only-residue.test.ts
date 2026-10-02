import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const activeSurfaces = [
  "frontend/app", "frontend/components", "frontend/lib", "frontend/package.json", "frontend/.env.example",
  "backend/src", "backend/package.json", "backend/.env.example",
  "runner/src", "runner/package.json", "runner/.env.example",
  "agent/network_monitoring_agent", "agent/.env.example",
  "hermes-agent/hermes_agent", "hermes-agent/package.json", "hermes-agent/.env.example",
  "deploy/build-frontend.sh", "deploy/run-backend.sh", "deploy/run-frontend.sh",
  "deploy/run-runner.sh", "deploy/ecosystem.config.cjs",
];
const forbidden = /(?:supabase\.co|@supabase\/|createClient|functions\/v1|SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY|NEXT_PUBLIC_SUPABASE_|PERSISTENCE_AUTHORITY=supabase|SupabaseShadowProjector)/;

test("active runtime, package, environment, and launcher surfaces contain no executable remote compatibility residue", () => {
  const offenders: string[] = [];
  for (const surface of activeSurfaces) {
    const absolute = join(root, surface);
    if (!existsSync(absolute)) continue;
    for (const file of files(absolute)) {
      if (file.includes(`${join("backend", "src", "cutover")}`) || file.includes(`${join("backend", "src", "data-migration")}`)) continue;
      if (forbidden.test(readFileSync(file, "utf8"))) offenders.push(file.slice(root.length + 1));
    }
  }
  assert.deepEqual(offenders, []);
});

test("historical application migrations 001 through 015 and remote migration evidence remain present", () => {
  const applicationMigrations = readdirSync(join(root, "backend/migrations"))
    .filter((name) => /^\d{3}_.*\.sql$/.test(name));
  for (let version = 1; version <= 15; version += 1) {
    assert.ok(applicationMigrations.some((name) => name.startsWith(String(version).padStart(3, "0") + "_")));
  }
  assert.ok(readdirSync(join(root, "supabase/migrations")).some((name) => name.endsWith(".sql")));
});

test("remote SDK packages, Edge runtime source, and deploy configuration are absent", () => {
  const frontendPackage = readFileSync(join(root, "frontend/package.json"), "utf8");
  const backendPackage = readFileSync(join(root, "backend/package.json"), "utf8");
  assert.doesNotMatch(frontendPackage, /@supabase\//);
  assert.doesNotMatch(backendPackage, /@supabase\//);
  assert.equal(existsSync(join(root, "supabase/functions")), false);
  assert.equal(existsSync(join(root, "supabase/config.toml")), false);
});

function files(path: string): string[] {
  if (statSync(path).isFile()) {
    return path.endsWith(".pyc") ? [] : [path];
  }

  return readdirSync(path).flatMap((name) => {
    if (["__pycache__", "node_modules", ".next", "dist"].includes(name)) return [];
    return files(join(path, name));
  });
}
