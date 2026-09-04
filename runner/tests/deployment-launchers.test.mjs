import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const rootUrl = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, rootUrl), "utf8");

test("runner launcher is a foreground, fail-fast, process-manager-neutral entrypoint", () => {
  const script = read("deploy/run-runner.sh");
  assert.match(script, /^#!\/usr\/bin\/env bash\r?\nset -Eeuo pipefail/m);
  assert.match(script, /NODE_BIN="\/home\/mini-pc\/\.nvm\/versions\/node\/v22\.23\.2\/bin\/node"/);
  assert.match(script, /PROJECT_ROOT="\/var\/www\/jhc\/jhc_noc\/current"/);
  assert.match(script, /RUNNER_ENV="\/var\/www\/jhc\/jhc_noc\/shared\/runner\/\.env"/);
  assert.match(script, /RUNNER_CONFIG="\/var\/www\/jhc\/jhc_noc\/shared\/runner\/config\.json"/);
  assert.match(script, /\. "\$RUNNER_ENV"/);
  assert.match(script, /exec "\$NODE_BIN" "\$RUNNER_MAIN" --config "\$RUNNER_CONFIG"/);
  assert.doesNotMatch(script, /nohup|pm2|sudo|systemctl|daemon|pid file|&\s*$/im);
  assert.doesNotMatch(script, /eyJ|community|auth_password|priv_password/i);
  assert.doesNotMatch(script, /SUPABASE_(?:URL|SERVICE_ROLE_KEY)=['"][^$]/);
});

test("frontend build launcher resolves the release containing itself and validates build-time public variables", () => {
  const script = read("deploy/build-frontend.sh");
  assert.match(script, /^#!\/usr\/bin\/env bash\r?\nset -Eeuo pipefail/m);
  assert.match(script, /BASH_SOURCE\[0\]/);
  assert.match(script, /RELEASE_ROOT="\$\(cd -- "\$\{SCRIPT_DIR\}\/\.\." && pwd -P\)"/);
  assert.match(script, /FRONTEND_ENV="\/var\/www\/jhc\/jhc_noc\/shared\/frontend\/\.env"/);
  assert.match(script, /NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY NEXT_PUBLIC_SITE_URL/);
  assert.match(script, /NPM_BIN="\$\{NODE_DIR\}\/npm"/);
  assert.match(script, /"\$NPM_BIN" run build/);
  assert.doesNotMatch(script, /\/var\/www\/jhc\/jhc_noc\/current|sudo|systemctl|pm2|ln\s+-s|service_role/i);
});

test("deployment launchers have valid Bash syntax on a native Linux test host", { skip: process.platform !== "linux" }, () => {
  for (const relativePath of ["deploy/run-runner.sh", "deploy/build-frontend.sh"]) {
    const filePath = new URL(relativePath, rootUrl);
    const result = spawnSync("/usr/bin/bash", ["-n", filePath.pathname], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
});
